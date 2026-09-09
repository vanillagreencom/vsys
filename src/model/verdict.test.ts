import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import type { Group, Snapshot } from "./types";
import {
  buildLoad,
  causes,
  laneLinkers,
  leastFree,
  meters,
  pressureKnown,
  sliceRoots,
  sliceSum,
  topSwapHolder,
  topWriter,
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
  const s = healthy();
  expect(causes(s, defaults())).toEqual([]);
  expect(pressureKnown(s)).toBe(true);
  expect(pressureKnown(emptySnapshot())).toBe(true);
  const blind = emptySnapshot();
  blind.system.pressure = {};
  expect(pressureKnown(blind)).toBe(false);
});

test("an unconfined lane leads the ladder ahead of every slowness", () => {
  const c = defaults();
  const s = healthy();
  s.system.pressure.io = { some: 70, full: 40, total: 0 };
  s.groups = [g("a.scope", "a.scope", { writeRate: 200 })];
  s.lanes = [laneSnapshot({ name: "kendex hclaude", unconfined: true })];
  const ladder = causes(s, c);
  expect(ladder.map((cause) => cause.id)).toEqual(["unconfined", "disk"]);
  expect(ladder[0]).toMatchObject({
    level: "danger",
    consumer: "kendex hclaude",
    values: { lanes: 1 },
  });
  expect(ladder[0].lanes.map((l) => l.name)).toEqual(["kendex hclaude"]);
});

test("the agent slice name comes from config, not a hardcoded name", () => {
  const c = { ...defaults(), agentSlice: "robots.slice" };
  const s = healthy();
  // A lane is unconfined only against the configured slice.
  s.groups = [
    g("robots.slice", "robots.slice", { cache: 7 }),
    g("app.slice", c.desktopSlice, { swap: c.swapFloor + 1 }),
  ];
  const swapCause = causes(s, c).find((cause) => cause.id === "desktop-swap");
  expect(swapCause?.values.cache).toBe(7);
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
  ];
  s.procs = [processSnapshot({ pid: 1, build: "ld.mold" })];
  const cause = causes(s, defaults()).find((item) => item.id === "disk");
  expect(cause).toMatchObject({
    level: "danger",
    consumer: "lane-510341",
    values: { some: 70, full: 41, writeRate: 200, linkers: 1 },
  });
});

test("disk pressure between amber and red is a warning, not a saturation", () => {
  const c = defaults();
  const s = healthy();
  s.system.pressure.io = { some: 15, full: 2, total: 0 };
  s.groups = [g("a.scope", "a.scope", { writeRate: 5 })];
  expect(causes(s, c).find((cause) => cause.id === "disk")?.level).toBe("warn");
});

test("a swapped desktop carries its swap, holder and agent page cache", () => {
  const c = defaults();
  const s = healthy();
  s.groups = [
    g("app.slice", c.desktopSlice, { swap: c.swapFloor + 1 }),
    g("app.slice/shell.scope", "shell.scope", { swap: 992 }),
    g("agents.slice", c.agentSlice, { cache: 80 }),
  ];
  const cause = causes(s, c).find((item) => item.id === "desktop-swap");
  expect(cause).toMatchObject({
    level: "danger",
    consumer: "shell.scope",
    values: { swap: c.swapFloor + 1, holder: 992, cache: 80 },
  });
});

test("a filesystem below the free-space floor is its own cause", () => {
  const c = defaults();
  const s = healthy();
  const volume = (mount: string, free: number) => ({
    mount,
    device: "/dev/x",
    fsid: mount,
    options: [],
    readOnly: false,
    free,
    total: 100,
    errors: {},
    delta: {},
    sinceStart: {},
  });
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
    consumer: "lane-a",
    values: { agents: 11.8, desktop: 40, top: 30 },
  });
  expect(memory).toEqual({
    id: "memory",
    level: "danger",
    consumer: "shell.scope",
    values: {
      used: 500,
      total: 1000,
      cache: 80,
      swap: c.swapFloor + 1,
      holder: 992,
    },
  });
  expect(disk).toEqual({
    id: "disk",
    level: "warn",
    consumer: "b.scope",
    values: { some: 12, full: 3, writeRate: 200, free: null },
  });
  expect(builds).toEqual({
    id: "builds",
    level: "ok",
    consumer: "lane-a",
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
