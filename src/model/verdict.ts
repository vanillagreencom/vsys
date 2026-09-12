import { compileOrLink } from "../collect/builds";
import type { Config } from "../config/config";
import { inSlice, lanePressure } from "./lanes";
import { laneText, unitLabel } from "./naming";
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
/**
 * The order that breaks a tie between two causes of one severity, worst first.
 * The ladder sorts by it, and anything ranking a cause the ladder is not
 * currently reporting reads the same table rather than a live position. The
 * record covers the union, so a new cause cannot be added without a rank.
 */
export const causeOrder: Record<CauseId, number> = {
  unconfined: 0,
  "read-only": 1,
  "device-errors": 2,
  disk: 3,
  "desktop-swap": 4,
  "free-space": 5,
  "memory-cap": 6,
  stalls: 7,
  "system-memory": 8,
  "system-cpu": 9,
  "memory-high": 10,
  scrub: 11,
  scratch: 12,
};
export function causeRank(id: CauseId): number {
  return causeOrder[id];
}
/**
 * Where a cause points the reader. This is not a subject: a cause about a
 * machine-wide stall names the scope worth opening without claiming that scope
 * is one of the things that went wrong. Nothing here ever becomes an alert.
 */
export type CauseAt =
  | { kind: "lane"; id: string }
  | { kind: "group"; path: string }
  | { kind: "path"; path: string };
export interface Cause {
  id: CauseId;
  level: Level;
  /**
   * What this cause is about: the lanes, groups and paths it affects, in the
   * order to show them. Each one becomes its own alert with its own duration,
   * so two escaped lanes are two alerts. A row put here to make a card open on
   * it opens an alert for it too, and the counts a reader watches on Home and
   * on Timeline rise for something that never went wrong. Use `at` for that.
   */
  lanes: Lane[];
  groups: Group[];
  paths: string[];
  /** Where the card lands, when that row is not one of the subjects above. */
  at?: CauseAt;
  /** The single biggest consumer behind the cause, empty when there is none. */
  consumer: string;
  /** The numbers behind the cause. Formatting belongs to the UI. */
  values: Record<string, number | null>;
  /** Housekeeping causes are cards but never the verdict for the machine. */
  verdictWorthy: boolean;
}
export interface Meter {
  id: "cpu" | "memory" | "disk" | "builds";
  level: Level;
  consumer: string;
  /** The scope holding swap, named only while the desktop is swapped out. */
  holder?: string;
  values: Record<string, number | null>;
}
export type Kind = "cpu" | "memory" | "io";
/** The resource a lane stalls on most, so one card can own that lane. */
export function worstKind(l: Lane): Kind | null {
  const r: [Kind, number | null][] = [
    ["cpu", l.pressure],
    ["memory", l.memoryPressure],
    ["io", l.ioPressure],
  ];
  const best = r.filter(([, v]) => v !== null);
  return best.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]?.[0] ?? null;
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
  const building = s.procs.filter((p) =>
    compileOrLink(p.build, c.compilerNames, c.linkerNames),
  );
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
/** A scope's lane name when it has one, otherwise the decoded unit name. */
export function consumerName(group: Group | undefined, s: Snapshot): string {
  if (!group) return "";
  const lane = s.lanes.find((l) => l.id === group.path);
  return lane ? laneText(lane) : unitLabel(group.name);
}
/** A lane named in text, or nothing when there is no lane to name. */
const laneOrNone = (lane: Lane | undefined): string =>
  lane ? laneText(lane) : "";
function busiest(lanes: Lane[]): Lane | undefined {
  return [...lanes].sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0))[0];
}
/**
 * The ladder of causes, worst first. Every element is an attention card, the
 * first verdict-worthy one is the verdict, and the meters read the same
 * numbers. Severity ranks it, then the impact on the person at the keyboard.
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
      verdictWorthy: true,
      ...rest,
    });
  const io = s.system.pressure.io?.some ?? null;
  const cpu = s.system.pressure.cpu?.some ?? null;
  const memory = s.system.pressure.memory?.some ?? null;
  const writer = topWriter(s.groups);
  // A lane stalling on a resource a specific cause reports belongs to that
  // card, so one contention never produces two cards.
  const diskFired = io !== null && io > c.pressureAmber && writer !== undefined;
  const cpuFired = cpu !== null && cpu > c.pressureRed;
  const memoryFired = memory !== null && memory > c.pressureRed;
  const covered = new Set<Kind>();
  if (diskFired) covered.add("io");
  if (cpuFired) covered.add("cpu");
  if (memoryFired) covered.add("memory");
  const stalling = s.lanes.filter(
    (l) => (lanePressure(l) ?? 0) > c.pressureAmber,
  );
  const owned = (kind: Kind) => stalling.filter((l) => worstKind(l) === kind);
  const loose = stalling.filter((l) => {
    const kind = worstKind(l);
    return kind === null || !covered.has(kind);
  });
  const escaped = s.lanes.filter((l) => l.unconfined);
  if (escaped.length)
    add("unconfined", "danger", {
      lanes: escaped,
      consumer: laneText(escaped[0]),
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
  if (diskFired && writer) {
    const lane = s.lanes.find((l) => l.id === writer.path);
    const stalled = owned("io").filter((l) => l.id !== lane?.id);
    add("disk", io !== null && io > c.pressureRed ? "danger" : "warn", {
      lanes: [...(lane ? [lane] : []), ...stalled],
      groups: [writer],
      consumer: consumerName(writer, s),
      values: {
        some: io,
        full: s.system.pressure.io?.full ?? null,
        writeRate: writer.writeRate,
        linkers: lane ? laneLinkers(s, lane, c) : 0,
        stalling: stalled.length,
      },
    });
  }
  const swap = sliceSum(s.groups, c.desktopSlice, (g) => g.swap);
  /**
   * The scope holding the most swap, resolved once because two causes name it
   * — and they mean different things by it. The swap cause is about that
   * scope, so it is one of its subjects. The memory-reclaim cause is about
   * reclaim stalling tasks; the scope is only where to look, and naming it a
   * subject there opened a second alert for something that had not itself
   * gone wrong.
   */
  const swapHolder = topSwapHolder(s.groups, c);
  const holderName = consumerName(swapHolder, s);
  const holderAt: CauseAt | undefined = swapHolder
    ? { kind: "group", path: swapHolder.path }
    : undefined;
  if (swap !== null && swap > c.swapFloor)
    add("desktop-swap", "danger", {
      groups: swapHolder ? [swapHolder] : [],
      consumer: holderName,
      values: {
        swap,
        holder: swapHolder?.swap ?? null,
        cache: sliceSum(s.groups, c.agentSlice, (g) => g.cache),
      },
    });
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
      consumer: laneText(capped[0]),
      values: { lanes: capped.length, floor: c.memoryFloor },
    });
  if (loose.length) {
    const worst = Math.max(...loose.map((l) => lanePressure(l) ?? 0));
    add("stalls", worst > c.pressureRed ? "danger" : "warn", {
      lanes: loose,
      consumer: laneText(loose[0]),
      values: { lanes: loose.length, worst },
    });
  }
  if (memoryFired)
    add("system-memory", "warn", {
      lanes: owned("memory"),
      consumer: holderName,
      at: holderAt,
      values: { some: memory },
    });
  if (cpuFired)
    add("system-cpu", "warn", {
      lanes: owned("cpu"),
      consumer: laneOrNone(busiest(s.lanes)),
      values: { some: cpu },
    });
  const near = s.groups.filter(
    (g) => g.memory !== null && g.high !== null && g.memory >= g.high * 0.9,
  );
  if (near.length)
    add("memory-high", "warn", {
      groups: near,
      consumer: near[0].name,
      verdictWorthy: false,
    });
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
      verdictWorthy: false,
      values: {
        largest: Math.max(...large.map((scratch) => scratch.bytes ?? 0)),
        quota: c.scratchQuota,
      },
    });
  // Severity decides the order; the cause order table breaks a tie.
  const rank = { danger: 2, warn: 1, ok: 0 };
  return out.sort(
    (a, b) =>
      rank[b.level] - rank[a.level] || causeRank(a.id) - causeRank(b.id),
  );
}
/** Four meters. Each carries its numbers and the single biggest consumer. */
export function meters(s: Snapshot, c: Config): Meter[] {
  const top = busiest(s.lanes);
  const writer = topWriter(s.groups);
  const swap = sliceSum(s.groups, c.desktopSlice, (g) => g.swap);
  const swapped = swap !== null && swap > c.swapFloor;
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
  // One rule for every meter: a quantity the level depends on that could not
  // be read is a warning, never an untroubled reading.
  const gauge = (n: number | null, red: number, amber: number): Level =>
    n === null ? "warn" : n > red ? "danger" : n > amber ? "warn" : "ok";
  return [
    {
      id: "cpu",
      level: gauge(cpu, c.pressureRed, c.pressureAmber),
      consumer: laneOrNone(top),
      values: {
        // The stall percentage the level grades on, so the meter shows its cause.
        system: cpu,
        agents: sliceSum(s.groups, c.agentSlice, (g) => g.cpuPercent),
        desktop: sliceSum(s.groups, c.desktopSlice, (g) => g.cpuPercent),
        top: top?.cpu ?? null,
      },
    },
    {
      id: "memory",
      level: gauge(swap, c.swapFloor, c.swapFloor),
      consumer: consumerName(largest, s),
      holder: swapped ? consumerName(holder, s) : undefined,
      values: {
        used: total === null || available === null ? null : total - available,
        total,
        cache: sliceSum(s.groups, c.agentSlice, (g) => g.cache),
        swap,
        largest: largest?.memory ?? null,
        holderSwap: swapped ? (holder?.swap ?? null) : null,
      },
    },
    {
      id: "disk",
      level: gauge(io, c.pressureRed, c.pressureAmber),
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
      level: gauge(load.builds, s.system.cores * 2, s.system.cores),
      consumer: laneOrNone(top),
      values: {
        builds: load.builds,
        linkers: load.linkers,
        cores: s.system.cores,
        lanes: load.lanes,
      },
    },
  ];
}
