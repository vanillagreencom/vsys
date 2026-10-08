import { basename } from "node:path";
import type { CollectionConfig } from "../collect/settings";
import {
  isPaneId,
  type PaneAddress,
  type PaneSet,
  targetPanes,
} from "../collect/tmux";
import {
  accountName,
  firstEnv,
  jobserver,
  laneName,
  paneName,
  paneSocket,
  unitLabel,
  windowTitle,
} from "./naming";
import { scopeMain } from "./scopes";
import type { Capability, Group, Lane, Proc, ProcessRead } from "./types";

/**
 * Whether a lane held no member read on its sample. A lane takes its main
 * process from its members, so a main PID of 0 is exactly that lane and names
 * no process. A build older than the unknown memory and age also stored both
 * for it as a synthetic 0, so every reader of a stored lane's memory or age
 * asks this, and so does the export before it writes the main PID.
 */
export const memberless = (mainPid: unknown): boolean => mainPid === 0;
export function inSlice(path: string, slice: string): boolean {
  return path.split("/").includes(slice);
}
/**
 * Whether agents are compared against the agent slice. Only a probe that found
 * the slice absent or masked stops the comparison, since systemd never starts
 * either: a slice vsys could not read, and a sample recorded before the probe
 * existed, keep it, so a failed read never silences an escaped agent.
 */
export function sliceCompared(capabilities: Capability[]): boolean {
  const failure = capabilities.find((cap) => cap.id === "agent-slice")?.failure;
  return failure !== "absent" && failure !== "masked";
}
/**
 * One rule for an escaped agent: a configured tool outside the agent slice, on
 * a machine that has one. Where there is no slice, no agent is outside it.
 */
export function escaped(
  p: Proc,
  c: CollectionConfig,
  capabilities: Capability[],
): boolean {
  return (
    p.tool !== null &&
    sliceCompared(capabilities) &&
    !inSlice(p.group, c.agentSlice)
  );
}
/** An ancestor cgroup cap also limits a lane. */
export function dangerousCap(
  group: Group,
  groups: Group[],
  floor: number,
): boolean {
  return groups.some(
    (g) =>
      (g.path === "." ||
        g.path === group.path ||
        group.path.startsWith(`${g.path}/`)) &&
      g.max !== null &&
      g.max < floor,
  );
}
/**
 * The tightest memory.max on the group itself or on any of its ancestors. An
 * unlimited cap and an unread cgroup tree are different answers, so the caller
 * never reports a lane as unlimited on data it could not read.
 */
export function effectiveMax(
  groups: Group[],
  path: string,
): { max: number | null; known: boolean } {
  const covering = groups.filter(
    (g) => g.path === "." || g.path === path || path.startsWith(`${g.path}/`),
  );
  const limits = covering.flatMap((g) => (g.max === null ? [] : [g.max]));
  return {
    max: limits.length ? Math.min(...limits) : null,
    known: covering.length > 0 && covering.every((g) => g.maxRead),
  };
}
/**
 * The configured group covering a process's absolute kernel cgroup path: the
 * one whose `kernelPath` equals it, or is its nearest ancestor. `effectiveMax`
 * only matches root-relative paths, so a group-less lane — whose cgroup is
 * that absolute kernel path, not one of vsys's own group paths — has to
 * resolve to a group here first. None found, root included, means the
 * process sits outside the configured root.
 */
export function coveringGroup(
  groups: Group[],
  kernelPath: string,
): Group | null {
  let best: Group | null = null;
  let bestKernelPath = "";
  for (const g of groups) {
    const groupKernelPath = g.kernelPath;
    if (groupKernelPath === undefined) continue;
    // "/" is the mount root: every real kernel path already starts with it,
    // so "/" plus a separator would build "//", which none of them start
    // with, and the plain equality check never matches a deeper path either.
    const covers =
      groupKernelPath === kernelPath ||
      (groupKernelPath === "/"
        ? kernelPath.startsWith("/")
        : kernelPath.startsWith(`${groupKernelPath}/`));
    if (!covers) continue;
    if (best === null || groupKernelPath.length > bestKernelPath.length) {
      best = g;
      bestKernelPath = groupKernelPath;
    }
  }
  return best;
}
/**
 * A blocked lane waits on storage or on memory reclaim. The resource with the
 * higher stall share is the one to name; unknown pressure names neither.
 */
export function blockedOn(
  io: number | null,
  memory: number | null,
): "io" | "memory" | null {
  if ((io ?? 0) <= 0 && (memory ?? 0) <= 0) return null;
  return (io ?? 0) >= (memory ?? 0) ? "io" : "memory";
}
/**
 * Whether a lane's pane is the pane vsys draws in.
 *
 * `no` is the dangerous answer: it is the only one that permits a capture, so
 * it is the only one the pane map has to have spoken for. Anything undecided
 * says so instead, which costs a reader one terminal where a wrong `no` costs
 * the capture that draws vsys's screen inside itself, one copy deeper on every
 * sample.
 *
 * `docs/architecture/lanes.md` holds the rule the three answers serve.
 */
export function ownPaneMark(
  target: string,
  own: string,
  elsewhere: boolean,
  panes: Map<string, PaneAddress>,
  handle: string | null,
): Lane["self"] {
  if (target === "" || own === "" || elsewhere) return "no";
  const named = targetPanes(target, panes);
  // `no` permits the capture, so it needs the map to have spoken about vsys's
  // own pane. A handle target is compared against vsys's own handle directly
  // and needs no map entry; every other target does, and a listing that came
  // back without vsys's own row settles nothing about the panes beside it.
  if (named.size > 0 && !named.has(own) && (isPaneId(target) || panes.has(own)))
    return "no";
  return (named.size === 1 && named.has(own)) || handle === own
    ? "yes"
    : "unknown";
}
/** Alarmed scopes stay visible even when their slice is not watched. */
export function lanes(
  groups: Group[],
  procs: Proc[],
  c: CollectionConfig,
  cores = 0,
  /**
   * What one tmux read gave for the whole sample: every pane the server holds,
   * which server that was, and which pane vsys draws in. The three arrive
   * together because they are only meaningful together — a handle resolves
   * against the server it came from, and vsys's own pane is one of that
   * server's. Absent when no server answered.
   */
  tmux?: PaneSet,
  /** What the sample's probes found, which decides whether agents escape. */
  capabilities: Capability[] = [],
  processRead: ProcessRead = "complete",
): Lane[] {
  /** Every pane the read gave. Empty when no read answered. */
  const panes = tmux?.byId ?? new Map<string, PaneAddress>();
  /**
   * The server those panes came from. Empty means vsys does not know which
   * server it read, and an unknown boundary is not one to refuse at.
   */
  const socket = tmux?.socket ?? "";
  const own = tmux?.own ?? "";
  const result: Lane[] = [];
  const compared = sliceCompared(capabilities);
  // An escaped agent is worth a lane, and so is every agent where there is no
  // slice to watch them in: each one is shown with its own group.
  const agentLane = (p: Proc) =>
    escaped(p, c, capabilities) || (!compared && p.tool !== null);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const descendants = (group: Group) =>
    groups.filter(
      (g) =>
        group.path === "." ||
        g.path === group.path ||
        g.path.startsWith(`${group.path}/`),
    );
  const groupMembers = (group: Group) => {
    const pids = new Set(descendants(group).flatMap((g) => g.pids));
    const members: Proc[] = [];
    for (const pid of pids) {
      const p = byPid.get(pid);
      if (
        p &&
        (!group.kernelPath ||
          group.kernelPath === "/" ||
          p.group === group.kernelPath ||
          p.group.startsWith(`${group.kernelPath}/`))
      )
        members.push(p);
    }
    return members;
  };
  const candidates: { id: string; members: Proc[]; group?: Group }[] = [];
  for (const group of groups.filter((g) => g.name.endsWith(".scope"))) {
    const members = groupMembers(group);
    if (
      c.watchedSlices.some((s) => inSlice(group.path, s)) ||
      dangerousCap(group, groups, c.memoryFloor) ||
      members.some(agentLane)
    )
      candidates.push({ id: group.path, members, group });
  }
  const scoped = new Set(
    candidates.flatMap((candidate) => candidate.members.map((p) => p.pid)),
  );
  for (const proc of procs.filter((p) => agentLane(p) && !scoped.has(p.pid))) {
    if (candidates.some((candidate) => candidate.id === proc.group)) continue;
    const group = groups.find(
      (g) => (g.kernelPath ?? `/${g.path}`) === proc.group,
    );
    candidates.push({
      id: proc.group,
      group,
      members: procs.filter(
        (p) =>
          p.group === proc.group ||
          (group &&
            (proc.group === "/" || p.group.startsWith(`${proc.group}/`))),
      ),
    });
  }
  // The nearest lane owns a process, regardless of collection order. Group
  // counters remain cgroup readings and are not divided between lane owners.
  const owners = new Map<number, (typeof candidates)[number]>();
  for (const candidate of candidates)
    for (const p of candidate.members) {
      const previous = owners.get(p.pid);
      const path = candidate.group?.kernelPath ?? candidate.id;
      const priorPath = previous?.group?.kernelPath ?? previous?.id ?? "";
      if (!previous || path.length > priorPath.length)
        owners.set(p.pid, candidate);
    }
  function lane(id: string, members: Proc[], group?: Group) {
    if (!members.length && !group) return;
    const memberIndex = new Map(members.map((p) => [p.pid, p]));
    const complete = group
      ? descendants(group).every((g) => g.pids.every((pid) => byPid.has(pid)))
      : processRead === "complete";
    const main =
      scopeMain(group ? group.pids : members.map((p) => p.pid), memberIndex) ??
      members.find((p) => p.tool) ??
      members[0];
    const tool = members.find((p) => p.tool)?.tool ?? "";
    const cwd = main?.cwd ?? "";
    const branch = main?.branch ?? "";
    const derived =
      c.laneNaming === "branch"
        ? branch
        : c.laneNaming === "env"
          ? main?.env[c.laneEnv]
          : basename(cwd);
    const account = accountName(main, c);
    const pane = paneName(main, c);
    const mine = paneSocket(main);
    /**
     * What the lane says about its tmux server, against the one vsys read.
     * Naming no server is its own state, neither a match nor a boundary:
     * `elsewhere` refuses only a server known to differ, and the own-pane mark
     * below asks only that the lane is not on one.
     */
    const server =
      socket === "" || mine === ""
        ? "unknown"
        : mine === socket
          ? "same"
          : "other";
    const elsewhere = server === "other";
    // `TMUX_PANE` alone, never the configured list, which holds whatever
    // target the reader chose: a handle compares to a handle.
    const handle = firstEnv(main, ["TMUX_PANE"]);
    const self = ownPaneMark(pane, own, elsewhere, panes, handle);
    const title = windowTitle(main, c);
    const cgroup = group?.path ?? main?.group ?? id;
    const cpu =
      group?.cpuPercent ??
      (complete &&
      members.length > 0 &&
      members.every((p) => p.cpuPercent !== null)
        ? members.reduce((n, p) => n + (p.cpuPercent ?? 0), 0)
        : null);
    const builds: Record<string, number> = {};
    for (const p of members)
      if (p.build) builds[p.build] = (builds[p.build] ?? 0) + 1;
    // A group-less lane's `cgroup` is the process's absolute kernel path, not
    // one of vsys's own root-relative group paths, so effectiveMax() needs
    // the group that absolute path resolves to first.
    const capsGroup =
      group ?? (main ? coveringGroup(groups, main.group) : null);
    const caps = capsGroup
      ? effectiveMax(groups, capsGroup.path)
      : { max: null, known: false };
    const ioPressure = group?.pressure.io?.some ?? null;
    const memoryPressure = group?.pressure.memory?.some ?? null;
    result.push({
      id,
      // No pane part: `%9` is a server-global tmux handle, not a name, and a
      // reader cannot tell which window it belongs to. It stays on the lane as
      // the handle it is. Nothing is appended to make a name unique either:
      // an id that appears on some rows and not others reads as arbitrary, so
      // the process id is a column of its own on every row instead.
      name:
        laneName({ account, tool, title, workspace: derived || null }, [
          ...c.laneNameParts,
        ]) ||
        derived ||
        (group ? unitLabel(group.name) : "") ||
        main?.comm ||
        id,
      account,
      pane,
      // The resolved address is a reading, not part of the name: `%9` stays
      // the handle every action uses, and the address is what a reader reads.
      //
      // The map is keyed by tmux's own `%N`, and `paneEnv` reads `VSYS_PANE`
      // first, which this project documents and tests as holding an address
      // like `work:2.1`. Looked up by that, every configured lane found
      // nothing and showed no address at all. An address configured directly
      // is already the thing a reader types, so it is carried as it stands;
      // what it cannot give is a window name, which only the server knows.
      address: elsewhere
        ? ""
        : isPaneId(pane)
          ? (panes.get(pane)?.address ?? "")
          : pane,
      window: elsewhere
        ? ""
        : isPaneId(pane)
          ? (panes.get(pane)?.window ?? "")
          : "",
      /**
       * The pane belongs to a tmux server this vsys is not talking to. `%9` is
       * unique per server, so the one this vsys read holds a `%9` of its own
       * and reading or switching to it would reach a stranger's pane. Refused
       * only when both servers are known and differ: an unknown one is not a
       * boundary vsys can see, and the only route to a handle with no server
       * is a reader setting it themselves.
       */
      elsewhere,
      self,
      title,
      cwd,
      branch,
      tool,
      cgroup,
      mainPid: main?.pid ?? 0,
      pids: members.map((p) => p.pid),
      cpu,
      cpuShare: cpu === null || cores <= 0 ? null : cpu / cores,
      pressure: group?.pressure.cpu?.some ?? null,
      memoryPressure,
      ioPressure,
      rss:
        complete && members.length
          ? members.reduce((n, p) => n + p.rss, 0)
          : null,
      cache: group?.cache ?? null,
      swap:
        group?.swap ??
        (complete && members.length > 0 && members.every((p) => p.swap !== null)
          ? members.reduce((n, p) => n + (p.swap ?? 0), 0)
          : null),
      readRate: group?.readRate ?? null,
      writeRate: group?.writeRate ?? null,
      tasks:
        group?.tasks ??
        (complete && members.length
          ? members.reduce((n, p) => n + p.threads, 0)
          : null),
      rustc: complete ? (builds.rustc ?? 0) : null,
      cargo: complete ? (builds.cargo ?? 0) : null,
      tests: complete ? (builds.test ?? 0) : null,
      builds: complete ? builds : null,
      linkers: complete
        ? members.filter((p) => c.linkerNames.includes(p.build ?? "")).length
        : null,
      sccache: complete
        ? members.filter((p) =>
            c.sccacheNames.includes(basename(p.command[0] ?? p.comm)),
          ).length
        : null,
      memoryMax: caps.max,
      memoryMaxKnown: caps.known,
      cpuWeight: group?.weight ?? null,
      ...jobserver(main, c.jobserverEnv),
      age:
        complete && members.length
          ? Math.max(0, ...members.map((p) => p.age))
          : null,
      state: members.some((p) => p.state === "D")
        ? "blocked"
        : members.some((p) => p.state === "R")
          ? "running"
          : members.length
            ? "sleeping"
            : "empty",
      blocked: members.filter((p) => p.state === "D").length,
      blockedOn: blockedOn(ioPressure, memoryPressure),
      unconfined: members.some((p) => escaped(p, c, capabilities)),
      dangerous: capsGroup
        ? dangerousCap(capsGroup, groups, c.memoryFloor)
        : false,
    });
  }
  for (const candidate of candidates)
    lane(
      candidate.id,
      candidate.members.filter((p) => owners.get(p.pid) === candidate),
      candidate.group,
    );
  return result;
}
/** Parent IDs can disappear between samples; cycles terminate explicitly. */
export function parentChain(proc: Proc, all: Proc[]): Proc[] {
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const seen = new Set([proc.pid]);
  const result: Proc[] = [];
  let parent = byPid.get(proc.ppid);
  let child = proc;
  while (parent && parent.start <= child.start && !seen.has(parent.pid)) {
    result.push(parent);
    seen.add(parent.pid);
    child = parent;
    parent = byPid.get(parent.ppid);
  }
  return result;
}
/** Ancestor paths keep each subtree contiguous even after PID reuse. */
export function processTree(procs: Proc[]): { proc: Proc; depth: number }[] {
  return procs
    .map((proc) => ({
      proc,
      chain: [...parentChain(proc, procs).reverse(), proc],
    }))
    .sort((a, b) => {
      for (const [i, left] of a.chain.entries()) {
        const right = b.chain[i];
        if (right === undefined) break;
        if (left.pid !== right.pid)
          return left.start - right.start || left.pid - right.pid;
      }
      return a.chain.length - b.chain.length;
    })
    .map(({ proc, chain }) => ({ proc, depth: chain.length - 1 }));
}
/**
 * The resource a lane stalls on most, and that stall. A lane stored before a
 * pressure was read carries none for it, so only numbers compete.
 */
export function worstPressure(
  lane: Lane,
): { resource: "cpu" | "memory" | "io"; some: number } | null {
  const waits = [
    { resource: "cpu", some: lane.pressure },
    { resource: "memory", some: lane.memoryPressure },
    { resource: "io", some: lane.ioPressure },
  ] as const;
  let worst: { resource: "cpu" | "memory" | "io"; some: number } | null = null;
  for (const { resource, some } of waits)
    if (typeof some === "number" && (worst === null || some > worst.some))
      worst = { resource, some };
  return worst;
}
/** Agents colouring considers every resource while its pressure column shows CPU. */
export function lanePressure(lane: Lane): number | null {
  return worstPressure(lane)?.some ?? null;
}
