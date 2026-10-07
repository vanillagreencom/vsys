import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessCollector } from "../collect/procs";
import { type Config, defaults, validate } from "../config/config";
import { History } from "../store/history";
import { normalizeSnapshot } from "../store/migrate";
import { point } from "../store/point";
import {
  emptySnapshot,
  everyCauseSnapshot,
  fixture,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
  volumeSnapshot,
} from "../test/fixture";
import { present } from "../test/present";
import { buildsSummary } from "./builds";
import { summarySnapshot } from "./export";
import { type IntegrityState, integrities } from "./integrity";
import { lanes } from "./lanes";
import type { Group, Lane, Scrub, Snapshot, Volume } from "./types";
import {
  agentTotal,
  buildLoad,
  type CauseId,
  causeOrder,
  causeRank,
  causes,
  laneLinkers,
  leastFree,
  type Meter,
  meters,
  sliceRoots,
  sliceSum,
  topSwapHolder,
  topWriter,
  type Unjudged,
  unjudged,
  worstKind,
} from "./verdict";

const g = (path: string, name: string, o: Partial<Group> = {}) =>
  groupSnapshot({ path, name, ...o });
/** A meter by its id, so a meter added later moves no reading here. */
const meterOf = (s: Snapshot, c: Config, id: Meter["id"]) =>
  present(
    meters(s, c).find((m) => m.id === id),
    `the ${id} meter`,
  );
function healthy(): Snapshot {
  const s = emptySnapshot();
  s.system.pressure = {
    cpu: { some: 1, full: 0, total: 0 },
    memory: { some: 0, full: 0, total: 0 },
    io: { some: 1, full: 0, total: 0 },
  };
  return s;
}

test("a healthy machine has no causes at all", () => {
  expect(causes(healthy(), defaults())).toEqual([]);
});

test("severity ranks the ladder and housekeeping never leads it", () => {
  const c = defaults();
  const s = healthy();
  s.system.pressure.io = { some: 70, full: 40, total: 0 };
  s.groups = [g("a.scope", "a.scope", { writeRate: 200 })];
  // A lane leading no process is named by its name alone.
  s.lanes = [
    laneSnapshot({ name: "kendex hclaude", mainPid: 0, unconfined: true }),
  ];
  const ladder = causes(s, c);
  expect(ladder.map((cause) => cause.id)).toEqual(["unconfined", "disk"]);
  expect(ladder[0]).toMatchObject({
    level: "danger",
    consumer: "kendex hclaude",
    values: { lanes: 1 },
  });
  expect(ladder[0]?.lanes.map((l) => l.name)).toEqual(["kendex hclaude"]);
  // A warn disk cause is authored first, so only a sort puts the scrub above it.
  s.lanes = [];
  s.system.pressure.io = { some: 15, full: 2, total: 0 };
  s.storage.scrubs = [{ path: "/scrub", text: "errors", problem: true }];
  s.storage.scratch = [
    {
      path: "/scratch",
      bytes: c.scratchQuota + 1,
      age: 0,
      error: null,
      origin: "configured",
    },
  ];
  const sorted = causes(s, c);
  expect(sorted.map((cause) => cause.id)).toEqual(["scrub", "disk", "scratch"]);
  expect(sorted.map((cause) => cause.level)).toEqual([
    "danger",
    "warn",
    "warn",
  ]);
  // Scratch is a card, never the machine's verdict.
  expect(sorted.map((cause) => cause.verdictWorthy)).toEqual([
    true,
    true,
    false,
  ]);
});

test("the agent slice name comes from config, not a hardcoded name", () => {
  const c = { ...defaults(), agentSlice: "robots.slice" };
  const s = healthy();
  s.groups = [
    g("robots.slice", "robots.slice", { cache: 7 }),
    g("app.slice", c.desktopSlice, { swap: c.swapFloor + 1 }),
  ];
  expect(causes(s, c)[0]?.values.cache).toBe(7);
  expect(meterOf(s, c, "memory").values.cache).toBe(7);
  // The default slice name must not be consulted anywhere.
  expect(meterOf(s, defaults(), "memory").values.cache).toBeNull();
});

test("a saturated disk names the writing scope and carries its numbers", () => {
  const s = healthy();
  s.system.pressure.io = { some: 70, full: 41, total: 0 };
  s.groups = [
    g("a/x.scope", "x.scope", { writeRate: 10 }),
    g("a/510341.scope", "510341.scope", { writeRate: 200 }),
  ];
  const waiter = laneSnapshot({ id: "other", name: "waiter", ioPressure: 30 });
  const cruncher = laneSnapshot({
    id: "cpu-bound",
    name: "cruncher",
    pressure: 30,
  });
  s.lanes = [
    laneSnapshot({ id: "a/510341.scope", name: "lane-510341", pids: [1] }),
    waiter,
    cruncher,
  ];
  s.procs = [processSnapshot({ pid: 1, build: "ld.mold" })];
  expect(worstKind(waiter)).toBe("io");
  expect(worstKind(cruncher)).toBe("cpu");
  const ladder = causes(s, defaults());
  expect(ladder[0]).toMatchObject({
    id: "disk",
    level: "danger",
    consumer: "lane-510341 PID 40",
    values: { some: 70, full: 41, writeRate: 200, linkers: 1, stalling: 1 },
  });
  // Storage stallers join the disk card; only the CPU one stays generic.
  expect(ladder.map((cause) => cause.id)).toEqual(["disk", "stalls"]);
  expect(ladder[0]?.lanes.map((l) => l.name)).toEqual([
    "lane-510341",
    "waiter",
  ]);
  expect(ladder[1]?.lanes.map((l) => l.name)).toEqual(["cruncher"]);
});

test("a filesystem below the free-space floor is its own cause", () => {
  const c = defaults();
  const s = healthy();
  const volume = (mount: string, free: number) =>
    volumeSnapshot(mount, { free, total: 100 });
  s.storage.volumes = [volume("/big", c.freeFloor + 1), volume("/full", 5)];
  expect(leastFree(s.storage.volumes)?.mount).toBe("/full");
  const cause = causes(s, c).find((item) => item.id === "free-space");
  expect(cause).toMatchObject({
    level: "danger",
    consumer: "/full",
    paths: ["/full"],
    values: { free: 5, total: 100 },
  });
  expect(meterOf(s, c, "disk").values.free).toBe(5);
  // Above the floor there is no cause at all.
  s.storage.volumes = [volume("/big", c.freeFloor + 1)];
  expect(causes(s, c).find((item) => item.id === "free-space")).toBeUndefined();
});

test("a process whose name was not confirmed by install location is its own cause", () => {
  const c = defaults();
  const s = healthy();
  const unconfirmed = {
    ...processSnapshot({ pid: 7, comm: "pi" }),
    tool: null,
    unconfirmedTool: "pi",
    unconfirmedPath: "/usr/bin/pi",
  };
  s.procs = [processSnapshot({ pid: 1 }), unconfirmed];
  const cause = causes(s, c).find((item) => item.id === "unconfirmed-tool");
  expect(cause).toMatchObject({
    level: "warn",
    verdictWorthy: false,
    consumer: "pi",
    values: { processes: 1 },
  });
  // The cause carries the raw process, not merely a count: a process a
  // confirmed agent's name also matched is left out.
  expect(cause?.procs).toEqual([unconfirmed]);
  // A snapshot with no unconfirmed name at all raises no cause.
  s.procs = [processSnapshot({ pid: 1 })];
  expect(
    causes(s, c).find((item) => item.id === "unconfirmed-tool"),
  ).toBeUndefined();
});

test("slice totals sum root groups and never a nested copy", () => {
  const c = defaults();
  const groups = [
    // The nested copy is listed first, so a first-match lookup reads it.
    g("app.slice/inner/app.slice", c.desktopSlice, {
      swap: 99,
      cpuPercent: 99,
    }),
    g("app.slice", c.desktopSlice, { swap: 10, cpuPercent: 4 }),
    g("app.slice/a.scope", "a.scope", { swap: 7 }),
    g("app.slice/b.scope", "b.scope", { swap: 3 }),
    g("agents.slice", c.agentSlice, { writeRate: 999 }),
    g("agents.slice/c.scope", "c.scope", { writeRate: 5 }),
  ];
  expect(sliceRoots(groups, c.desktopSlice).map((g) => g.path)).toEqual([
    "app.slice",
  ]);
  expect(sliceSum(groups, c.desktopSlice, (g) => g.swap)).toBe(10);
  expect(sliceSum(groups, c.desktopSlice, (g) => g.cpuPercent)).toBe(4);
  // An unknown counter on a root makes the whole total unknown.
  expect(sliceSum(groups, c.agentSlice, (g) => g.cache)).toBeNull();
  expect(sliceSum(groups, "missing.slice", (g) => g.swap)).toBeNull();
  expect(topSwapHolder(groups, c)?.name).toBe("a.scope");
  // A parent slice always outwrites its children and must never be the writer.
  expect(topWriter(groups)?.name).toBe("c.scope");
});

test("four meters carry exact numbers and the biggest consumer", () => {
  const c = defaults();
  const s = healthy();
  s.system.cores = 32;
  s.system.pressure.io = { some: 12, full: 3, total: 0 };
  s.groups = [
    g("agents.slice", c.agentSlice, { cpuPercent: 11.8, cache: 80 }),
    g("app.slice", c.desktopSlice, { cpuPercent: 40, swap: c.swapFloor + 1 }),
    g("app.slice/shell.scope", "shell.scope", { swap: 992, memory: 5 }),
    g("agents.slice/b.scope", "b.scope", { writeRate: 200, memory: 9 }),
  ];
  s.lanes = [laneSnapshot({ name: "lane-a", cpu: 30 })];
  s.procs = [
    processSnapshot({ pid: 1, build: "rustc", group: "/agents.slice/b.scope" }),
    processSnapshot({
      pid: 2,
      build: "ld.mold",
      group: "/agents.slice/b.scope",
    }),
  ];
  const [cpu, memory, disk, builds] = (
    ["cpu", "memory", "disk", "builds"] as const
  ).map((id) => meterOf(s, c, id));
  expect(cpu).toEqual({
    id: "cpu",
    level: "ok",
    consumer: "lane-a PID 40",
    values: { system: 1, agents: 11.8, desktop: 40, top: 30 },
  });
  // "largest" always means the largest memory scope; the swap holder is its
  // own field and appears only while the desktop is swapped out.
  expect(memory).toEqual({
    id: "memory",
    level: "danger",
    consumer: "b",
    holder: "shell",
    values: {
      used: 500,
      total: 1000,
      cache: 80,
      swap: c.swapFloor + 1,
      largest: 9,
      holderSwap: 992,
    },
  });
  expect(disk).toEqual({
    id: "disk",
    level: "warn",
    consumer: "b",
    values: { some: 12, full: 3, writeRate: 200, free: null },
  });
  expect(builds).toEqual({
    id: "builds",
    level: "ok",
    consumer: "lane-a PID 40",
    values: { builds: 2, linkers: 1, cores: 32, lanes: 1 },
  });
});

test("build load counts configured linkers separately and per lane", () => {
  const c = defaults();
  const s = healthy();
  s.procs = [
    processSnapshot({ pid: 1, build: "rustc", group: "/agents.slice/a.scope" }),
    processSnapshot({
      pid: 2,
      build: "ld.mold",
      group: "/agents.slice/a.scope",
    }),
    processSnapshot({ pid: 3, build: "mold", group: "/agents.slice/b.scope" }),
  ];
  expect(buildLoad(s, c)).toEqual({ builds: 3, linkers: 2, lanes: 2 });
  expect(laneLinkers(s, laneSnapshot({ pids: [1, 2] }), c)).toBe(1);
  // The linker list is configuration, so a shorter list counts fewer linkers.
  expect(buildLoad(s, { ...c, linkerNames: ["mold"] }).linkers).toBe(1);
});

test("build counts stay unknown when process collection omits a process or cannot list them", () => {
  const c = defaults();
  const root = mkdtempSync(join(tmpdir(), "vsys-build-counts-"));
  try {
    const rows: [string, string, string[] | null, number | null][] = [
      ["readable empty directory", root, null, 0],
      ["unread directory", join(root, "unread"), null, null],
      ["unread process", root, [join(root, "77")], null],
      ["unread optional field", root, [join(root, "77", "environ")], 0],
    ];
    for (const [name, directory, sources, count] of rows) {
      for (const procRoot of [directory, `${directory}/`]) {
        const config = validate({ procRoot }, c);
        const s = emptySnapshot();
        if (sources === null) {
          const reading = new ProcessCollector(config, 100, 4096).read({
            time: s.time,
            uptime: 0,
            groups: [],
          });
          expect(reading.procs).toEqual([]);
          expect(reading.errors.map((error) => error.source)).toEqual(
            count === null ? [procRoot] : [],
          );
          s.processRead = reading.processRead;
          s.procs = reading.procs;
          s.errors = reading.errors;
        } else {
          s.errors = sources.map((source) => ({ source, message: "EACCES" }));
          s.processRead = count === null ? "incomplete" : "complete";
        }
        const counts = { builds: count, linkers: count, lanes: count };
        expect({ name, ...buildLoad(s, config) }).toEqual({ name, ...counts });
        expect(buildsSummary(s, config)).toMatchObject(counts);
        expect(meterOf(s, config, "builds")).toMatchObject({
          level: count === null ? "warn" : "ok",
          values: counts,
        });
        expect(
          present(
            summarySnapshot(s, config).meters.find((m) => m.id === "builds"),
            name,
          ),
        ).toMatchObject({
          level: count === null ? "warn" : "ok",
          value: count,
        });
      }
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("replay keeps the collected process outcome after a process root edit", async () => {
  const f = fixture();
  const history = new History(f.config);
  try {
    f.proc(77, "app.slice/agent.service", {
      command: ["rustc"],
      comm: "rustc",
    });
    rmSync(join(f.config.procRoot, "77/stat"));
    mkdirSync(join(f.config.procRoot, "77/stat"));
    const s = emptySnapshot();
    const reading = new ProcessCollector(f.config, 100, 4096).read({
      time: s.time,
      uptime: 0,
      groups: [],
    });
    expect(reading.processRead).toBe("incomplete");
    expect(reading.errors.map((e) => e.source)).toContain(
      join(f.config.procRoot, "77"),
    );
    Object.assign(s, reading);
    history.add(s);
    const replay = present(history.at(s.time) ?? undefined, "retained sample");
    for (const procRoot of [
      f.config.procRoot,
      `${f.config.procRoot}/`,
      "/proc-new",
    ]) {
      const config = validate({ procRoot }, f.config);
      expect(buildLoad(replay, config)).toEqual({
        builds: null,
        linkers: null,
        lanes: null,
      });
      expect(meterOf(replay, config, "builds").level).toBe("warn");
    }
    const { processRead: _outcome, ...legacy } = emptySnapshot();
    const normalized = normalizeSnapshot(JSON.parse(JSON.stringify(legacy)));
    expect(normalized.processRead).toBe("unknown");
    expect(buildLoad(normalized, f.config)).toEqual({
      builds: null,
      linkers: null,
      lanes: null,
    });
    expect(normalizeSnapshot(normalized)).toEqual(normalized);
  } finally {
    history.close();
    f.cleanup();
  }
});

test("the cause order table is the ladder's own tie order", () => {
  const c = defaults();
  const ladder = causes(everyCauseSnapshot(c), c);
  // Every rank is distinct, so no two causes can tie on the table itself.
  const ranks = ladder.map((cause) => causeRank(cause.id));
  expect(new Set(ranks).size).toBe(ranks.length);
  // Severity first, then the table. Written out, so the table cannot drift
  // from the ladder by agreeing with itself.
  expect(ladder.map((cause) => cause.id)).toEqual([
    "unconfined",
    "read-only",
    "damaged-files",
    "new-errors",
    "device-errors",
    "disk",
    "desktop-swap",
    "free-space",
    "memory-cap",
    "scrub",
    "system-memory",
    "system-cpu",
    "memory-high",
    "unchecked",
    "integrity-unknown",
    "unconfirmed-tool",
    "scratch",
  ]);
  // Stalls is the one cause that snapshot cannot raise: every host pressure
  // fires there, and a host card owns each lane stalling on its resource. A
  // quiet host with one stalling lane raises it, so the two ladders together
  // cover every cause the order table ranks.
  const quiet = healthy();
  quiet.lanes = [laneSnapshot({ pressure: c.pressureRed + 1 })];
  const stalls = causes(quiet, c).map((cause) => cause.id);
  expect(stalls).toContain("stalls");
  const covered = new Set([...ladder.map((cause) => cause.id), ...stalls]);
  expect(Object.keys(causeOrder).sort()).toEqual([...covered].sort());
  // A cause that names a lane names it in text, its process id included.
  const lanes = ["unconfined", "memory-cap", "system-cpu"].map(
    (id) => ladder.find((cause) => cause.id === id)?.consumer,
  );
  expect(lanes).toEqual(["escaped PID 40", "capped PID 40", "escaped PID 40"]);
  // Within one severity the table alone decides, so those ranks only rise.
  const danger = ladder
    .filter((cause) => cause.level === "danger")
    .map((cause) => causeRank(cause.id));
  expect(danger).toEqual([...danger].sort((a, b) => a - b));
});

test("the damage card keeps each named filesystem's own block count apart", () => {
  const c = defaults();
  const damaged = (fsid: string, mount: string, blocks: number | null) => ({
    volume: volumeSnapshot(mount, {
      fsid,
      errors: { "1/corruption_errs": 1 },
      countersAvailable: true,
    }),
    scrub: {
      path: `/run/btrfs-scrub/${fsid}.result`,
      text: "Error summary: csum=1",
      problem: true,
      readable: true,
      fsid,
      startedAt: 500,
      status: "finished",
      uncorrectable: blocks,
      addresses: [{ logical: 1, paths: [`/r/target/${fsid}`] }],
    },
  });
  const build = (rows: ReturnType<typeof damaged>[]) => {
    const s = emptySnapshot();
    s.storage.volumes = rows.map((row) => row.volume);
    s.storage.scrubs = rows.map((row) => row.scrub);
    return causes(s, c).find((cause) => cause.id === "damaged-files");
  };
  // Two filesystems, both counted: each keeps its own figure, in `paths`
  // order.
  expect(
    build([damaged("a", "/a", 26), damaged("b", "/b", 9)])?.damage.map(
      (d) => d.blocks,
    ),
  ).toEqual([26, 9]);
  // One report carried no count. That filesystem's own figure is unknown,
  // but the other's stays a number rather than being nulled along with it.
  expect(
    build([damaged("a", "/a", 26), damaged("b", "/b", null)])?.damage.map(
      (d) => d.blocks,
    ),
  ).toEqual([26, null]);
});

test("the damage card's file and unnamed counts stay per filesystem when one's damage is only remembered", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes = [
    volumeSnapshot("/a", {
      fsid: "a",
      errors: { "1/corruption_errs": 1 },
      countersAvailable: true,
    }),
  ];
  s.storage.scrubs = [
    {
      path: "/run/btrfs-scrub/a.result",
      text: "Error summary: csum=1",
      problem: true,
      readable: true,
      fsid: "a",
      startedAt: 500,
      status: "finished",
      uncorrectable: 1,
      addresses: [{ logical: 1, paths: ["/r/target/a"] }],
    },
  ];
  const named = () =>
    causes(s, c).find((cause) => cause.id === "damaged-files");
  expect(named()?.damage).toEqual([{ files: 1, unnamed: 0, blocks: 1 }]);
  // A second filesystem whose current report stopped early. Its damage is
  // known only from a remembered finished check, with no address data at
  // all, so its own entry reads unknown rather than reusing the first
  // filesystem's known figure, or reading as zero files and zero unnamed
  // blocks.
  s.storage.volumes.push(
    volumeSnapshot("/b", {
      fsid: "b",
      errors: { "1/corruption_errs": 1 },
      countersAvailable: true,
    }),
  );
  s.storage.scrubs.push({
    path: "/run/btrfs-scrub/b.result",
    text: "scrub status:\naborted",
    problem: true,
    readable: true,
    fsid: "b",
    startedAt: 600,
    status: "aborted",
    uncorrectable: null,
    addresses: null,
  });
  s.storage.lastFinishedScrub = { b: { at: 100, damaged: true } };
  expect(named()?.damage).toEqual([
    { files: 1, unnamed: 0, blocks: 1 },
    { files: null, unnamed: null, blocks: null },
  ]);
});

test("every integrity state but healthy and checking reaches the verdict", () => {
  const c = defaults();
  const report = (fsid: string, over: Partial<Scrub> = {}): Scrub => ({
    path: `/run/btrfs-scrub/${fsid}.result`,
    text: "Error summary: no errors found",
    problem: false,
    readable: true,
    fsid,
    startedAt: 1000 - 3600000,
    status: "finished",
    uncorrectable: 0,
    corrected: 0,
    addresses: [],
    ...over,
  });
  const volume = (fsid: string, over: Partial<Volume> = {}) =>
    volumeSnapshot(`/${fsid}`, {
      fsid,
      errors: { "1/corruption_errs": 1 },
      countersAvailable: true,
      ...over,
    });
  // One filesystem per state, each in its own snapshot so one cause cannot
  // stand in for another.
  const rows: [IntegrityState, Volume, Scrub[], CauseId][] = [
    [
      "damaged",
      volume("a"),
      [report("a", { problem: true, uncorrectable: 26 })],
      "damaged-files",
    ],
    [
      "new-errors",
      volume("b", { lastErrorAt: 1000 - 1000, lastErrorSize: 26 }),
      [report("b")],
      "new-errors",
    ],
    ["never-checked", volume("c"), [], "unchecked"],
    [
      "stale",
      volume("d"),
      [report("d", { startedAt: 1000 - (c.scrubMaxAgeDays + 1) * 86400000 })],
      "unchecked",
    ],
    [
      "unknown",
      volume("e"),
      [report("e", { readable: false, problem: true })],
      "integrity-unknown",
    ],
  ];
  for (const [state, v, scrubs, card] of rows) {
    const s = emptySnapshot();
    s.storage.volumes = [v];
    s.storage.scrubs = scrubs;
    expect({ state, integrity: integrities(s, c)[0]?.state }).toEqual({
      state,
      integrity: state,
    });
    // The ladder speaks for it with the card for that state, so Home cannot
    // read Healthy while Storage reads anything else.
    const spoken = causes(s, c).find((cause) => cause.id === card);
    expect({ state, card: spoken?.id, verdict: spoken?.verdictWorthy }).toEqual(
      { state, card, verdict: true },
    );
  }
  // A filesystem that was checked and found sound raises nothing at all.
  const well = emptySnapshot();
  well.storage.volumes = [volume("f")];
  well.storage.scrubs = [report("f")];
  expect(integrities(well, c)[0]?.state).toBe("healthy");
  expect(causes(well, c)).toEqual([]);
});

test("a cause naming several filesystems carries no one filesystem's numbers", () => {
  const c = defaults();
  const s = emptySnapshot();
  const grown = (fsid: string, size: number) => {
    s.storage.volumes.push(
      volumeSnapshot(`/${fsid}`, {
        fsid,
        errors: { "1/corruption_errs": 1 },
        countersAvailable: true,
        lastErrorAt: s.time - 1000,
        lastErrorSize: size,
      }),
    );
    s.storage.scrubs.push({
      path: `/run/btrfs-scrub/${fsid}.result`,
      text: "Error summary: no errors found",
      problem: false,
      readable: true,
      fsid,
      startedAt: s.time - 3600000,
      status: "finished",
      uncorrectable: 0,
      corrected: 0,
      addresses: [],
    });
  };
  const values = () =>
    causes(s, c).find((cause) => cause.id === "new-errors")?.values;
  grown("a", 26);
  expect(values()).toEqual({
    filesystems: 1,
    size: 26,
    since: 1,
    logged: null,
    checked: 3600,
  });
  // A second filesystem, and the first one's growth no longer stands for the
  // cause: an event carrying 26 would name two filesystems and one's count.
  grown("b", 9);
  expect(values()).toEqual({
    filesystems: 2,
    size: null,
    since: null,
    logged: null,
    checked: null,
  });
});

test("the new-errors card names no growth the last check itself counted", () => {
  const c = defaults();
  const s = emptySnapshot();
  // The scrub started an hour ago, ran thirty minutes and corrected the three
  // errors the counter grew by forty minutes ago. A read the kernel logged a
  // second ago is the only new error.
  s.storage.volumes.push(
    volumeSnapshot("/f", {
      fsid: "f",
      errors: { "1/corruption_errs": 3 },
      countersAvailable: true,
      lastErrorAt: s.time - 40 * 60000,
      lastErrorBefore: s.time - 61 * 60000,
      lastErrorSize: 3,
    }),
  );
  s.storage.scrubs.push({
    path: "/run/btrfs-scrub/f.result",
    text: "Corrected: 3",
    problem: true,
    readable: true,
    fsid: "f",
    startedAt: s.time - 3600000,
    duration: 30 * 60000,
    status: "finished",
    uncorrectable: 0,
    corrected: 3,
    addresses: [],
  });
  s.storage.csumFailures = { f: [{ root: 5, inode: 257, at: s.time - 1000 }] };
  expect(
    causes(s, c).find((cause) => cause.id === "new-errors")?.values,
  ).toEqual({
    filesystems: 1,
    size: null,
    since: null,
    logged: 1,
    checked: 3600,
  });
});

test("with no agent slice, agent totals sum the agent lanes and stay unknown on a gap", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.capabilities = s.capabilities.map((cap) =>
    cap.id === "agent-slice"
      ? { ...cap, available: false, failure: "absent" as const }
      : cap,
  );
  // The desktop is swapped out, so the swap card states the agents' cache.
  s.groups = [g("app.slice", c.desktopSlice, { swap: c.swapFloor + 1 })];
  // A lane with no agent in it is not the agents' use, whatever it costs.
  const desktop = laneSnapshot({ id: "d", tool: "", cpu: 400, cache: 9 });
  const claude = laneSnapshot({ id: "a", tool: "claude", cpu: 20, cache: 100 });
  const codex = laneSnapshot({ id: "b", tool: "codex", cpu: 10, cache: 50 });
  const agents = [claude, codex];
  const figures = (snapshot: Snapshot, config: typeof c) => {
    const meter = (id: string) =>
      meters(snapshot, config).find((m) => m.id === id);
    return {
      cpu: agentTotal(snapshot, config, "cpu"),
      meterCpu: meter("cpu")?.values.agents,
      meterCache: meter("memory")?.values.cache,
      swapCache: causes(snapshot, config).find((x) => x.id === "desktop-swap")
        ?.values.cache,
    };
  };
  type Figure = number | null;
  type Figures = [Figure, Figure, Figure, Figure];
  const rows: [string, Lane[], string[], Figures, string?][] = [
    ["two agents", [...agents, desktop], [], [30, 30, 150, 150]],
    [
      "an agent lane with no CPU reading",
      [claude, { ...codex, cpu: null }, desktop],
      [],
      [null, null, 150, 150],
    ],
    // No agent running is a measured nothing.
    ["no agent running", [desktop], [], [0, 0, 0, 0]],
    // A process the sample left out may have been an agent.
    [
      "a process that could not be read",
      [...agents, desktop],
      [`${c.procRoot}/77`],
      [null, null, null, null],
    ],
    [
      "a process list that could not be read",
      [desktop],
      [c.procRoot],
      [null, null, null, null],
    ],
    // A process kept in the reading with one field unknown is still counted.
    [
      "an environment that could not be read",
      [...agents, desktop],
      [`${c.procRoot}/77/environ`],
      [30, 30, 150, 150],
    ],
    // Process directory paths use join, which removes the root's trailing slash.
    [
      "a process that could not be read, under a root written with a slash",
      [...agents, desktop],
      ["/proc/77"],
      [null, null, null, null],
      "/proc/",
    ],
  ];
  for (const [
    name,
    lanes,
    failed,
    [cpu, meterCpu, meterCache, swapCache],
    procRoot = c.procRoot,
  ] of rows)
    expect({
      name,
      ...figures(
        {
          ...s,
          lanes,
          processRead: failed.some((source) => !source.endsWith("/environ"))
            ? "incomplete"
            : "complete",
          errors: failed.map((source) => ({ source, message: "EACCES" })),
        },
        { ...c, procRoot },
      ),
    }).toEqual({ name, cpu, meterCpu, meterCache, swapCache });
});

test("nested agent counters reach Home and Timeline once without an agent slice", () => {
  const rows: {
    name: string;
    parentCpu: number | null;
    childCpu: number | null;
    parentCache: number | null;
    childCache: number | null;
    processCpu: number | null;
    cpu: number | null;
    cache: number | null;
  }[] = [
    {
      name: "measured",
      parentCpu: 30,
      childCpu: 20,
      parentCache: 3000,
      childCache: 2000,
      processCpu: 10,
      cpu: 30,
      cache: 3000,
    },
    {
      name: "covered fallback",
      parentCpu: 30,
      childCpu: null,
      parentCache: 3000,
      childCache: null,
      processCpu: 10,
      cpu: 30,
      cache: 3000,
    },
    {
      name: "parent fallback",
      parentCpu: null,
      childCpu: 20,
      parentCache: null,
      childCache: 2000,
      processCpu: 10,
      cpu: 30,
      cache: null,
    },
    {
      name: "process sums",
      parentCpu: null,
      childCpu: null,
      parentCache: null,
      childCache: null,
      processCpu: 10,
      cpu: 30,
      cache: null,
    },
    {
      name: "unknown process",
      parentCpu: null,
      childCpu: 20,
      parentCache: null,
      childCache: 2000,
      processCpu: null,
      cpu: null,
      cache: null,
    },
    {
      name: "measured zero",
      parentCpu: 0,
      childCpu: 0,
      parentCache: 0,
      childCache: 0,
      processCpu: 10,
      cpu: 0,
      cache: 0,
    },
  ];
  for (const failure of ["absent", "masked"] as const)
    for (const suffix of ["service", "scope"])
      for (const reverse of [false, true])
        for (const row of rows) {
          const c = defaults();
          const s = emptySnapshot();
          s.capabilities = s.capabilities.map((cap) =>
            cap.id === "agent-slice"
              ? { ...cap, available: false, failure }
              : cap,
          );
          const parent = groupSnapshot({
            path: "app.slice/agent.service",
            name: "agent.service",
            kernelPath: "/tenant.slice/app.slice/agent.service",
            pids: [40],
            cpuPercent: row.parentCpu,
            cache: row.parentCache,
          });
          const child = groupSnapshot({
            path: `${parent.path}/child.${suffix}`,
            name: `child.${suffix}`,
            kernelPath: `${parent.kernelPath}/child.${suffix}`,
            pids: [41],
            cpuPercent: row.childCpu,
            cache: row.childCache,
          });
          const desktop = groupSnapshot({
            path: "app.slice",
            name: c.desktopSlice,
            swap: c.swapFloor + 1,
          });
          s.groups = reverse
            ? [child, parent, desktop]
            : [desktop, parent, child];
          const procs = [
            processSnapshot({
              pid: 40,
              group: parent.kernelPath,
              cpuPercent: row.processCpu,
            }),
            processSnapshot({
              pid: 41,
              group: child.kernelPath,
              cpuPercent: 20,
            }),
          ];
          s.procs = reverse ? procs.reverse() : procs;
          s.lanes = lanes(
            s.groups,
            s.procs,
            c,
            8,
            undefined,
            s.capabilities,
            s.processRead,
          );
          const parentLane = present(
            s.lanes.find((l) => l.cgroup === parent.path),
            "parent lane",
          );
          const childLane = present(
            s.lanes.find((l) => l.cgroup === child.path),
            "child lane",
          );
          expect({
            row: row.name,
            failure,
            suffix,
            reverse,
            pids: [parentLane.pids, childLane.pids],
            laneCpu: [parentLane.cpu, childLane.cpu],
            laneCache: [parentLane.cache, childLane.cache],
            cpu: agentTotal(s, c, "cpu"),
            cache: agentTotal(s, c, "cache"),
            homeCpu: meterOf(s, c, "cpu").values.agents,
            homeCache: meterOf(s, c, "memory").values.cache,
            swapCache: causes(s, c).find((cause) => cause.id === "desktop-swap")
              ?.values.cache,
            timelineCpu: point(s, c).agents,
          }).toEqual({
            row: row.name,
            failure,
            suffix,
            reverse,
            pids: [[40], [41]],
            laneCpu: [row.parentCpu ?? row.processCpu, row.childCpu ?? 20],
            laneCache: [row.parentCache, row.childCache],
            cpu: row.cpu,
            cache: row.cache,
            homeCpu: row.cpu,
            homeCache: row.cache,
            swapCache: row.cache,
            timelineCpu: row.cpu,
          });
        }
});

test("agent totals add disjoint groups and uncovered process CPU", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.capabilities = s.capabilities.map((cap) =>
    cap.id === "agent-slice"
      ? { ...cap, available: false, failure: "absent" as const }
      : cap,
  );
  const group = groupSnapshot({
    path: "app.slice/agent.service",
    name: "agent.service",
    kernelPath: "/tenant.slice/app.slice/agent.service",
    pids: [40],
    cpuPercent: 30,
    cache: 3000,
  });
  const sibling = groupSnapshot({
    path: `${group.path}-other`,
    name: "other.service",
    kernelPath: `${group.kernelPath}-other`,
    pids: [41],
    cpuPercent: 7,
    cache: 700,
  });
  s.groups = [group, sibling];
  s.procs = [
    processSnapshot({ pid: 40, group: group.kernelPath, cpuPercent: 10 }),
    processSnapshot({ pid: 41, group: sibling.kernelPath, cpuPercent: 7 }),
    processSnapshot({
      pid: 43,
      group: `${group.kernelPath}/uncollected.service`,
      cpuPercent: 20,
    }),
  ];
  s.lanes = lanes(
    s.groups,
    s.procs,
    c,
    8,
    undefined,
    s.capabilities,
    s.processRead,
  );
  expect([agentTotal(s, c, "cpu"), agentTotal(s, c, "cache")]).toEqual([
    37, 3700,
  ]);
  s.procs.push(
    processSnapshot({ pid: 42, group: "/outside.service", cpuPercent: 5 }),
  );
  s.lanes = lanes(
    s.groups,
    s.procs,
    c,
    8,
    undefined,
    s.capabilities,
    s.processRead,
  );
  expect([
    agentTotal(s, c, "cpu"),
    agentTotal(s, c, "cache"),
    meterOf(s, c, "cpu").values.agents,
    point(s, c).agents,
  ]).toEqual([42, null, 42, 42]);
  s.processRead = "incomplete";
  expect([
    agentTotal(s, c, "cpu"),
    agentTotal(s, c, "cache"),
    point(s, c).agents,
  ]).toEqual([null, null, null]);
});

test("unjudged names each cause whose own reading could not be taken", () => {
  const c = defaults();
  const laneId = "agents.slice/l.scope";
  const otherLane = "agents.slice/m.scope";
  const groupPath = "agents.slice/h.scope";
  const scratchPath = "/scratch";
  const otherScratch = "/scratch-b";
  /** Every reading a cause can fail to take, taken and under its threshold. */
  const read = (): Snapshot => {
    const s = healthy();
    s.lanes = [laneSnapshot({ id: laneId }), laneSnapshot({ id: otherLane })];
    s.groups = [
      g("app.slice", c.desktopSlice, { swap: 0 }),
      g(groupPath, "h.scope", { memory: 10, high: 100 }),
    ];
    s.storage.scratch = [scratchPath, otherScratch].map((path) => ({
      path,
      bytes: 0,
      age: 0,
      error: null,
      origin: "configured",
    }));
    return s;
  };
  /** Every subject `read()` holds: the host, both lanes and both groups. */
  const held = new Set(["", laneId, otherLane, "app.slice", groupPath]);
  const pressures = (lane: Partial<Lane>) => (s: Snapshot) => {
    s.lanes = s.lanes.map((x) => (x.id === laneId ? { ...x, ...lane } : x));
  };
  const laneUnread = pressures({
    pressure: null,
    memoryPressure: null,
    ioPressure: null,
  });
  const rows: [string, (s: Snapshot) => void, Unjudged][] = [
    ["every reading taken", () => {}, {}],
    ["io pressure", (s) => delete s.system.pressure.io, { disk: held }],
    [
      "cpu pressure",
      (s) => delete s.system.pressure.cpu,
      { "system-cpu": held },
    ],
    [
      "memory pressure",
      (s) => delete s.system.pressure.memory,
      { "system-memory": held },
    ],
    [
      "desktop swap",
      (s) => {
        s.groups = s.groups.map((x) =>
          x.name === c.desktopSlice ? { ...x, swap: null } : x,
        );
      },
      { "desktop-swap": held },
    ],
    // A slice with no root in the sample has no swap to judge: it is gone.
    [
      "desktop slice gone",
      (s) => {
        s.groups = s.groups.filter((x) => x.name !== c.desktopSlice);
      },
      {},
    ],
    // A lane's own unread pressure marks its stall alone, never a host cause
    // that did not fire, and never the other lane.
    ["lane pressure", laneUnread, { stalls: new Set([laneId]) }],
    [
      "one lane resource",
      pressures({ pressure: null }),
      { stalls: new Set([laneId]) },
    ],
    // A resource that crossed fires the stall whatever another failed to read.
    [
      "one lane resource beside one that crossed",
      pressures({ pressure: null, memoryPressure: c.pressureAmber + 1 }),
      {},
    ],
    // A host cause judges every lane on its host reading alone, so a lane's
    // own unread pressure marks only its stall, whichever host cause fired.
    [
      "lane pressure under host CPU that fired",
      (s) => {
        s.system.pressure.cpu = { some: c.pressureRed + 1, full: 0, total: 0 };
        laneUnread(s);
      },
      { stalls: new Set([laneId]) },
    ],
    [
      "lane pressure under host memory that fired",
      (s) => {
        s.system.pressure.memory = {
          some: c.pressureRed + 1,
          full: 0,
          total: 0,
        };
        laneUnread(s);
      },
      { stalls: new Set([laneId]) },
    ],
    [
      "lane pressure under disk that fired",
      (s) => {
        s.system.pressure.io = { some: c.pressureAmber + 1, full: 0, total: 0 };
        s.groups.push(g("app.slice/w.scope", "w.scope", { writeRate: 1 }));
        laneUnread(s);
      },
      { stalls: new Set([laneId]) },
    ],
    [
      "lane pressure under desktop swap that fired",
      (s) => {
        s.groups = s.groups.map((x) =>
          x.name === c.desktopSlice ? { ...x, swap: c.swapFloor + 1 } : x,
        );
        laneUnread(s);
      },
      { stalls: new Set([laneId]) },
    ],
    [
      "group memory",
      (s) => {
        s.groups = s.groups.map((x) =>
          x.path === groupPath ? { ...x, memory: null } : x,
        );
      },
      { "memory-high": new Set([groupPath]) },
    ],
    // A null limit reads alike for `max` and an unread file: judged absent.
    [
      "group memory with no limit",
      (s) => {
        s.groups = s.groups.map((x) =>
          x.path === groupPath ? { ...x, memory: null, high: null } : x,
        );
      },
      {},
    ],
    [
      "scratch size",
      (s) => {
        s.storage.scratch = s.storage.scratch.map((x) =>
          x.path === scratchPath ? { ...x, bytes: null } : x,
        );
      },
      { scratch: new Set([scratchPath]) },
    ],
    // A subject the sample no longer holds is gone, not unread.
    [
      "lane gone",
      (s) => {
        s.lanes = [];
      },
      {},
    ],
    [
      "group gone",
      (s) => {
        s.groups = s.groups.filter((x) => x.path !== groupPath);
      },
      {},
    ],
    [
      "scratch path gone",
      (s) => {
        s.storage.scratch = [];
      },
      {},
    ],
    [
      "lane gone with cpu pressure unread",
      (s) => {
        s.lanes = s.lanes.filter((x) => x.id !== laneId);
        delete s.system.pressure.cpu;
      },
      { "system-cpu": new Set(["", otherLane, "app.slice", groupPath]) },
    ],
  ];
  for (const [name, change, expected] of rows) {
    const s = read();
    change(s);
    expect({ name, unjudged: unjudged(s, c) }).toEqual({
      name,
      unjudged: expected,
    });
  }
});
