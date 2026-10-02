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
  /**
   * A configured agent name this process carries that its tool's install
   * locations did not confirm, so it is not an agent. Absent in snapshots
   * recorded before vsys checked where a tool was installed.
   */
  unconfirmedTool?: string | null;
  /**
   * The one path `unconfirmedTool` was tested against: the executable for a
   * name match, the script for a scripted match. Null alongside a null
   * `unconfirmedTool`, and also where `unconfirmedTool` is set but vsys could
   * not read the script of a name with no configured install location, a
   * read failure that never drops the process or the name it carries.
   * Absent in snapshots recorded before vsys carried it, even where
   * `unconfirmedTool` is set.
   */
  unconfirmedPath?: string | null;
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
  /**
   * When the filesystem's corruption counter last grew, remembered across the
   * history window and across restarts. Null while vsys has never seen it
   * grow, which is not the same as no damage.
   */
  lastErrorAt?: number | null;
  /** How far the counter grew then. */
  lastErrorSize?: number | null;
  /**
   * False where the record of past growth could not be read, so a null
   * `lastErrorAt` is a reading vsys does not have rather than one of none.
   */
  lastErrorKnown?: boolean;
}
export interface Scratch {
  path: string;
  bytes: number | null;
  age: number;
  modifiedAt?: number | null;
  error: string | null;
}
/**
 * Where a scratch root came from: a list other than the shipped one, the
 * shipped list (omitted from `config.toml` or pinned there unchanged), or the
 * temporary directory a running agent names in its environment.
 */
export type ScratchOrigin = "configured" | "default" | "agent";
/**
 * A measured scratch root and the reason vsys measured it. A row a build
 * stored before roots carried an origin reads null: that build measured only
 * the settings list, and whether the list was the default is not recorded.
 */
export interface ScratchRoot extends Scratch {
  origin: ScratchOrigin | null;
}
/**
 * One damaged block address from a scrub report, with every path it is
 * reachable under. The address is the unit of damage, not the file: on some
 * kernels it is only the start of the 64 KiB block the check could not
 * repair, so a path under it is possibly damaged, the damaged file may not be
 * under it, and one extent can carry several names.
 * No path and no not-resolved mark is an older report's free space or file
 * already deleted; the shipped reporter marks every no-extent answer.
 */
export interface DamagedAddress {
  logical: number;
  paths: string[];
  /**
   * False where the reporter could not name every file the address belongs
   * to, so the address lists none. Absent in a report that predates the
   * mark, which named what it resolved.
   */
  resolved?: boolean;
}
export interface Scrub {
  path: string;
  text: string;
  problem: boolean;
  /** False where the output could not be read, which is never a clean result. */
  readable?: boolean;
  /** The filesystem the report names, matched to a Btrfs filesystem id. */
  fsid?: string | null;
  startedAt?: number | null;
  status?: string | null;
  uncorrectable?: number | null;
  corrected?: number | null;
  /**
   * Damaged block addresses with the paths still on disk. Null where the
   * report carries no damaged-file section, which says nothing about files.
   */
  addresses?: DamagedAddress[] | null;
}
/**
 * One inode the kernel failed a checksum read in, as its log names it. The
 * kernel names the subvolume tree and the inode, not a path: resolving an
 * inode to a path needs root, which vsys does not have.
 */
export interface CsumFailure {
  /** The subvolume's tree id, the kernel's `root`. */
  root: number;
  inode: number;
  /** When the kernel last logged a failed read in this inode, in milliseconds. */
  at: number;
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
  scratch: ScratchRoot[];
  sessions: Scratch[];
  /**
   * Default roots the last scan found absent. They are not configured on this
   * machine, so they carry no row and no source error.
   */
  scratchAbsent?: string[];
  scrubs: Scrub[];
  /**
   * Failed checksum reads the kernel logged, by filesystem id, newest first.
   * Null where the kernel log was not read, which is not a log of none; a
   * filesystem the log names no failure for has no entry.
   */
  csumFailures?: Record<string, CsumFailure[]> | null;
  scratchTime?: number | null;
  scratchPending?: boolean;
}
/** Counters observed over the window vsys actually watched. */
export interface SccacheDelta {
  hits: number;
  misses: number;
  windowMs: number;
}
/**
 * How the last stats query ended: counters read, no sccache on the PATH, or a
 * query that failed, timed out or answered without counters.
 */
export type SccacheState = "read" | "absent" | "failed";
/** sccache counters. An unreadable server stays distinguishable from zero work. */
export interface Sccache {
  state: SccacheState;
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
   * permits a read, a switch or a copied command, and it is the one answer the
   * pane map must have spoken for: the lane's target resolves to the set of
   * panes it names, and a set leaving vsys's own pane out is `no` where the
   * map named that pane. A target the map cannot settle is decided by the
   * handle in the lane's own environment, or left undecided.
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
  | "kernel-log"
  | "smart"
  | "tmux"
  | "agent-slice";
/**
 * Why a source could not be used. The kinds are distinct diagnoses: a kernel
 * that never built the interface, a unit the user masked so systemd never
 * starts it, a file the user cannot read, a file that did not parse, and an
 * interface present but not giving what a reading needs.
 */
export type CapabilityFailure =
  | "absent"
  | "masked"
  | "unreadable"
  | "malformed"
  | "incomplete";
/**
 * Probed once when vsys starts; absence is a known limit, not a read failure.
 * Whether a tmux server answers and whether the agent slice exists are re-read
 * each sample.
 */
export interface Capability {
  id: CapabilityId;
  available: boolean;
  /** Null while the capability is available. */
  failure: CapabilityFailure | null;
  /** The file or directory that decided it. */
  source: string;
  /** The system's own words when a read failed, or the values that decided it. */
  detail: string;
  /**
   * io-stat's "incomplete" failure alone: whether the failing ancestor sits at
   * or below the configured agent slice's own occurrence in the instance path
   * `probeIoStat` was walking, rather than strictly above it. A slice's own
   * `cgroup.subtree_control` gates only what it hands to its children, never
   * its own `io.stat`, so this is true from the depth the walk first reaches
   * the slice onward, whichever instance owns that depth: `writeTotals`'s
   * slice total survives exactly when this holds. Undefined for every other
   * failure, where the distinction does not apply.
   */
  belowSlice?: boolean;
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
