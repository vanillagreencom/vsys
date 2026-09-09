import type { Lane, Snapshot } from "../model/types";

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
    rss: 0,
    cache: null,
    swap: null,
    readRate: null,
    writeRate: null,
    tasks: 0,
    rustc: 0,
    cargo: 0,
    tests: 0,
    builds: {},
    linkers: 0,
    sccache: 0,
    memoryMax: null,
    memoryMaxKnown: false,
    cpuWeight: null,
    jobs: null,
    jobserver: null,
    age: 0,
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
  return { ...laneUnknowns(), ...stored };
}
/**
 * One step on the load path, so no screen reads a field a stored record never
 * carried. It is idempotent: a snapshot of the current shape passes through.
 */
export function normalizeSnapshot(s: Snapshot): Snapshot {
  return {
    ...s,
    // A build older than the capability probe recorded no capabilities. An
    // empty list is the unknown value: no reading claims a missing interface.
    capabilities: s.capabilities ?? [],
    lanes: (s.lanes ?? []).map(normalizeLane),
  };
}
