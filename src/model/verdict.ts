import type { Config } from "../config/config";
import { inSlice, lanePressure } from "./lanes";
import type { Group, Lane, Snapshot, Volume } from "./types";

export type Level = "ok" | "warn" | "danger";
/** Every cause is detected once. The verdict, the meters and the cards read it. */
export type CauseId =
  | "unconfined"
  | "read-only"
  | "device-errors"
  | "disk"
  | "desktop-swap"
  | "free-space"
  | "memory-cap"
  | "stalls"
  | "system-memory"
  | "system-cpu"
  | "memory-high"
  | "scrub"
  | "scratch";
export interface Cause {
  id: CauseId;
  level: Level;
  /** Lanes, groups and paths this cause affects, in the order to show them. */
  lanes: Lane[];
  groups: Group[];
  paths: string[];
  /** The single biggest consumer behind the cause, empty when there is none. */
  consumer: string;
  /** The numbers behind the cause. Formatting belongs to the UI. */
  values: Record<string, number | null>;
}
export interface Meter {
  id: "cpu" | "memory" | "disk" | "builds";
  level: Level;
  consumer: string;
  values: Record<string, number | null>;
}
/** A slice name can appear at more than one path; nested copies are not summed. */
export function sliceRoots(groups: Group[], name: string): Group[] {
  const matching = groups.filter((g) => g.name === name);
  return matching.filter(
    (g) =>
      !matching.some(
        (parent) =>
          parent !== g &&
          (parent.path === "." || g.path.startsWith(`${parent.path}/`)),
      ),
  );
}
/** A slice total is unknown unless every root reports the counter. */
export function sliceSum(
  groups: Group[],
  name: string,
  pick: (g: Group) => number | null,
): number | null {
  const roots = sliceRoots(groups, name);
  return roots.length && roots.every((g) => pick(g) !== null)
    ? roots.reduce((sum, g) => sum + (pick(g) ?? 0), 0)
    : null;
}
/** The scope that wrote most since the previous sample, never its parent slice. */
export function topWriter(groups: Group[]): Group | undefined {
  return groups
    .filter((g) => g.name.endsWith(".scope") && g.writeRate !== null)
    .sort((a, b) => (b.writeRate ?? 0) - (a.writeRate ?? 0))[0];
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
export function leastFree(volumes: Volume[]): Volume | undefined {
  return volumes
    .filter((v) => v.free !== null)
    .sort((a, b) => (a.free ?? 0) - (b.free ?? 0))[0];
}
/** Compile and link work, machine wide, with linkers counted separately. */
export function buildLoad(
  s: Snapshot,
  c: Config,
): { builds: number; linkers: number; lanes: number } {
  const building = s.procs.filter((p) => p.build);
  return {
    builds: building.length,
    linkers: building.filter((p) => c.linkerNames.includes(p.build ?? ""))
      .length,
    lanes: new Set(building.map((p) => p.group)).size,
  };
}
/** Linkers inside one lane, matched through the lane's own process list. */
export function laneLinkers(s: Snapshot, lane: Lane, c: Config): number {
  const members = new Set(lane.pids);
  return s.procs.filter(
    (p) => members.has(p.pid) && c.linkerNames.includes(p.build ?? ""),
  ).length;
}
/** A scope's lane name when it has one, otherwise the unit name. */
export function consumerName(group: Group | undefined, s: Snapshot): string {
  if (!group) return "";
  return s.lanes.find((l) => l.id === group.path)?.name ?? group.name;
}
export function pressureKnown(s: Snapshot): boolean {
  return ["cpu", "memory", "io"].some((kind) => s.system.pressure[kind]);
}
function busiest(lanes: Lane[]): Lane | undefined {
  return [...lanes].sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0))[0];
}
/**
 * The ranked ladder of causes, worst first. The first element is the verdict,
 * every element is an attention card, and the meters read the same numbers.
 * Ranking follows the impact on the person at the keyboard, not the count.
 */
export function causes(s: Snapshot, c: Config): Cause[] {
  const out: Cause[] = [];
  const add = (id: CauseId, level: Level, rest: Partial<Cause>) =>
    out.push({
      id,
      level,
      lanes: [],
      groups: [],
      paths: [],
      consumer: "",
      values: {},
      ...rest,
    });
  const io = s.system.pressure.io?.some ?? null;
  const escaped = s.lanes.filter((l) => l.unconfined);
  if (escaped.length)
    add("unconfined", "danger", {
      lanes: escaped,
      consumer: escaped[0].name,
      values: { lanes: escaped.length },
    });
  const readOnly = s.storage.volumes.filter((v) => v.readOnly);
  if (readOnly.length)
    add("read-only", "danger", {
      paths: readOnly.map((v) => v.mount),
      consumer: readOnly[0].mount,
    });
  const failing = s.storage.volumes.filter((v) =>
    Object.values(v.delta).some((n) => n > 0),
  );
  if (failing.length)
    add("device-errors", "danger", {
      paths: failing.map((v) => v.mount),
      consumer: failing[0].device,
    });
  const writer = topWriter(s.groups);
  if (io !== null && io > c.pressureAmber && writer) {
    const lane = s.lanes.find((l) => l.id === writer.path);
    add("disk", io > c.pressureRed ? "danger" : "warn", {
      lanes: lane ? [lane] : [],
      groups: [writer],
      consumer: consumerName(writer, s),
      values: {
        some: io,
        full: s.system.pressure.io?.full ?? null,
        writeRate: writer.writeRate,
        linkers: lane ? laneLinkers(s, lane, c) : 0,
      },
    });
  }
  const swap = sliceSum(s.groups, c.desktopSlice, (g) => g.swap);
  if (swap !== null && swap > c.swapFloor) {
    const holder = topSwapHolder(s.groups, c);
    add("desktop-swap", "danger", {
      groups: holder ? [holder] : [],
      consumer: holder?.name ?? "",
      values: {
        swap,
        holder: holder?.swap ?? null,
        cache: sliceSum(s.groups, c.agentSlice, (g) => g.cache),
      },
    });
  }
  const free = leastFree(s.storage.volumes);
  if (free && (free.free ?? 0) < c.freeFloor)
    add("free-space", "danger", {
      paths: [free.mount],
      consumer: free.mount,
      values: { free: free.free, total: free.total },
    });
  const capped = s.lanes.filter((l) => l.dangerous);
  if (capped.length)
    add("memory-cap", "danger", {
      lanes: capped,
      consumer: capped[0].name,
      values: { lanes: capped.length, floor: c.memoryFloor },
    });
  const stalling = s.lanes.filter(
    (l) => (lanePressure(l) ?? 0) > c.pressureAmber,
  );
  if (stalling.length) {
    const worst = Math.max(...stalling.map((l) => lanePressure(l) ?? 0));
    add("stalls", worst > c.pressureRed ? "danger" : "warn", {
      lanes: stalling,
      consumer: stalling[0].name,
      values: { lanes: stalling.length, worst },
    });
  }
  const memory = s.system.pressure.memory?.some ?? null;
  if (memory !== null && memory > c.pressureRed)
    add("system-memory", "warn", {
      consumer: topSwapHolder(s.groups, c)?.name ?? "",
      values: { some: memory },
    });
  const cpu = s.system.pressure.cpu?.some ?? null;
  if (cpu !== null && cpu > c.pressureRed)
    add("system-cpu", "warn", {
      consumer: busiest(s.lanes)?.name ?? "",
      values: { some: cpu },
    });
  const near = s.groups.filter(
    (g) => g.memory !== null && g.high !== null && g.memory >= g.high * 0.9,
  );
  if (near.length)
    add("memory-high", "warn", { groups: near, consumer: near[0].name });
  const scrubs = s.storage.scrubs.filter((scrub) => scrub.problem);
  if (scrubs.length)
    add("scrub", "danger", {
      paths: scrubs.map((scrub) => scrub.path),
      consumer: scrubs[0].path,
    });
  const large = s.storage.scratch.filter(
    (scratch) => scratch.bytes !== null && scratch.bytes > c.scratchQuota,
  );
  if (large.length)
    add("scratch", "warn", {
      paths: large.map((scratch) => scratch.path),
      consumer: large[0].path,
      values: {
        largest: Math.max(...large.map((scratch) => scratch.bytes ?? 0)),
        quota: c.scratchQuota,
      },
    });
  return out;
}
/** Four meters. Each carries its numbers and the single biggest consumer. */
export function meters(s: Snapshot, c: Config): Meter[] {
  const top = busiest(s.lanes);
  const writer = topWriter(s.groups);
  const swap = sliceSum(s.groups, c.desktopSlice, (g) => g.swap);
  const holder = topSwapHolder(s.groups, c);
  const largest = [...s.groups]
    .filter((g) => g.name.endsWith(".scope"))
    .sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0))[0];
  const load = buildLoad(s, c);
  const io = s.system.pressure.io?.some ?? null;
  const cpu = s.system.pressure.cpu?.some ?? null;
  const total = s.system.memory.MemTotal ?? null;
  const available = s.system.memory.MemAvailable ?? null;
  const free = leastFree(s.storage.volumes);
  const level = (value: number | null): Level =>
    value === null
      ? "warn"
      : value > c.pressureRed
        ? "danger"
        : value > c.pressureAmber
          ? "warn"
          : "ok";
  return [
    {
      id: "cpu",
      level: level(cpu),
      consumer: top?.name ?? "",
      values: {
        agents: sliceSum(s.groups, c.agentSlice, (g) => g.cpuPercent),
        desktop: sliceSum(s.groups, c.desktopSlice, (g) => g.cpuPercent),
        top: top?.cpu ?? null,
      },
    },
    {
      id: "memory",
      level: swap !== null && swap > c.swapFloor ? "danger" : "ok",
      consumer: (swap ? holder?.name : largest?.name) ?? "",
      values: {
        used: total === null || available === null ? null : total - available,
        total,
        cache: sliceSum(s.groups, c.agentSlice, (g) => g.cache),
        swap,
        holder: (swap ? holder?.swap : largest?.memory) ?? null,
      },
    },
    {
      id: "disk",
      level: level(io),
      consumer: consumerName(writer, s),
      values: {
        some: io,
        full: s.system.pressure.io?.full ?? null,
        writeRate: writer?.writeRate ?? null,
        free: free?.free ?? null,
      },
    },
    {
      id: "builds",
      level:
        load.builds > s.system.cores * 2
          ? "danger"
          : load.builds > s.system.cores
            ? "warn"
            : "ok",
      consumer: top?.name ?? "",
      values: {
        builds: load.builds,
        linkers: load.linkers,
        cores: s.system.cores,
        lanes: load.lanes,
      },
    },
  ];
}
