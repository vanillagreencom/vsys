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
  max: number | null;
  swap: number | null;
  swapMax: number | null;
  tasks: number | null;
  tasksMax: number | null;
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
export interface Storage {
  mountsAvailable?: boolean;
  volumes: Volume[];
  scratch: Scratch[];
  sessions: Scratch[];
  scrubs: Scrub[];
  scratchTime?: number | null;
  scratchPending?: boolean;
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
  account: string;
  cwd: string;
  branch: string;
  tool: string;
  mainPid: number;
  pids: number[];
  cpu: number | null;
  pressure: number | null;
  memoryPressure: number | null;
  ioPressure: number | null;
  rss: number;
  swap: number | null;
  tasks: number;
  rustc: number;
  cargo: number;
  tests: number;
  age: number;
  state: string;
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
/** A complete sample carries failures rather than converting them to zero. */
export interface Snapshot {
  time: number;
  durationMs: number;
  system: System;
  groups: Group[];
  procs: Proc[];
  storage: Storage;
  lanes: Lane[];
  alerts: Alert[];
  errors: SourceError[];
}
