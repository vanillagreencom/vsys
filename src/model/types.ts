/** A source failure is visible in snapshots and the dashboard. */
export interface SourceError {
  source: string;
  message: string;
}
/** Pressure stall information, in percent and microseconds. */
export interface Pressure {
  some: number;
  full: number | null;
  total: number;
}
/** Cgroup v2 limits use null for the kernel's unlimited value. */
export interface Group {
  path: string;
  kernelPath?: string;
  parent: string;
  name: string;
  pids: number[];
  cpuUsec: number;
  cpuPercent: number | null;
  weight: number | null;
  cpuMax: string | null;
  memory: number | null;
  high: number | null;
  /** memory.max is null for the word max; maxRead separates that from an unread file. */
  max: number | null;
  maxRead: boolean;
  swap: number | null;
  swapMax: number | null;
  tasks: number | null;
  tasksMax: number | null;
  /** Page cache from memory.stat; io.stat totals since boot and their rates. */
  cache: number | null;
  ioRead: number | null;
  ioWrite: number | null;
  readRate: number | null;
  writeRate: number | null;
  pressure: Record<string, Pressure | null>;
}
/** Only the selected environment fields leave the process collector. */
export interface Proc {
  pid: number;
  ppid: number;
  start: number;
  comm: string;
  command: string[];
  executable: string | null;
  cwd: string | null;
  group: string;
  state: string;
  threads: number;
  rss: number;
  swap: number | null;
  ticks: number;
  cpuPercent: number | null;
  age: number;
  env: Record<string, string>;
  envAvailable?: boolean;
  branch: string | null;
  tool: string | null;
  build: string | null;
}
/** Filesystem counters stay keyed by filesystem and device. */
export interface Volume {
  mount: string;
  device: string;
  fsid: string | null;
  options: string[];
  readOnly: boolean;
  free: number | null;
  total: number | null;
  errors: Record<string, number>;
  delta: Record<string, number>;
  sinceStart: Record<string, number>;
  countersAvailable?: boolean;
}
export interface Scratch {
  path: string;
  bytes: number | null;
  age: number;
  modifiedAt?: number | null;
  error: string | null;
}
export interface Scrub {
  path: string;
  text: string;
  problem: boolean;
}
/** A block device with its lifetime writes, when SMART output is readable. */
export interface Device {
  name: string;
  /** Kernel device number "MAJ:MIN", the key io.stat writes are counted under. */
  number: string | null;
  model: string | null;
  lifetimeWritten: number | null;
}
export interface Storage {
  mountsAvailable?: boolean;
  /** Bytes written since boot per device number, read at the cgroup v2 root. */
  deviceWrites?: Record<string, number> | null;
  devices?: Device[];
  volumes: Volume[];
  scratch: Scratch[];
  sessions: Scratch[];
  scrubs: Scrub[];
  scratchTime?: number | null;
  scratchPending?: boolean;
}
/** Counters observed over the window vsys actually watched. */
export interface SccacheDelta {
  hits: number;
  misses: number;
  windowMs: number;
}
/** sccache counters. An unreadable server stays distinguishable from zero work. */
export interface Sccache {
  available: boolean;
  hits: number | null;
  misses: number | null;
  sinceStart: SccacheDelta | null;
  recent: SccacheDelta | null;
}
export interface System {
  host: string;
  cores: number;
  load: number[];
  uptime: number;
  memory: Record<string, number>;
  pressure: Record<string, Pressure | null>;
  zram: {
    device: string;
    original: number;
    compressed: number;
    used: number;
  }[];
}
export interface Lane {
  id: string;
  name: string;
  /** An unreadable environment leaves the account unknown, never "default". */
  account: string | null;
  /** tmux pane address and window title, empty when the pane exported none. */
  pane: string;
  /**
   * The address a reader can type, `session:window.pane`. A `%N` handle is
   * resolved to one by the server; anything else the pane exported is already
   * an address and stands as it is, with no window name, which only the
   * server holds. Empty when a handle resolved to nothing: no tmux, no server
   * answering, the pane gone, or the handle belonging to another server. It
   * is never a reading of whether tmux is there, because a configured address
   * fills it with no tmux at all. The lane still acts through the raw `pane`
   * handle, which never changes.
   */
  address: string;
  window: string;
  /**
   * The pane belongs to a tmux server this vsys is not talking to, so its
   * handle names a different pane here. True only when both servers are known
   * and differ.
   */
  elsewhere: boolean;
  /**
   * Whether this lane's pane is the pane vsys is drawing in. Reading that one
   * would show vsys's own screen inside itself, one copy deeper on every
   * sample, and switching to it would move a reader who is already there.
   *
   * Three answers, because vsys cannot always find out and an answer it
   * cannot give read as `no` opens the capture this exists to close. Only `no`
   * permits a read, a switch or a copied command. Matched on the `%N` handle
   * and on the resolved address alike, since a lane carries whichever its own
   * environment held; the address is the form vsys can fail to decide, because
   * only the pane map says which pane an address names.
   */
  self: "yes" | "no" | "unknown";
  title: string;
  cwd: string;
  branch: string;
  tool: string;
  /** The cgroup this lane's work is charged to. */
  cgroup: string;
  mainPid: number;
  pids: number[];
  cpu: number | null;
  /** The lane's CPU as a share of the machine, in percent of all cores. */
  cpuShare: number | null;
  pressure: number | null;
  memoryPressure: number | null;
  ioPressure: number | null;
  rss: number;
  /** Page cache the kernel charges to this lane's cgroup. */
  cache: number | null;
  swap: number | null;
  readRate: number | null;
  writeRate: number | null;
  tasks: number;
  rustc: number;
  cargo: number;
  tests: number;
  /** Every build process in the lane counted by its kind. */
  builds: Record<string, number>;
  linkers: number;
  sccache: number;
  /**
   * Effective caps: the tightest limit any ancestor imposes. A null cap is
   * unlimited only while the cgroup tree covering the lane was read.
   */
  memoryMax: number | null;
  memoryMaxKnown: boolean;
  cpuWeight: number | null;
  jobs: number | null;
  jobserver: string | null;
  age: number;
  state: string;
  /** Tasks in uninterruptible wait, and the resource they wait on. */
  blocked: number;
  blockedOn: "io" | "memory" | null;
  unconfined: boolean;
  dangerous: boolean;
}
export type Rule =
  | "unconfined"
  | "memory-cap"
  | "btrfs-ro"
  | "btrfs-errors"
  | "scrub"
  | "memory-high"
  | "pressure"
  | "scratch";
export interface Alert {
  time: number;
  rule: Rule;
  subject: string;
  message: string;
}
/** A kernel or system interface the dashboard needs to fill a reading. */
export type CapabilityId =
  | "cgroup2"
  | "delegation"
  | "psi"
  | "io-stat"
  | "scrub"
  | "smart"
  | "tmux";
/**
 * Why a source could not be used. The kinds are distinct diagnoses: a kernel
 * that never built the interface, a file the user cannot read, a file that did
 * not parse, and an interface present but not giving what a reading needs.
 */
export type CapabilityFailure =
  | "absent"
  | "unreadable"
  | "malformed"
  | "incomplete";
/** Probed once when vsys starts; absence is a known limit, not a read failure. */
export interface Capability {
  id: CapabilityId;
  available: boolean;
  /** Null while the capability is available. */
  failure: CapabilityFailure | null;
  /** The file or directory that decided it. */
  source: string;
  /** The system's own words when a read failed, or the values that decided it. */
  detail: string;
}
/** A complete sample carries failures rather than converting them to zero. */
export interface Snapshot {
  capabilities: Capability[];
  time: number;
  durationMs: number;
  system: System;
  groups: Group[];
  procs: Proc[];
  storage: Storage;
  lanes: Lane[];
  alerts: Alert[];
  errors: SourceError[];
  /** Absent in snapshots recorded before the build-cache reading existed. */
  sccache?: Sccache;
}
