import type { Config } from "../config/config";
import { inSlice } from "./lanes";
import type { Group, Lane, Snapshot } from "./types";

export type Level = "ok" | "warn" | "danger";
export interface Verdict {
  level: Level;
  headline: string;
  detail: string;
}
export interface Meter {
  id: "cpu" | "memory" | "disk" | "builds";
  label: string;
  value: string;
  /** The single biggest consumer behind the number. */
  who: string;
  level: Level;
}
/** A slice appears once per snapshot; nested copies are not summed here. */
export function sliceGroup(groups: Group[], name: string): Group | undefined {
  return groups.find((g) => g.name === name);
}
/** The scope that wrote most since the previous sample, never its parent slice. */
export function topWriter(groups: Group[]): Group | undefined {
  return groups
    .filter((g) => g.name.endsWith(".scope") && g.writeRate !== null)
    .sort((a, b) => (b.writeRate ?? 0) - (a.writeRate ?? 0))[0];
}
/** Swap of the interactive session, from the desktop slice's own counter. */
export function desktopSwap(groups: Group[], c: Config): number | null {
  return sliceGroup(groups, c.desktopSlice)?.swap ?? null;
}
/** The desktop scope holding the most swap, which is what the person feels. */
export function topSwapHolder(groups: Group[], c: Config): Group | undefined {
  return groups
    .filter(
      (g) =>
        g.name.endsWith(".scope") &&
        inSlice(g.path, c.desktopSlice) &&
        (g.swap ?? 0) > 0,
    )
    .sort((a, b) => (b.swap ?? 0) - (a.swap ?? 0))[0];
}
export function unconfinedLanes(s: Snapshot): Lane[] {
  return s.lanes.filter((l) => l.unconfined);
}
/** Compile and link work, machine wide, with linkers counted separately. */
export function buildLoad(
  s: Snapshot,
  c: Config,
): { builds: number; linkers: number; lanes: number } {
  const building = s.procs.filter((p) => p.build);
  const groups = new Set(building.map((p) => p.group));
  return {
    builds: building.length,
    linkers: building.filter((p) => c.linkerNames.includes(p.build ?? ""))
      .length,
    lanes: groups.size,
  };
}
/** Linkers inside one lane, matched through the lane's own process list. */
export function laneLinkers(s: Snapshot, lane: Lane, c: Config): number {
  const members = new Set(lane.pids);
  return s.procs.filter(
    (p) => members.has(p.pid) && c.linkerNames.includes(p.build ?? ""),
  ).length;
}
function name(group: Group | undefined, s: Snapshot): string {
  if (!group) return "";
  return s.lanes.find((l) => l.id === group.path)?.name ?? group.name;
}
/**
 * One line, ranked by what the person at the keyboard feels. An unconfined
 * agent outranks a slow machine because no limit applies to it at all.
 */
export function verdict(s: Snapshot, c: Config): Verdict {
  const escaped = unconfinedLanes(s);
  if (escaped.length)
    return {
      level: "danger",
      headline: `Danger: ${escaped.length} ${
        escaped.length === 1 ? "lane runs" : "lanes run"
      } outside ${c.agentSlice}`,
      detail: escaped.map((l) => l.name).join(", "),
    };
  const io = s.system.pressure.io?.some ?? null;
  const writer = topWriter(s.groups);
  if (io !== null && io > c.pressureRed)
    return {
      level: "danger",
      headline: writer
        ? `Slow: disk I/O saturated by ${name(writer, s)}`
        : "Slow: disk I/O saturated",
      detail: `Tasks stalled on storage ${io.toFixed(1)}% of the recent window.`,
    };
  const swap = desktopSwap(s.groups, c);
  const cache = sliceGroup(s.groups, c.agentSlice)?.cache ?? null;
  if (swap !== null && swap > c.swapFloor)
    return {
      level: "danger",
      headline: `Slow: desktop swapped out${
        cache === null ? "" : `, agent build cache holds ${cache} bytes`
      }`,
      detail: `${c.desktopSlice} holds ${swap} bytes in swap.`,
    };
  const cpu = s.system.pressure.cpu?.some ?? null;
  const memory = s.system.pressure.memory?.some ?? null;
  const busiest = [...s.lanes].sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0))[0];
  if (memory !== null && memory > c.pressureRed)
    return {
      level: "warn",
      headline: "Slow: memory reclaim is stalling tasks",
      detail: `Memory pressure is ${memory.toFixed(1)}%.`,
    };
  if (cpu !== null && cpu > c.pressureRed)
    return {
      level: "warn",
      headline: busiest
        ? `Slow: CPU contended, busiest lane ${busiest.name}`
        : "Slow: CPU contended",
      detail: `CPU pressure is ${cpu.toFixed(1)}%.`,
    };
  if (io === null && cpu === null && memory === null)
    return {
      level: "warn",
      headline: "Health unknown: no pressure data on this kernel",
      detail: "Verdict needs pressure stall information.",
    };
  return {
    level: "ok",
    headline: "Healthy",
    detail: "No resource is short and every agent runs inside its slice.",
  };
}
/** Four meters. Each names the single biggest consumer beside its number. */
export function meters(
  s: Snapshot,
  c: Config,
  format: {
    bytes: (n: number | null) => string;
    percent: (n: number | null) => string;
  },
): Meter[] {
  const { bytes, percent } = format;
  const agents = sliceGroup(s.groups, c.agentSlice);
  const desktop = sliceGroup(s.groups, c.desktopSlice);
  const busiest = [...s.lanes].sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0))[0];
  const writer = topWriter(s.groups);
  const swap = desktopSwap(s.groups, c);
  const holder = topSwapHolder(s.groups, c);
  const memoryHolder = [...s.groups]
    .filter((g) => g.name.endsWith(".scope"))
    .sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0))[0];
  const load = buildLoad(s, c);
  const io = s.system.pressure.io?.some ?? null;
  const cpu = s.system.pressure.cpu?.some ?? null;
  const total = s.system.memory.MemTotal ?? null;
  const available = s.system.memory.MemAvailable ?? null;
  const level = (value: number | null, amber: number, red: number): Level =>
    value === null
      ? "warn"
      : value > red
        ? "danger"
        : value > amber
          ? "warn"
          : "ok";
  return [
    {
      id: "cpu",
      label: "CPU",
      value: `agents ${percent(agents?.cpuPercent ?? null)} | desktop ${percent(
        desktop?.cpuPercent ?? null,
      )}`,
      who: busiest
        ? `busiest lane ${busiest.name} ${percent(busiest.cpu)}`
        : "no lanes",
      level: level(cpu, c.pressureAmber, c.pressureRed),
    },
    {
      id: "memory",
      label: "Memory",
      value: `${bytes(
        total === null || available === null ? null : total - available,
      )} used of ${bytes(total)} | agent cache ${bytes(
        agents?.cache ?? null,
      )} | desktop swap ${bytes(swap)}`,
      who:
        swap !== null && swap > 0 && holder
          ? `most swapped ${holder.name} ${bytes(holder.swap)}`
          : memoryHolder
            ? `largest ${memoryHolder.name} ${bytes(memoryHolder.memory)}`
            : "no scopes",
      level: swap !== null && swap > c.swapFloor ? "danger" : "ok",
    },
    {
      id: "disk",
      label: "Disk",
      value: `pressure some ${percent(io)} full ${percent(
        s.system.pressure.io?.full ?? null,
      )}`,
      who: writer
        ? `top writer ${name(writer, s)} ${bytes(writer.writeRate)}/s`
        : "write rates unavailable",
      level: level(io, c.pressureAmber, c.pressureRed),
    },
    {
      id: "builds",
      label: "Build slots",
      value: `${load.builds} compile and link processes / ${s.system.cores} cores | ${load.linkers} linkers`,
      who: `${load.lanes} ${load.lanes === 1 ? "lane" : "lanes"} building`,
      level:
        load.builds > s.system.cores * 2
          ? "danger"
          : load.builds > s.system.cores
            ? "warn"
            : "ok",
    },
  ];
}
