import { compileOrLink } from "../collect/builds";
import type { CollectionConfig } from "../collect/settings";
import type { Config } from "../config/config";
import { damageCounts, integrities } from "./integrity";
import { coveringGroup, inSlice, lanePressure, sliceCompared } from "./lanes";
import { laneText, unitLabel } from "./naming";
import type { Group, Lane, Proc, ScratchRoot, Snapshot, Volume } from "./types";

export type Level = "ok" | "warn" | "danger";
/** Every cause is detected once. The verdict, the meters and the cards read it. */
export type CauseId =
  | "unconfined"
  | "read-only"
  | "damaged-files"
  | "new-errors"
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
  | "unchecked"
  | "integrity-unknown"
  | "scratch"
  | "unconfirmed-tool";
/**
 * The order that breaks a tie between two causes of one severity, worst first.
 * The ladder sorts by it, and anything ranking a cause the ladder is not
 * currently reporting reads the same table rather than a live position. The
 * record covers the union, so a new cause cannot be added without a rank.
 */
export const causeOrder: Record<CauseId, number> = {
  unconfined: 0,
  "read-only": 1,
  "damaged-files": 2,
  "new-errors": 3,
  "device-errors": 4,
  disk: 5,
  "desktop-swap": 6,
  "free-space": 7,
  "memory-cap": 8,
  stalls: 9,
  "system-memory": 10,
  "system-cpu": 11,
  "memory-high": 12,
  scrub: 13,
  unchecked: 14,
  "integrity-unknown": 15,
  "unconfirmed-tool": 16,
  scratch: 17,
};
export function causeRank(id: CauseId): number {
  return causeOrder[id];
}
/**
 * How a cause's evidence behaves between samples. A `level` cause is a reading
 * that stays while the condition does, so it must hold before it alerts and a
 * value crossing a threshold for one sample records nothing. An `event` cause
 * is evidence that is itself a change: a counter delta is non-zero for exactly
 * the one sample after the increment, so a hold would drop every one of them.
 * The record covers the union, so a new cause cannot be added without saying
 * which it is.
 */
export const causeEvidence: Record<CauseId, "level" | "event"> = {
  unconfined: "level",
  "read-only": "level",
  "damaged-files": "level",
  "new-errors": "level",
  "device-errors": "event",
  disk: "level",
  "desktop-swap": "level",
  "free-space": "level",
  "memory-cap": "level",
  stalls: "level",
  "system-memory": "level",
  "system-cpu": "level",
  "memory-high": "level",
  // A report stays on disk until the next check replaces it, so the hold
  // delays its alert and never drops it, and a report that failed to read
  // once does not open an alert on its own.
  scrub: "level",
  unchecked: "level",
  "integrity-unknown": "level",
  scratch: "level",
  "unconfirmed-tool": "level",
};
/**
 * Where a cause points the reader. This is not a subject: a cause about a
 * machine-wide stall names the scope worth opening without claiming that scope
 * is one of the things that went wrong. Nothing here ever becomes an alert.
 */
export type CauseAt =
  | { kind: "lane"; id: string }
  | { kind: "group"; path: string }
  | { kind: "path"; path: string };
/**
 * One damaged filesystem's own files/unnamed/blocks counts, kept apart from
 * every other aggregated filesystem's. A filesystem damaged only by a
 * remembered finished check has no address data of its own and reads null
 * here; that must never erase another, readable filesystem's own counts the
 * way summing them together once did.
 */
export interface DamageFigures {
  files: number | null;
  unnamed: number | null;
  blocks: number | null;
}
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
  /**
   * Processes this cause is about that named no lane and no group, because
   * becoming one is exactly what the cause says did not happen.
   */
  procs: Proc[];
  /** Where the card lands, when that row is not one of the subjects above. */
  at?: CauseAt;
  /** The single biggest consumer behind the cause, empty when there is none. */
  consumer: string;
  /** The numbers behind the cause. Formatting belongs to the UI. */
  values: Record<string, number | null>;
  /**
   * The damaged-files cause's own per-filesystem figures, one per entry of
   * `paths` in the same order. Every other cause leaves this empty.
   */
  damage: DamageFigures[];
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
function covers(group: Group, path: string): boolean {
  return (
    group.path === "." ||
    group.path === path ||
    path.startsWith(`${group.path}/`)
  );
}
/** Cgroup counters include descendants, so only outer groups contribute. */
function groupRoots(groups: Group[]): Group[] {
  return groups.filter(
    (g) => !groups.some((parent) => parent !== g && covers(parent, g.path)),
  );
}
/** A slice name can appear at more than one path; nested copies are not summed. */
export function sliceRoots(groups: Group[], name: string): Group[] {
  return groupRoots(groups.filter((g) => g.name === name));
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
/** A lane running a configured agent tool, the one definition of "agent lane". */
export function agentLanes(lanes: Lane[]): Lane[] {
  return lanes.filter((l) => l.tool !== "");
}
/**
 * What agents use of one reading. Where the agent slice is compared it holds
 * every agent, so its own counter is the total. Where the probe found no slice
 * measured agent groups contribute once per subtree. Uncovered lanes contribute
 * their own process sums, and an uncovered unknown keeps the total unknown.
 * A process the sample could not read may
 * have been an agent, so any such process leaves the total unknown rather than
 * short by an agent nobody can see.
 */
export function agentTotal(
  s: Snapshot,
  c: Pick<CollectionConfig, "agentSlice" | "procRoot">,
  reading: "cpu" | "cache",
): number | null {
  if (sliceCompared(s.capabilities))
    return sliceSum(s.groups, c.agentSlice, (g) =>
      reading === "cpu" ? g.cpuPercent : g.cache,
    );
  if (s.processRead !== "complete") return null;
  const agents = agentLanes(s.lanes);
  const groups = new Map(s.groups.map((g) => [g.path, g]));
  const pick = (g: Group) => (reading === "cpu" ? g.cpuPercent : g.cache);
  const paths = new Set(agents.map((l) => l.cgroup));
  const measured = groupRoots(
    s.groups.filter((g) => paths.has(g.path) && pick(g) !== null),
  );
  const uncovered = agents.filter((l) => {
    const group = groups.get(l.cgroup) ?? coveringGroup(s.groups, l.cgroup);
    return !group || !measured.some((root) => covers(root, group.path));
  });
  return uncovered.every((l) => l[reading] !== null)
    ? measured.reduce((sum, g) => sum + (pick(g) ?? 0), 0) +
        uncovered.reduce((sum, l) => sum + (l[reading] ?? 0), 0)
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
): { builds: number | null; linkers: number | null; lanes: number | null } {
  if (s.processRead !== "complete")
    return { builds: null, linkers: null, lanes: null };
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
export function laneLinkers(s: Snapshot, lane: Lane, c: Config): number | null {
  if (lane.builds === null) return null;
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
 * How one cause stands on one subject this sample: its input read over the
 * threshold, read under it, or not read at all. A cause that is absent and a
 * cause that could not be judged look alike on the ladder, which raises
 * neither, so anything that acts on a cause going away reads this instead.
 */
type Judged = "fired" | "absent" | "unjudged";
/**
 * Fired when any reading taken crosses, since an unread one cannot undo it.
 * Otherwise a reading not taken might have crossed, so the cause is unjudged.
 */
function judge(
  readings: readonly (number | null)[],
  fires: (n: number) => boolean,
): Judged {
  if (readings.some((n) => n !== null && fires(n))) return "fired";
  return readings.includes(null) ? "unjudged" : "absent";
}
interface Judgment<T> {
  subject: T;
  judged: Judged;
}
/** An unread limit cannot clear an alert; a measured unlimited limit can. */
export function memoryHighJudgments(groups: Group[]): Judgment<Group>[] {
  return groups.map((group) => {
    const high = group.high;
    return {
      subject: group,
      judged: !group.highRead
        ? "unjudged"
        : high === null
          ? "absent"
          : judge([group.memory], (n) => n >= high * 0.9),
    };
  });
}
/** The causes judged on one host reading, so an unread one covers every subject. */
const hostCauses = [
  "disk",
  "desktop-swap",
  "system-memory",
  "system-cpu",
] as const satisfies readonly CauseId[];
type HostCause = (typeof hostCauses)[number];
/**
 * The one pass over every reading a cause can fail to take. `causes()` raises
 * what fired and `unjudged()` reports what could not be read, so the two can
 * never disagree about which reading decided a cause.
 */
interface Judgments {
  io: number | null;
  cpu: number | null;
  memory: number | null;
  swap: number | null;
  writer: Group | undefined;
  host: Record<HostCause, Judged>;
  stalls: Judgment<Lane>[];
  "memory-high": Judgment<Group>[];
  "free-space": Judgment<Volume>[];
  scratch: Judgment<ScratchRoot>[];
}
function judgments(s: Snapshot, c: Config): Judgments {
  const io = s.system.pressure.io?.some ?? null;
  const cpu = s.system.pressure.cpu?.some ?? null;
  const memory = s.system.pressure.memory?.some ?? null;
  const swap = sliceSum(s.groups, c.desktopSlice, (g) => g.swap);
  const writer = topWriter(s.groups);
  return {
    io,
    cpu,
    memory,
    swap,
    writer,
    host: {
      disk: judge([io], (n) => n > c.pressureAmber && writer !== undefined),
      // A slice the sample holds no root of has no swap left to judge: it is
      // gone, not unread. A root is matched by name, so one the cgroup root
      // points at, at path ".", counts.
      "desktop-swap": sliceRoots(s.groups, c.desktopSlice).length
        ? judge([swap], (n) => n > c.swapFloor)
        : "absent",
      "system-memory": judge([memory], (n) => n > c.pressureRed),
      "system-cpu": judge([cpu], (n) => n > c.pressureRed),
    },
    // Each resource's pressure is read on its own, so one that failed leaves
    // the stall unjudged unless another already crossed.
    stalls: s.lanes.map((lane) => ({
      subject: lane,
      judged: judge(
        [lane.pressure, lane.memoryPressure, lane.ioPressure],
        (n) => n > c.pressureAmber,
      ),
    })),
    "memory-high": memoryHighJudgments(s.groups),
    "free-space": s.storage.volumes.map((volume) => ({
      subject: volume,
      judged: judge([volume.free], (n) => n < c.freeFloor),
    })),
    scratch: s.storage.scratch.map((root) => ({
      subject: root,
      judged: judge([root.bytes], (n) => n > c.scratchQuota),
    })),
  };
}
const where = <T>(rows: Judgment<T>[], judged: Judged): T[] =>
  rows.filter((row) => row.judged === judged).map((row) => row.subject);
/**
 * The subjects each cause could not judge this sample, by the identifier an
 * alert about it carries: the host as the empty id, a lane id, a group path
 * or a storage path. A host cause whose reading failed covers every subject
 * the sample holds, and a lane listed under one is judged by that reading
 * alone. A subject the sample no longer holds is never here: it is gone, not
 * unread.
 */
export type Unjudged = Partial<Record<CauseId, ReadonlySet<string>>>;
export function unjudged(s: Snapshot, c: Config): Unjudged {
  const j = judgments(s, c);
  const held = [
    "",
    ...s.lanes.map((lane) => lane.id),
    ...s.groups.map((group) => group.path),
  ];
  const subjects: [CauseId, string[]][] = [
    ["stalls", where(j.stalls, "unjudged").map((lane) => lane.id)],
    ["memory-high", where(j["memory-high"], "unjudged").map((g) => g.path)],
    ["free-space", where(j["free-space"], "unjudged").map((v) => v.mount)],
    ["scratch", where(j.scratch, "unjudged").map((root) => root.path)],
  ];
  for (const id of hostCauses)
    if (j.host[id] === "unjudged") subjects.push([id, held]);
  const out: Unjudged = {};
  for (const [id, ids] of subjects) if (ids.length) out[id] = new Set(ids);
  return out;
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
      procs: [],
      consumer: "",
      values: {},
      damage: [],
      verdictWorthy: true,
      ...rest,
    });
  const j = judgments(s, c);
  const { io, cpu, memory, swap, writer } = j;
  // A lane stalling on a resource a specific cause reports belongs to that
  // card, so one contention never produces two cards.
  const diskFired = j.host.disk === "fired";
  const cpuFired = j.host["system-cpu"] === "fired";
  const memoryFired = j.host["system-memory"] === "fired";
  const covered = new Set<Kind>();
  if (diskFired) covered.add("io");
  if (cpuFired) covered.add("cpu");
  if (memoryFired) covered.add("memory");
  const stalling = where(j.stalls, "fired");
  const owned = (kind: Kind) => stalling.filter((l) => worstKind(l) === kind);
  const loose = stalling.filter((l) => {
    const kind = worstKind(l);
    return kind === null || !covered.has(kind);
  });
  const escaped = s.lanes.filter((l) => l.unconfined);
  const [firstEscaped] = escaped;
  if (firstEscaped)
    add("unconfined", "danger", {
      lanes: escaped,
      consumer: laneText(firstEscaped),
      values: { lanes: escaped.length },
    });
  const readOnly = s.storage.volumes.filter((v) => v.readOnly);
  const [firstReadOnly] = readOnly;
  if (firstReadOnly)
    add("read-only", "danger", {
      paths: readOnly.map((v) => v.mount),
      consumer: firstReadOnly.mount,
    });
  // One reading per filesystem, shared by the damage card, the unchecked card
  // and Storage, so the three never disagree about one filesystem's state.
  const filesystems = integrities(s, c);
  const damaged = filesystems.filter((item) => item.state === "damaged");
  const [firstDamaged] = damaged;
  if (firstDamaged) {
    // Each filesystem keeps its own files/unnamed/blocks figures, in `paths`
    // order, rather than being summed into one total: a filesystem whose
    // damage is known only from a remembered check (no address data of its
    // own) must read as unknown on its own account, never erase a readable
    // filesystem's own counts by sharing one all-or-nothing total with it.
    const damage: DamageFigures[] = damaged.map((item) => {
      const n = damageCounts(item);
      return {
        files: n.files,
        unnamed:
          n.unnamed === null || n.unresolved === null
            ? null
            : n.unnamed + n.unresolved,
        blocks: item.blocks,
      };
    });
    add("damaged-files", "danger", {
      paths: damaged.map((item) => item.mounts[0] ?? item.device),
      // The card opens the filesystem's integrity row, which is not one of
      // the mounts it names: the damage belongs to the filesystem.
      at: { kind: "path", path: firstDamaged.id },
      consumer: firstDamaged.mounts[0] ?? firstDamaged.device,
      damage,
      values: { filesystems: damaged.length },
    });
  }
  // The counter grew, or the kernel logged a failed read, and nothing has read
  // the filesystem since, so no check has confirmed what that cost. This is
  // the reading that was missing.
  const grown = filesystems.filter((item) => item.state === "new-errors");
  const [firstGrown, ...moreGrown] = grown;
  if (firstGrown) {
    // Only an error `integrity()` judged new is named. The card says nothing
    // has read the filesystem since, which an older one, or growth the last
    // check itself accounts for, would contradict.
    add("new-errors", "danger", {
      paths: grown.map((item) => item.mounts[0] ?? item.device),
      at: { kind: "path", path: firstGrown.id },
      consumer: firstGrown.mounts[0] ?? firstGrown.device,
      // One filesystem's numbers describe one filesystem. Naming several and
      // showing the first one's growth would present its count and its ages
      // as the whole cause's.
      values:
        moreGrown.length === 0
          ? {
              filesystems: 1,
              size: firstGrown.growthNew ? firstGrown.errorSize : null,
              since: firstGrown.growthNew ? firstGrown.growthAge : null,
              logged: firstGrown.loggedNew ? firstGrown.loggedAge : null,
              checked: firstGrown.checkAge,
            }
          : {
              filesystems: grown.length,
              size: null,
              since: null,
              logged: null,
              checked: null,
            },
    });
  }
  const failing = s.storage.volumes.filter((v) =>
    Object.values(v.delta).some((n) => n > 0),
  );
  const [firstFailing] = failing;
  if (firstFailing)
    add("device-errors", "danger", {
      paths: failing.map((v) => v.mount),
      consumer: firstFailing.device,
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
  if (j.host["desktop-swap"] === "fired")
    add("desktop-swap", "danger", {
      groups: swapHolder ? [swapHolder] : [],
      consumer: holderName,
      values: {
        swap,
        holder: swapHolder?.swap ?? null,
        cache: agentTotal(s, c, "cache"),
      },
    });
  const low = where(j["free-space"], "fired");
  const free = leastFree(low);
  if (free)
    add("free-space", "danger", {
      paths: low.map((volume) => volume.mount),
      consumer: free.mount,
      values: { free: free.free, total: free.total },
    });
  const capped = s.lanes.filter((l) => l.dangerous);
  const [firstCapped] = capped;
  if (firstCapped)
    add("memory-cap", "danger", {
      lanes: capped,
      consumer: laneText(firstCapped),
      values: { lanes: capped.length, floor: c.memoryFloor },
    });
  const [firstLoose] = loose;
  if (firstLoose) {
    const worst = Math.max(...loose.map((l) => lanePressure(l) ?? 0));
    add("stalls", worst > c.pressureRed ? "danger" : "warn", {
      lanes: loose,
      consumer: laneText(firstLoose),
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
  const near = where(j["memory-high"], "fired");
  const [firstNear] = near;
  if (firstNear)
    add("memory-high", "warn", {
      groups: near,
      consumer: firstNear.name,
      verdictWorthy: false,
    });
  // A report the damage card already speaks for is not a second card: it names
  // the filesystem and the files, where this one can only name a file path.
  const spoken = new Set(
    damaged.flatMap((item) => (item.scrub ? [item.scrub.path] : [])),
  );
  const scrubs = s.storage.scrubs.filter(
    (scrub) => scrub.problem && !spoken.has(scrub.path),
  );
  const [firstScrub] = scrubs;
  if (firstScrub)
    add("scrub", "danger", {
      paths: scrubs.map((scrub) => scrub.path),
      consumer: firstScrub.path,
    });
  // A filesystem nothing has checked cannot report that it is undamaged, so
  // silence about it is the reading this card refuses to give.
  const unchecked = filesystems.filter(
    (item) => item.state === "never-checked" || item.state === "stale",
  );
  const [firstUnchecked] = unchecked;
  if (firstUnchecked)
    add("unchecked", "warn", {
      paths: unchecked.map((item) => item.mounts[0] ?? item.device),
      at: { kind: "path", path: firstUnchecked.id },
      consumer: firstUnchecked.mounts[0] ?? firstUnchecked.device,
      values: {
        filesystems: unchecked.length,
        never: unchecked.filter((item) => item.state === "never-checked")
          .length,
        oldest: Math.max(...unchecked.map((item) => item.checkAge ?? 0)),
        limit: c.scrubMaxAgeDays,
      },
    });
  // A filesystem whose state vsys could not read is not one it can pass over
  // in silence: Storage says the state is unknown, and so must the verdict.
  const opaque = filesystems.filter((item) => item.state === "unknown");
  const [firstOpaque] = opaque;
  if (firstOpaque)
    add("integrity-unknown", "warn", {
      paths: opaque.map((item) => item.mounts[0] ?? item.device),
      at: { kind: "path", path: firstOpaque.id },
      consumer: firstOpaque.mounts[0] ?? firstOpaque.device,
      values: { filesystems: opaque.length },
    });
  const large = where(j.scratch, "fired");
  const [firstLarge] = large;
  if (firstLarge)
    add("scratch", "warn", {
      paths: large.map((scratch) => scratch.path),
      consumer: firstLarge.path,
      verdictWorthy: false,
      values: {
        largest: Math.max(...large.map((scratch) => scratch.bytes ?? 0)),
        quota: c.scratchQuota,
      },
    });
  // A name a process carries that its tool's install locations did not
  // confirm never became a lane, so this is the one place it is still
  // visible: nowhere on Agents names a process the collector left out.
  const unconfirmed = s.procs.filter((proc) => proc.unconfirmedTool);
  const [firstUnconfirmed] = unconfirmed;
  if (firstUnconfirmed)
    add("unconfirmed-tool", "warn", {
      procs: unconfirmed,
      consumer: firstUnconfirmed.unconfirmedTool ?? "",
      verdictWorthy: false,
      values: { processes: unconfirmed.length },
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
        agents: agentTotal(s, c, "cpu"),
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
        cache: agentTotal(s, c, "cache"),
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
