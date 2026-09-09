import { basename } from "node:path";
import type { Config } from "../config/config";
import { scopeMain } from "./scopes";
import type { Group, Lane, Proc } from "./types";

export function inSlice(path: string, slice: string): boolean {
  return path.split("/").includes(slice);
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
/** Alarmed scopes stay visible even when their slice is not watched. */
export function lanes(groups: Group[], procs: Proc[], c: Config): Lane[] {
  const covered = new Set<number>();
  const result: Lane[] = [];
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  function lane(id: string, members: Proc[], group?: Group) {
    if (!members.length && !group) return;
    const main =
      (group
        ? scopeMain(group.pids, new Map(members.map((p) => [p.pid, p])))
        : undefined) ??
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
    result.push({
      id,
      name: derived || group?.name || main?.comm || id,
      account: main?.envAvailable
        ? basename(main.env.CLAUDE_CONFIG_DIR ?? "default")
        : "?",
      cwd,
      branch,
      tool,
      mainPid: main?.pid ?? 0,
      pids: members.map((p) => p.pid),
      cpu:
        group?.cpuPercent ??
        (members.every((p) => p.cpuPercent !== null)
          ? members.reduce((n, p) => n + (p.cpuPercent ?? 0), 0)
          : null),
      pressure: group?.pressure.cpu?.some ?? null,
      memoryPressure: group?.pressure.memory?.some ?? null,
      ioPressure: group?.pressure.io?.some ?? null,
      rss: members.reduce((n, p) => n + p.rss, 0),
      swap:
        group?.swap ??
        (members.every((p) => p.swap !== null)
          ? members.reduce((n, p) => n + (p.swap ?? 0), 0)
          : null),
      tasks: group?.tasks ?? members.reduce((n, p) => n + p.threads, 0),
      rustc: members.filter((p) => p.build === "rustc").length,
      cargo: members.filter((p) => p.build === "cargo").length,
      tests: members.filter((p) => p.build === "test").length,
      age: Math.max(0, ...members.map((p) => p.age)),
      state: members.some((p) => p.state === "D")
        ? "blocked"
        : members.some((p) => p.state === "R")
          ? "running"
          : members.length
            ? "sleeping"
            : "empty",
      unconfined: members.some(
        (p) => p.tool && !inSlice(p.group, c.agentSlice),
      ),
      dangerous: group ? dangerousCap(group, groups, c.memoryFloor) : false,
    });
    for (const p of members) covered.add(p.pid);
  }
  for (const group of groups.filter((g) => g.name.endsWith(".scope"))) {
    const pids = new Set(
      groups
        .filter(
          (g) => g.path === group.path || g.path.startsWith(`${group.path}/`),
        )
        .flatMap((g) => g.pids),
    );
    const members: Proc[] = [];
    for (const pid of pids) {
      const p = byPid.get(pid);
      if (
        p &&
        (!group.kernelPath ||
          p.group === group.kernelPath ||
          p.group.startsWith(`${group.kernelPath}/`))
      )
        members.push(p);
    }
    if (
      c.watchedSlices.some((s) => inSlice(group.path, s)) ||
      dangerousCap(group, groups, c.memoryFloor) ||
      members.some((p) => p.tool && !inSlice(p.group, c.agentSlice))
    )
      lane(group.path, members, group);
  }
  for (const proc of procs.filter(
    (p) => p.tool && !inSlice(p.group, c.agentSlice) && !covered.has(p.pid),
  )) {
    if (covered.has(proc.pid)) continue;
    lane(
      proc.group,
      procs.filter((p) => p.group === proc.group),
    );
  }
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
      for (let i = 0; i < Math.min(a.chain.length, b.chain.length); i++) {
        const left = a.chain[i];
        const right = b.chain[i];
        if (left.pid !== right.pid)
          return left.start - right.start || left.pid - right.pid;
      }
      return a.chain.length - b.chain.length;
    })
    .map(({ proc, chain }) => ({ proc, depth: chain.length - 1 }));
}
/** Fleet colouring considers every resource while its pressure column shows CPU. */
export function lanePressure(lane: Lane): number | null {
  const values = [lane.pressure, lane.memoryPressure, lane.ioPressure].filter(
    (n): n is number => typeof n === "number",
  );
  return values.length ? Math.max(...values) : null;
}
