import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type AgentToolsDocument,
  shippedAgentTools,
} from "../config/agent-tools";
import { scopeMain } from "../model/scopes";
import type { Group, Proc, SourceError } from "../model/types";
import {
  buildKind,
  excludedArgv,
  type ToolSignals,
  toolName,
  toolSignals,
} from "./builds";
import { Reader } from "./io";
import type { CollectionConfig } from "./settings";

/**
 * The environment names an agent's temporary directory is read from. Storage
 * measures those directories as scratch, and reads them from the reading this
 * collector already takes.
 */
export const scratchEnv = ["TMPDIR", "CLAUDE_CODE_TMPDIR"] as const;
/**
 * Whether a source error left a process out of the reading. `read` records a
 * process's own directory when it could not read that process, and the process
 * root when it could not list them; every other process error leaves the
 * process in the reading with a field unknown.
 */
export function omittedProcess(source: string, procRoot: string): boolean {
  // Sources are built with join, which drops the trailing slash a configured
  // root may carry.
  const root = resolve(procRoot);
  return (
    source === root ||
    (dirname(source) === root && /^\d+$/.test(basename(source)))
  );
}
/** stat's command can contain spaces and closing parentheses. */
export function parseStat(
  raw: string,
): Pick<
  Proc,
  "pid" | "ppid" | "start" | "comm" | "state" | "threads" | "ticks"
> & { rssPages: number } {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  const fields = raw.slice(close + 2).split(/\s+/, 22);
  const [state] = fields;
  const result = {
    pid: Number(raw.slice(0, open).trim()),
    comm: raw.slice(open + 1, close),
    ppid: Number(fields[1]),
    ticks: Number(fields[11]) + Number(fields[12]),
    threads: Number(fields[17]),
    start: Number(fields[19]),
    rssPages: Number(fields[21]),
  };
  if (
    open < 0 ||
    close < open ||
    fields.length < 22 ||
    state === undefined ||
    Object.values(result).some(
      (v) => typeof v === "number" && !Number.isFinite(v),
    )
  )
    throw new Error("Invalid /proc stat");
  return { ...result, state };
}

function branchAt(cwd: string): string | null {
  let path = cwd;
  while (true) {
    let git = join(path, ".git");
    let marker: Stats | undefined;
    try {
      marker = lstatSync(git);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (marker) {
      if (marker.isSymbolicLink()) marker = statSync(git);
      if (marker.isFile()) {
        const pointer = readFileSync(git, "utf8").trim();
        if (!pointer.startsWith("gitdir: ") || !pointer.slice(8))
          throw new Error(`Invalid gitdir at ${git}`);
        const target = pointer.slice(8);
        git = isAbsolute(target) ? target : resolve(path, target);
      } else if (!marker.isDirectory())
        throw new Error(`Invalid Git marker: ${git}`);
      const head = readFileSync(join(git, "HEAD"), "utf8").trim();
      if (head.startsWith("ref: refs/heads/") && head.length > 16)
        return head.slice(16);
      if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head))
        return head.slice(0, 12);
      throw new Error(`Invalid Git HEAD: ${git}`);
    }
    const parent = dirname(path);
    if (path === parent) return null;
    path = parent;
  }
}

/** What process collection takes from the rest of one sample. */
export interface ProcessRequest {
  /** The sample's time in milliseconds, which tick deltas are divided over. */
  time: number;
  /** System uptime in seconds, which process ages are measured against. */
  uptime: number;
  /** Watched membership decides cgroup paths, swap reads and scope mains. */
  groups: Pick<Group, "pids" | "kernelPath">[];
}
/** The processes one sample read, and the sources it could not read. */
export interface ProcessReading {
  procs: Proc[];
  errors: SourceError[];
}
/**
 * Where process collection runs. The program runs it on a thread of its own;
 * a collector given none reads in its caller's thread. Either way one request
 * is in flight at a time, because the collector awaits each sample.
 */
export interface ProcessSource {
  collect(
    request: ProcessRequest,
    signal: AbortSignal,
  ): Promise<ProcessReading>;
  close(): void;
}

/**
 * Identity-keyed environment caching prevents reuse of a former process's
 * metadata. Counters are compared against the last reading this collector
 * took, so its owner keeps one collector for the life of its collection
 * settings.
 */
export class ProcessCollector implements ProcessSource {
  private env = new Map<
    number,
    { start: number; values: Record<string, string> }
  >();
  private previous?: {
    time: number;
    counters: Map<number, { start: number; ticks: number }>;
  };
  private signals: ToolSignals;
  constructor(
    private c: CollectionConfig,
    private ticksPerSecond: number,
    private pageSize: number,
    /**
     * The program hands over the shipped agent-tool data with the machine
     * overlay merged in; a collector built any other way reads the shipped
     * data, so no test reads the host's overlay.
     */
    tools: AgentToolsDocument = shippedAgentTools,
  ) {
    this.signals = toolSignals(tools);
  }
  async collect(
    request: ProcessRequest,
    signal: AbortSignal,
  ): Promise<ProcessReading> {
    signal.throwIfAborted();
    return this.read(request);
  }
  close(): void {}
  // REVISIT(D008): asynchronous reads would return if they cost less processor time.
  /**
   * One pass over the process table. Each file is read synchronously, one
   * after another: one asynchronous request per file costs more processor
   * time than the read itself. The program runs this on a thread of its own
   * (`ProcessThread`), so blocking that thread holds up no keystroke.
   */
  read({ time, uptime, groups }: ProcessRequest): ProcessReading {
    const r = new Reader();
    const c = this.c;
    const before =
      this.previous?.counters ??
      new Map<number, { start: number; ticks: number }>();
    const elapsedMs = this.previous ? time - this.previous.time : 0;
    const groupMembers = new Set(groups.flatMap((g) => g.pids));
    const membership = new Map<number, string | null>();
    for (const g of groups) {
      const path = g.kernelPath;
      if (path === undefined) continue;
      for (const pid of g.pids)
        membership.set(
          pid,
          membership.has(pid) && membership.get(pid) !== path ? null : path,
        );
    }
    const branches = new Map<string, string | null>();
    const identities = new Set<number>();
    // Executables already read, so the launch chain below reads none twice.
    const executables = new Map<number, string | null>();
    const result: Proc[] = [];
    for (const id of r.dirs(c.procRoot).filter((n) => /^\d+$/.test(n))) {
      const root = join(c.procRoot, id);
      try {
        const stat = parseStat(readFileSync(`${root}/stat`, "utf8"));
        identities.add(stat.pid);
        const rawCommand = readFileSync(`${root}/cmdline`, "utf8");
        const command = rawCommand.length
          ? rawCommand.replace(/\0$/, "").split("\0")
          : [];
        const group =
          membership.get(stat.pid) ??
          readFileSync(`${root}/cgroup`, "utf8")
            .split("\n")
            .find((s) => s.startsWith("0::"))
            ?.slice(3);
        if (group === undefined)
          throw new Error("cgroup v2 membership missing");
        const helper = excludedArgv(command, c.excludeArgv);
        // Kernel threads and zombies have no userspace executable or cwd.
        const cwd = command.length ? r.link(`${root}/cwd`) : null;
        const executable = () => {
          if (!executables.has(stat.pid))
            executables.set(stat.pid, r.link(`${root}/exe`));
          return executables.get(stat.pid) ?? null;
        };
        const match =
          helper || !command.length
            ? null
            : toolName(stat.comm, command, c.agentTools, this.signals, {
                executable,
                script: (argument) => scriptPath(r, argument, cwd),
              });
        const candidate = before.get(stat.pid);
        const old = candidate?.start === stat.start ? candidate : undefined;
        // Watched lanes use the cgroup's aggregate swap counter.
        const status = groupMembers.has(stat.pid)
          ? null
          : r.text(`${root}/status`, true);
        const swap = status?.match(/^VmSwap:\s+(\d+) kB$/m);
        result.push({
          pid: stat.pid,
          ppid: stat.ppid,
          start: stat.start,
          comm: stat.comm,
          state: stat.state,
          threads: stat.threads,
          ticks: stat.ticks,
          rss: Math.max(0, stat.rssPages * this.pageSize),
          command,
          group,
          tool: match?.kind === "agent" ? match.name : null,
          unconfirmedTool: match?.kind === "unconfirmed" ? match.name : null,
          build: helper
            ? null
            : buildKind(stat.comm, command, c.compilerNames, c.linkerNames),
          cwd,
          executable: null,
          branch: null,
          env: {},
          envAvailable: false,
          swap: swap ? Number(swap[1]) * 1024 : null,
          cpuPercent:
            old && elapsedMs > 0 && stat.ticks >= old.ticks
              ? ((stat.ticks - old.ticks) * 100000) /
                (this.ticksPerSecond * elapsedMs)
              : null,
          age: Math.max(0, uptime - stat.start / this.ticksPerSecond),
        });
      } catch (e) {
        if (
          !["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")
        )
          r.error(root, e);
      }
    }
    const byPid = new Map(result.map((p) => [p.pid, p]));
    const mainPids = new Set(
      groups.flatMap((g) => {
        const p = scopeMain(g.pids, byPid);
        return p ? [p.pid] : [];
      }),
    );
    const allowed = new Set([
      "CLAUDE_CONFIG_DIR",
      "PATH",
      ...scratchEnv,
      "CARGO_BUILD_JOBS",
      "RUST_TEST_THREADS",
      "SHELL",
      "RUSTC_WRAPPER",
      // Which tmux server the pane belongs to. Read here because this file
      // is already parsed whole and filtered by this list, so one more name
      // costs no read.
      "TMUX",
      // The handle tmux exported into the pane. Read here because the own-pane
      // mark compares it against vsys's own handle, and paneEnv is a reader's
      // to narrow.
      "TMUX_PANE",
      c.laneEnv,
      ...c.capMarkers,
      ...c.jobserverEnv,
      ...c.accountEnv,
      ...c.paneEnv,
      ...c.titleEnv,
    ]);
    // An escaped agent is a child of the pane's shell and a build process
    // carries its own compiler wrapper and make token pool, so each reads its
    // own launch environment rather than the scope main's.
    const envPids = new Set([
      ...mainPids,
      ...result.filter((p) => p.tool || p.build).map((p) => p.pid),
    ]);
    for (const pid of envPids) {
      const p = byPid.get(pid);
      if (!p) throw new Error("Selected process is missing");
      const cached = this.env.get(pid);
      if (cached?.start === p.start) {
        p.env = cached.values;
        p.envAvailable = true;
      } else {
        const path = join(c.procRoot, String(pid), "environ");
        try {
          for (const entry of readFileSync(path, "utf8").split("\0")) {
            const split = entry.indexOf("=");
            const name = entry.slice(0, split);
            if (split >= 0 && allowed.has(name))
              p.env[name] = entry.slice(split + 1);
          }
          this.env.set(pid, { start: p.start, values: p.env });
          p.envAvailable = true;
        } catch (e) {
          if (
            !["ENOENT", "ESRCH"].includes(
              (e as NodeJS.ErrnoException).code ?? "",
            )
          )
            r.error(path, e);
        }
      }
      if (p.cwd) {
        try {
          if (!branches.has(p.cwd)) branches.set(p.cwd, branchAt(p.cwd));
          p.branch = branches.get(p.cwd) ?? null;
        } catch (e) {
          r.error(`${p.cwd}/.git`, e);
        }
      }
    }
    const launchChain = new Set<number>();
    for (const p of result.filter((p) => p.tool || mainPids.has(p.pid))) {
      let current: Proc | undefined = p;
      while (current && !launchChain.has(current.pid)) {
        launchChain.add(current.pid);
        current = byPid.get(current.ppid);
      }
    }
    for (const pid of launchChain) {
      const p = byPid.get(pid);
      if (p?.command.length)
        p.executable = executables.has(pid)
          ? (executables.get(pid) ?? null)
          : r.link(join(c.procRoot, String(pid), "exe"));
    }
    for (const key of this.env.keys())
      if (!identities.has(key)) this.env.delete(key);
    this.previous = {
      time,
      counters: new Map(
        result.map((p) => [p.pid, { start: p.start, ticks: p.ticks }]),
      ),
    };
    return { procs: result, errors: r.errors };
  }
}

/**
 * A script argument with its symbolic links resolved: a launcher on PATH is
 * often a link into the package that holds the script. A relative argument
 * is resolved against the process's working directory. A path that does not
 * exist resolves to itself, and one that could not be read, or whose working
 * directory is unknown, to `null`.
 */
function scriptPath(
  r: Reader,
  argument: string,
  cwd: string | null,
): string | null {
  const path = isAbsolute(argument)
    ? argument
    : cwd === null
      ? null
      : join(cwd, argument);
  if (path === null) return null;
  try {
    return realpathSync(path);
  } catch (e) {
    if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? ""))
      return path;
    r.error(path, e);
    return null;
  }
}

/** Open descriptors are read only on demand for the selected lane. */
export function scratchFiles(
  r: Reader,
  c: CollectionConfig,
  pids: number[],
): { pid: number; path: string }[] {
  const result: { pid: number; path: string }[] = [];
  for (const pid of pids) {
    const root = join(c.procRoot, String(pid), "fd");
    try {
      for (const fd of readdirSync(root)) {
        const target = r.link(join(root, fd));
        if (
          target &&
          c.scratchDirs.some(
            (dir) => target === dir || target.startsWith(`${dir}/`),
          )
        )
          result.push({ pid, path: target });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") r.error(root, e);
    }
  }
  return result;
}
