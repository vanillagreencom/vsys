import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import {
  emptySnapshot,
  everyCauseSnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
  volumeSnapshot,
} from "../test/fixture";
import type { Group, Snapshot } from "./types";
import {
  buildLoad,
  causeRank,
  causes,
  laneLinkers,
  leastFree,
  meters,
  sliceRoots,
  sliceSum,
  topSwapHolder,
  topWriter,
  worstKind,
} from "./verdict";

const g = (path: string, name: string, o: Partial<Group> = {}) =>
  groupSnapshot({ path, name, ...o });
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
  expect(ladder[0].lanes.map((l) => l.name)).toEqual(["kendex hclaude"]);
  // A warn disk cause is authored first, so only a sort puts the scrub above it.
  s.lanes = [];
  s.system.pressure.io = { some: 15, full: 2, total: 0 };
  s.storage.scrubs = [{ path: "/scrub", text: "errors", problem: true }];
  s.storage.scratch = [
    { path: "/scratch", bytes: c.scratchQuota + 1, age: 0, error: null },
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
  expect(causes(s, c)[0].values.cache).toBe(7);
  expect(meters(s, c)[1].values.cache).toBe(7);
  // The default slice name must not be consulted anywhere.
  expect(meters(s, defaults())[1].values.cache).toBeNull();
});

test("a saturated disk names the writing scope and carries its numbers", () => {
  const s = healthy();
  s.system.pressure.io = { some: 70, full: 41, total: 0 };
  s.groups = [
    g("a/x.scope", "x.scope", { writeRate: 10 }),
    g("a/510341.scope", "510341.scope", { writeRate: 200 }),
  ];
  s.lanes = [
    laneSnapshot({ id: "a/510341.scope", name: "lane-510341", pids: [1] }),
    laneSnapshot({ id: "other", name: "waiter", ioPressure: 30 }),
    laneSnapshot({ id: "cpu-bound", name: "cruncher", pressure: 30 }),
  ];
  s.procs = [processSnapshot({ pid: 1, build: "ld.mold" })];
  expect(worstKind(s.lanes[1])).toBe("io");
  expect(worstKind(s.lanes[2])).toBe("cpu");
  const ladder = causes(s, defaults());
  expect(ladder[0]).toMatchObject({
    id: "disk",
    level: "danger",
    consumer: "lane-510341 PID 40",
    values: { some: 70, full: 41, writeRate: 200, linkers: 1, stalling: 1 },
  });
  // Storage stallers join the disk card; only the CPU one stays generic.
  expect(ladder.map((cause) => cause.id)).toEqual(["disk", "stalls"]);
  expect(ladder[0].lanes.map((l) => l.name)).toEqual(["lane-510341", "waiter"]);
  expect(ladder[1].lanes.map((l) => l.name)).toEqual(["cruncher"]);
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
  expect(meters(s, c)[2].values.free).toBe(5);
  // Above the floor there is no cause at all.
  s.storage.volumes = [volume("/big", c.freeFloor + 1)];
  expect(causes(s, c).find((item) => item.id === "free-space")).toBeUndefined();
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
  const [cpu, memory, disk, builds] = meters(s, c);
  expect(meters(s, c)).toHaveLength(4);
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
    "device-errors",
    "disk",
    "desktop-swap",
    "free-space",
    "memory-cap",
    "scrub",
    "system-memory",
    "system-cpu",
    "memory-high",
    "scratch",
  ]);
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
