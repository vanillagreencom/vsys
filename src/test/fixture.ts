import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../config/config";
import { defaults } from "../config/config";
import type { Group, Lane, Proc, Snapshot, Volume } from "../model/types";

/** Fake kernel files never require systemd, mounted test disks, or live agents. */
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vsys-test-"));
  const config = defaults();
  config.cgroupRoot = join(root, "cgroup");
  config.procRoot = join(root, "proc");
  config.btrfsRoot = join(root, "btrfs");
  config.sysBlockRoot = join(root, "block");
  config.scrubDir = join(root, "scrub");
  config.smartDir = join(root, "smart");
  config.scratchDirs = [];
  config.sqlitePath = join(root, "history.db");
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  for (const path of [
    config.cgroupRoot,
    config.procRoot,
    config.btrfsRoot,
    config.sysBlockRoot,
  ])
    mkdirSync(path, { recursive: true });
  const psi =
    "some avg10=0.00 avg60=0.00 avg300=0.00 total=100\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
  function group(name: string, pids: number[] = []) {
    const path = join(config.cgroupRoot, name);
    for (const [file, value] of Object.entries({
      "cpu.stat": "usage_usec 1000\nuser_usec 500\nsystem_usec 500",
      "cgroup.procs": pids.join("\n"),
      "cpu.weight": "100",
      "cpu.max": "max 100000",
      "memory.current": "10000",
      "memory.high": "max",
      "memory.max": "max",
      "memory.swap.current": "0",
      "memory.swap.max": "max",
      "pids.current": String(pids.length),
      "pids.max": "max",
      "io.stat": "259:0 rbytes=1000 wbytes=2000 rios=1 wios=2\n",
      "memory.stat": "anon 5000\nfile 4000\n",
      "cpu.pressure": psi,
      "memory.pressure": psi,
      "io.pressure": psi,
    }))
      write(join(path, file), value);
  }
  function proc(
    pid: number,
    groupPath: string,
    options: {
      command?: string[];
      start?: number;
      ticks?: number;
      parent?: number;
      env?: string;
      cwd?: string;
      threads?: number;
      comm?: string;
    } = {},
  ) {
    const command = options.command ?? ["/usr/bin/claude"];
    const fields = Array.from({ length: 50 }, () => "0");
    fields[0] = "S";
    fields[1] = String(options.parent ?? 1);
    fields[11] = String(options.ticks ?? 10);
    fields[17] = String(options.threads ?? 1);
    fields[19] = String(options.start ?? 100);
    fields[21] = "10";
    const path = join(config.procRoot, String(pid));
    write(
      join(path, "stat"),
      `${pid} (${options.comm ?? "claude"}) ${fields.join(" ")}`,
    );
    write(join(path, "cmdline"), `${command.join("\0")}\0`);
    write(
      join(path, "cgroup"),
      `0::/user.slice/user-1000.slice/user@1000.service/${groupPath}\n`,
    );
    write(join(path, "status"), "Name:\tclaude\nVmSwap:\t2 kB\n");
    write(join(path, "environ"), options.env ?? "");
    for (const [name, value] of [
      ["cwd", options.cwd ?? root],
      ["exe", command[0]],
    ]) {
      const pathLink = join(path, name);
      rmSync(pathLink, { force: true });
      symlinkSync(value, pathLink);
    }
  }
  write(join(config.procRoot, "loadavg"), "0.1 0.2 0.3 1/100 10");
  write(join(config.procRoot, "uptime"), "1000.0 900.0");
  write(
    join(config.procRoot, "meminfo"),
    "MemTotal: 1000 kB\nMemAvailable: 600 kB\nSwapTotal: 200 kB\nSwapFree: 100 kB\n",
  );
  write(
    join(config.procRoot, "self/mountinfo"),
    `1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:2 /user.slice/user-1000.slice/user@1000.service ${config.cgroupRoot} rw - cgroup2 cgroup rw\n`,
  );
  for (const kind of ["cpu", "memory", "io"])
    write(join(config.procRoot, "pressure", kind), psi);
  group(".");
  group("agents.slice");
  group("app.slice");
  return {
    root,
    config,
    write,
    group,
    proc,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
export function emptySnapshot(time = 1000): Snapshot {
  return {
    time,
    durationMs: 0,
    system: {
      host: "fixture",
      cores: 8,
      load: [0, 0, 0],
      uptime: 100,
      memory: { MemTotal: 1000, MemAvailable: 500 },
      pressure: { cpu: { some: 0, full: 0, total: 0 } },
      zram: [],
    },
    groups: [],
    procs: [],
    storage: { volumes: [], scratch: [], sessions: [], scrubs: [] },
    lanes: [],
    alerts: [],
    errors: [],
  };
}
export function groupSnapshot(overrides: Partial<Group> = {}): Group {
  return {
    path: "agents.slice/a.scope",
    parent: "agents.slice",
    name: "a.scope",
    pids: [],
    cpuUsec: 0,
    cpuPercent: 0,
    weight: 100,
    cpuMax: "max 100000",
    memory: 0,
    high: null,
    max: null,
    maxRead: true,
    swap: 0,
    swapMax: null,
    tasks: 0,
    tasksMax: null,
    cache: null,
    ioRead: null,
    ioWrite: null,
    ioWriteByDevice: null,
    readRate: null,
    writeRate: null,
    pressure: {},
    ...overrides,
  };
}
export function laneSnapshot(overrides: Partial<Lane> = {}): Lane {
  return {
    id: "agents.slice/a.scope",
    name: "lane-a",
    account: "default",
    pane: "",
    title: "",
    cwd: "/repo",
    branch: "main",
    tool: "claude",
    cgroup: "agents.slice/a.scope",
    mainPid: 40,
    pids: [40],
    cpu: 5,
    cpuShare: 0,
    pressure: 0,
    memoryPressure: 0,
    ioPressure: 0,
    rss: 1024,
    cache: 0,
    swap: 0,
    readRate: 0,
    writeRate: 0,
    tasks: 1,
    rustc: 0,
    cargo: 0,
    tests: 0,
    builds: {},
    linkers: 0,
    sccache: 0,
    memoryMax: null,
    memoryMaxKnown: true,
    cpuWeight: 100,
    jobs: null,
    jobserver: null,
    age: 10,
    state: "sleeping",
    blocked: 0,
    blockedOn: null,
    unconfined: false,
    dangerous: false,
    ...overrides,
  };
}
export function processSnapshot(overrides: Partial<Proc> = {}): Proc {
  return {
    pid: 40,
    ppid: 1,
    start: 100,
    comm: "claude",
    command: ["/usr/bin/claude"],
    executable: "/usr/bin/claude",
    cwd: "/repo",
    group: "/agents.slice/a.scope",
    state: "S",
    threads: 1,
    rss: 1024,
    swap: 0,
    ticks: 10,
    cpuPercent: 0,
    age: 10,
    env: {},
    envAvailable: true,
    branch: "main",
    tool: "claude",
    build: null,
    ...overrides,
  };
}
export function volumeSnapshot(
  mount: string,
  overrides: Partial<Volume> = {},
): Volume {
  return {
    mount,
    device: "/dev/x",
    fsid: mount,
    options: [],
    readOnly: false,
    free: 1e12,
    total: 2e12,
    errors: {},
    delta: {},
    sinceStart: {},
    ...overrides,
  };
}
/** A snapshot that triggers every cause the ladder knows, one of each. */
export function everyCauseSnapshot(c: Config): Snapshot {
  const s = emptySnapshot();
  const g = (path: string, name: string, o: Partial<Group> = {}) =>
    groupSnapshot({ path, name, ...o });
  s.system.pressure = {
    cpu: { some: 90, full: 0, total: 0 },
    memory: { some: 80, full: 0, total: 0 },
    io: { some: 70, full: 41, total: 0 },
  };
  s.lanes = [
    laneSnapshot({ id: "lane-escaped", name: "escaped", unconfined: true }),
    laneSnapshot({ id: "lane-capped", name: "capped", dangerous: true }),
    laneSnapshot({ id: "w.scope", name: "writer", pids: [1], ioPressure: 40 }),
  ];
  s.procs = [processSnapshot({ pid: 1, build: "ld.mold" })];
  s.groups = [
    g("w.scope", "w.scope", { writeRate: 209715200 }),
    g("app.slice", c.desktopSlice, { swap: c.swapFloor + 1 }),
    g("app.slice/gnome.scope", "gnome.scope", { swap: 992 }),
    g("agents.slice", c.agentSlice, { cache: 85899345920 }),
    g("h.scope", "h.scope", { memory: 100, high: 100 }),
  ];
  s.storage.volumes = [
    volumeSnapshot("/ro", { readOnly: true }),
    volumeSnapshot("/bad", { delta: { "x/corruption_errs": 1 } }),
    volumeSnapshot("/full", { free: 5, total: 100 }),
  ];
  const bytes = c.scratchQuota + 1;
  s.storage.scrubs = [{ path: "/scrub", text: "errors", problem: true }];
  s.storage.scratch = [{ path: "/scratch", bytes, age: 0, error: null }];
  return s;
}
