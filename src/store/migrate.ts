import { memberless } from "../model/lanes";
import { unitLabel } from "../model/naming";
import type { Lane, Sccache, Snapshot } from "../model/types";
import type { TimelineEvent } from "./events";
import type { Point } from "./point";

/**
 * A stored snapshot was written by whichever build was running at the time.
 * A newer build reads records that predate the fields it now expects, so the
 * unknown value for every field of the current shape is written here once.
 */
function laneUnknowns(): Lane {
  return {
    id: "",
    name: "",
    account: null,
    pane: "",
    address: "",
    window: "",
    elsewhere: false,
    self: "unknown",
    title: "",
    cwd: "",
    branch: "",
    tool: "",
    cgroup: "",
    mainPid: 0,
    pids: [],
    cpu: null,
    cpuShare: null,
    pressure: null,
    memoryPressure: null,
    ioPressure: null,
    rss: null,
    cache: null,
    swap: null,
    readRate: null,
    writeRate: null,
    tasks: 0,
    rustc: null,
    cargo: null,
    tests: null,
    builds: null,
    linkers: null,
    sccache: null,
    memoryMax: null,
    memoryMaxKnown: false,
    cpuWeight: null,
    jobs: null,
    jobserver: null,
    age: null,
    state: "",
    blocked: 0,
    blockedOn: null,
    unconfined: false,
    dangerous: false,
  };
}
/**
 * Fill the fields a stored lane predates. A fresh object per lane keeps two
 * historical lanes from sharing one build table.
 */
export function normalizeLane(stored: Partial<Lane>): Lane {
  const lane = { ...laneUnknowns(), ...stored };
  return memberless(stored.mainPid) ? { ...lane, rss: null, age: null } : lane;
}
/** A cache reading as a build before the query outcome stored it. */
type StoredSccache = Omit<Sccache, "state"> & { available: boolean };
/**
 * A stored flag said only whether counters were read. Counters read is the
 * read state; a reading without them cannot tell a missing program from a
 * failed query, so it becomes no reading rather than either cause.
 */
function normalizeSccache(
  stored: Sccache | StoredSccache | undefined,
): Sccache | undefined {
  if (stored === undefined || "state" in stored) return stored;
  const { available, ...counters } = stored;
  return available ? { state: "read", ...counters } : undefined;
}
/**
 * One step on the load path, so no screen reads a field a stored record never
 * carried. It is idempotent: a snapshot of the current shape passes through.
 */
export function normalizeSnapshot(s: Snapshot): Snapshot {
  const { sccache: stored, ...rest } = s;
  const sccache = normalizeSccache(stored);
  return {
    ...rest,
    ...(sccache ? { sccache } : {}),
    // A build older than the capability probe recorded no capabilities. An
    // empty list is the unknown value: no reading claims a missing interface.
    capabilities: s.capabilities ?? [],
    processRead: s.processRead ?? "unknown",
    groups: s.groups.map((group) => ({
      ...group,
      // Older collectors stored numbers only after a successful read.
      highRead: group.highRead ?? typeof group.high === "number",
      swapMaxRead: group.swapMaxRead ?? typeof group.swapMax === "number",
      tasksMaxRead: group.tasksMaxRead ?? typeof group.tasksMax === "number",
    })),
    lanes: (s.lanes ?? []).map((lane) => {
      if (s.processRead !== undefined) return normalizeLane(lane);
      const group = s.groups.find(
        (g) => g.path === lane.cgroup || g.kernelPath === lane.cgroup,
      );
      return normalizeLane({
        ...lane,
        rss: null,
        cpu: group?.cpuPercent ?? null,
        cpuShare:
          group?.cpuPercent == null || s.system.cores <= 0
            ? null
            : group.cpuPercent / s.system.cores,
        swap: group?.swap ?? null,
        tasks: group?.tasks ?? null,
        builds: null,
        rustc: null,
        cargo: null,
        tests: null,
        linkers: null,
        sccache: null,
      });
    }),
    storage: {
      ...s.storage,
      // A build older than root origins stored rows with none. Null is the
      // unknown value: the row is drawn with no origin word.
      //
      // A build older than the nullable age wrote a failed root's age as a
      // synthetic 0 rather than unknown. That root never carried a size or a
      // modification time either, which no successful reading leaves null,
      // so the same shape identifies it here.
      scratch: s.storage.scratch.map((root) => ({
        ...root,
        origin: root.origin ?? null,
        age: root.bytes === null && root.modifiedAt == null ? null : root.age,
      })),
      // A build older than lifetime-write sources stored device rows with
      // none. Null is the unknown value: the row names no source.
      ...(s.storage.devices
        ? {
            devices: s.storage.devices.map((device) => ({
              ...device,
              source: device.source ?? null,
            })),
          }
        : {}),
    },
  };
}
/** The event kinds whose subject can be a cgroup, and so can be a raw unit. */
const cgroupSubject = new Set(["alert-open", "alert-close", "verdict"]);
/**
 * Whether this stored event provably carries a cgroup's own unit name as its
 * subject, rather than merely looking like one.
 *
 * A unit suffix is a shape. Lane names come from a branch, a configured value
 * or a worktree basename, and mount paths are whatever the disk is mounted at,
 * so a subject ending in `.scope` says nothing about where the string came
 * from. Two facts about the record do:
 *
 * - The store writes a unit on every one of these kinds, empty included, so an
 *   event missing the field was written before the field existed.
 * - `collectGroups` builds a group's name as the last segment of its path, and
 *   that path is what the subject's identity is. A subject equal to the last
 *   segment of its own cgroup-path identity is therefore that group's unit.
 *
 * A mount path is absolute and a lane's display name is chosen elsewhere, so
 * neither satisfies the second by construction. What stays inferential is a
 * lane whose display name happens to equal the last segment of its own cgroup
 * path; that record is still rewritten. An alert on a cgroup directly under
 * the root, and the fallback subject that carries no identity of its own, are
 * left as written rather than decoded, which is the safe direction to miss in.
 */
function storedRawUnit(e: TimelineEvent): boolean {
  if (!cgroupSubject.has(e.kind) || e.names?.unit !== undefined) return false;
  const id = e.subjectId ?? "";
  return (
    id.includes("/") &&
    !id.startsWith("/") &&
    id.split("/").at(-1) === e.subject
  );
}
/**
 * Fill the fields a stored point predates. A build before `consumerName()`
 * reached the event store wrote a cgroup subject as systemd's own name, with
 * no unit beside it. Those points stay in the ring for a whole retention
 * window after an upgrade, so without this step a `.scope` handle keeps
 * reaching Home and the Timeline for `historyHours` after the code that could
 * produce one is gone.
 *
 * The old subject was the unit, so it becomes the unit and the decoded name
 * takes its place: the same two values the store records today. Every other
 * event passes through untouched, which also makes the step idempotent, since
 * a decoded event carries the unit that excludes it.
 */
export function normalizePoint(p: Point): Point {
  if (!p.events?.length) return p;
  return {
    ...p,
    events: p.events.map((e) =>
      storedRawUnit(e)
        ? {
            ...e,
            subject: unitLabel(e.subject),
            names: { ...e.names, unit: e.subject },
          }
        : e,
    ),
  };
}
