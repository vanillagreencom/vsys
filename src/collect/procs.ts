import {
  lstatSync,
  readdirSync,
  readFileSync,
  type Stats,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config/config";
import { classify, excludedArgv } from "../model/roles";
import { scopeMain } from "../model/scopes";
import type { Group, Proc } from "../model/types";
import { buildKind, toolName } from "./builds";
import type { Reader } from "./io";

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
  const result = {
    pid: Number(raw.slice(0, open).trim()),
    comm: raw.slice(open + 1, close),
    state: fields[0],
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
    Object.values(result).some(
      (v) => typeof v === "number" && !Number.isFinite(v),
    )
  )
    throw new Error("Invalid /proc stat");
  return result;
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

/** Identity-keyed environment caching prevents reuse of a former process's metadata. */
export class ProcessCollector {
  private env = new Map<
    number,
    { start: number; values: Record<string, string> }
  >();
  constructor(
    private ticksPerSecond: number,
    private pageSize: number,
  ) {}
  async collect(
    r: Reader,
    c: Config,
    groups: Group[],
    previous: Proc[],
    elapsedMs: number,
    uptime: number,
    signal?: AbortSignal,
  ): Promise<Proc[]> {
    const before = new Map(previous.map((p) => [p.pid, p]));
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
    const result: Proc[] = [];
    const ids = r.dirs(c.procRoot).filter((n) => /^\d+$/.test(n));
    // Bound open files while Bun reads independent process files in parallel.
    for (let offset = 0; offset < ids.length; offset += 64) {
      signal?.throwIfAborted();
      const batch = await Promise.all(
        ids.slice(offset, offset + 64).map(async (id) => {
          const root = join(c.procRoot, id);
          try {
            const [stat, command] = await Promise.all([
              Bun.file(`${root}/stat`).text(),
              Bun.file(`${root}/cmdline`).text(),
            ]);
            return { id, stat, command };
          } catch (error) {
            return { id, error };
          }
        }),
      );
      signal?.throwIfAborted();
      for (const row of batch) {
        const id = row.id;
        const root = join(c.procRoot, id);
        try {
          if ("error" in row) throw row.error;
          const stat = parseStat(row.stat);
          identities.add(stat.pid);
          const rawCommand = row.command;
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
          const tool = helper
            ? null
            : toolName(stat.comm, command, c.agentTools);
          // Kernel threads and zombies have no userspace executable or cwd.
          const cwd = command.length ? r.link(`${root}/cwd`) : null;
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
            tool,
            build: helper ? null : buildKind(stat.comm, command),
            role: "other",
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
            !["ENOENT", "ESRCH"].includes(
              (e as NodeJS.ErrnoException).code ?? "",
            )
          )
            r.error(root, e);
        }
      }
    }
    const byPid = new Map(result.map((p) => [p.pid, p]));
    const mainPids = new Set(
      groups.flatMap((g) => {
        const p = scopeMain(g.pids, byPid);
        return p ? [p.pid] : [];
      }),
    );
    for (const p of result) p.role = classify(p, mainPids.has(p.pid), c);
    const allowed = new Set([
      "CLAUDE_CONFIG_DIR",
      "PATH",
      "TMPDIR",
      "CLAUDE_CODE_TMPDIR",
      "CARGO_BUILD_JOBS",
      "RUST_TEST_THREADS",
      "SHELL",
      c.laneEnv,
      ...c.capMarkers,
    ]);
    // An escaped agent is a child of the pane's shell, so its own launch
    // environment is what the trail needs, not the scope main's.
    const envPids = new Set([
      ...mainPids,
      ...result.filter((p) => p.tool).map((p) => p.pid),
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
        p.executable = r.link(join(c.procRoot, String(pid), "exe"));
    }
    for (const key of this.env.keys())
      if (!identities.has(key)) this.env.delete(key);
    return result;
  }
}

/** Open descriptors are read only on demand for the selected lane. */
export function scratchFiles(
  r: Reader,
  c: Config,
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
