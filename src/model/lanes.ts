import { basename } from "node:path";
import type { CollectionConfig } from "../collect/settings";
import {
  accountName,
  jobserver,
  laneName,
  paneName,
  windowTitle,
} from "./naming";
import { scopeMain } from "./scopes";
import type { Group, Lane, Proc } from "./types";

export function inSlice(path: string, slice: string): boolean {
  return path.split("/").includes(slice);
}
/** One rule for an escaped agent: a configured tool outside the agent slice. */
export function escaped(p: Proc, c: CollectionConfig): boolean {
  return p.tool !== null && !inSlice(p.group, c.agentSlice);
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
/** Alarmed scopes stay visible even when their slice is not watched. */
export function lanes(
  groups: Group[],
  procs: Proc[],
  c: CollectionConfig,
  cores = 0,
): Lane[] {
  const covered = new Set<number>();
  const result: Lane[] = [];
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  function lane(id: string, members: Proc[], group?: Group) {
    if (!members.length && !group) return;
    const memberIndex = new Map(members.map((p) => [p.pid, p]));
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
    const title = windowTitle(main, c);
    const cgroup = group?.path ?? main?.group ?? id;
    const cpu =
      group?.cpuPercent ??
      (members.every((p) => p.cpuPercent !== null)
        ? members.reduce((n, p) => n + (p.cpuPercent ?? 0), 0)
        : null);
    const builds: Record<string, number> = {};
    for (const p of members)
      if (p.build) builds[p.build] = (builds[p.build] ?? 0) + 1;
    const caps = effectiveMax(groups, cgroup);
    const ioPressure = group?.pressure.io?.some ?? null;
    const memoryPressure = group?.pressure.memory?.some ?? null;
    result.push({
      id,
      name:
        laneName({ account, tool, pane, title, workspace: derived || null }, [
          ...c.laneNameParts,
        ]) ||
        derived ||
        group?.name ||
        main?.comm ||
        id,
      account,
      pane,
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
      rss: members.reduce((n, p) => n + p.rss, 0),
      cache: group?.cache ?? null,
      swap:
        group?.swap ??
        (members.every((p) => p.swap !== null)
          ? members.reduce((n, p) => n + (p.swap ?? 0), 0)
          : null),
      readRate: group?.readRate ?? null,
      writeRate: group?.writeRate ?? null,
      tasks: group?.tasks ?? members.reduce((n, p) => n + p.threads, 0),
      rustc: builds.rustc ?? 0,
      cargo: builds.cargo ?? 0,
      tests: builds.test ?? 0,
      builds,
      linkers: members.filter((p) => c.linkerNames.includes(p.build ?? ""))
        .length,
      sccache: members.filter((p) =>
        c.sccacheNames.includes(basename(p.command[0] ?? p.comm)),
      ).length,
      memoryMax: caps.max,
      memoryMaxKnown: caps.known,
      cpuWeight: group?.weight ?? null,
      ...jobserver(main, c.jobserverEnv),
      age: Math.max(0, ...members.map((p) => p.age)),
      state: members.some((p) => p.state === "D")
        ? "blocked"
        : members.some((p) => p.state === "R")
          ? "running"
          : members.length
            ? "sleeping"
            : "empty",
      blocked: members.filter((p) => p.state === "D").length,
      blockedOn: blockedOn(ioPressure, memoryPressure),
      unconfined: members.some((p) => escaped(p, c)),
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
      members.some((p) => escaped(p, c))
    )
      lane(group.path, members, group);
  }
  for (const proc of procs.filter(
    (p) => escaped(p, c) && !covered.has(p.pid),
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
