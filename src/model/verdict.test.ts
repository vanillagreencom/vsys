import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import type { Snapshot } from "./types";
import {
  buildLoad,
  desktopSwap,
  laneLinkers,
  meters,
  topSwapHolder,
  topWriter,
  verdict,
} from "./verdict";

const format = {
  bytes: (n: number | null) => (n === null ? "?" : `${n}B`),
  percent: (n: number | null) => (n === null ? "?" : `${n}%`),
};
function healthy(): Snapshot {
  const s = emptySnapshot();
  s.system.pressure = {
    cpu: { some: 1, full: 0, total: 0 },
    memory: { some: 0, full: 0, total: 0 },
    io: { some: 1, full: 0, total: 0 },
  };
  return s;
}

test("a healthy machine gets a healthy verdict", () => {
  const state = verdict(healthy(), defaults());
  expect(state.level).toBe("ok");
  expect(state.headline).toBe("Healthy");
});

test("an unconfined lane outranks every slowness verdict", () => {
  const c = defaults();
  const s = healthy();
  s.system.pressure.io = { some: 70, full: 40, total: 0 };
  s.lanes = [laneSnapshot({ name: "kendex hclaude", unconfined: true })];
  const state = verdict(s, c);
  expect(state.level).toBe("danger");
  expect(state.headline).toBe(`Danger: 1 lane runs outside ${c.agentSlice}`);
  expect(state.detail).toContain("kendex hclaude");
});

test("a saturated disk names the scope that is writing", () => {
  const s = healthy();
  s.system.pressure.io = { some: 70, full: 40, total: 0 };
  s.groups = [
    groupSnapshot({
      path: "agents.slice/x.scope",
      name: "x.scope",
      writeRate: 10,
    }),
    groupSnapshot({
      path: "agents.slice/510341.scope",
      name: "510341.scope",
      writeRate: 200,
    }),
  ];
  s.lanes = [
    laneSnapshot({ id: "agents.slice/510341.scope", name: "lane-510341" }),
  ];
  expect(verdict(s, defaults()).headline).toBe(
    "Slow: disk I/O saturated by lane-510341",
  );
});

test("a swapped desktop is a verdict of its own", () => {
  const c = defaults();
  const s = healthy();
  s.groups = [
    groupSnapshot({
      path: "app.slice",
      name: c.desktopSlice,
      swap: c.swapFloor + 1,
    }),
    groupSnapshot({ path: "agents.slice", name: c.agentSlice, cache: 80 }),
  ];
  const state = verdict(s, c);
  expect(state.level).toBe("danger");
  expect(state.headline).toContain("desktop swapped out");
  expect(state.headline).toContain("80 bytes");
});

test("missing pressure data does not become a healthy verdict", () => {
  const s = emptySnapshot();
  s.system.pressure = {};
  expect(verdict(s, defaults()).headline).toContain("Health unknown");
});

test("four meters each name the biggest consumer", () => {
  const c = defaults();
  const s = healthy();
  s.system.cores = 32;
  s.groups = [
    groupSnapshot({
      path: "agents.slice",
      name: c.agentSlice,
      cpuPercent: 11.8,
      cache: 80,
    }),
    groupSnapshot({
      path: "app.slice",
      name: c.desktopSlice,
      cpuPercent: 40,
      swap: c.swapFloor + 1,
    }),
    groupSnapshot({
      path: "app.slice/shell.scope",
      name: "shell.scope",
      swap: 992,
      memory: 5,
    }),
    groupSnapshot({
      path: "agents.slice/b.scope",
      name: "b.scope",
      writeRate: 200,
      memory: 9,
    }),
  ];
  s.lanes = [laneSnapshot({ name: "lane-a", cpu: 30 })];
  s.procs = [
    processSnapshot({ pid: 1, build: "rustc", group: "/agents.slice/b.scope" }),
    processSnapshot({ pid: 2, build: "mold", group: "/agents.slice/b.scope" }),
  ];
  const [cpu, memory, disk, builds] = meters(s, c, format);
  expect(meters(s, c, format)).toHaveLength(4);
  expect(cpu.value).toBe("agents 11.8% | desktop 40%");
  expect(cpu.who).toContain("lane-a");
  expect(memory.value).toContain("agent cache 80B");
  expect(memory.who).toContain("shell.scope");
  expect(memory.level).toBe("danger");
  expect(disk.who).toContain("b.scope");
  expect(disk.who).toContain("200B/s");
  expect(builds.value).toBe(
    "2 compile and link processes / 32 cores | 1 linkers",
  );
  expect(builds.who).toBe("1 lane building");
});

test("slice and scope helpers pick the right group", () => {
  const c = defaults();
  const s = healthy();
  s.groups = [
    groupSnapshot({ path: "app.slice", name: c.desktopSlice, swap: 10 }),
    groupSnapshot({ path: "app.slice/a.scope", name: "a.scope", swap: 7 }),
    groupSnapshot({ path: "app.slice/b.scope", name: "b.scope", swap: 3 }),
    // A parent slice always outwrites its children and must never be the "who".
    groupSnapshot({ path: "agents.slice", name: c.agentSlice, writeRate: 999 }),
    groupSnapshot({
      path: "agents.slice/c.scope",
      name: "c.scope",
      writeRate: 5,
    }),
  ];
  expect(desktopSwap(s.groups, c)).toBe(10);
  expect(topSwapHolder(s.groups, c)?.name).toBe("a.scope");
  expect(topWriter(s.groups)?.name).toBe("c.scope");
});

test("build load counts linkers separately and per lane", () => {
  const c = defaults();
  const s = healthy();
  s.procs = [
    processSnapshot({ pid: 1, build: "rustc", group: "/agents.slice/a.scope" }),
    processSnapshot({ pid: 2, build: "mold", group: "/agents.slice/a.scope" }),
    processSnapshot({ pid: 3, build: "mold", group: "/agents.slice/b.scope" }),
  ];
  expect(buildLoad(s, c)).toEqual({ builds: 3, linkers: 2, lanes: 2 });
  expect(laneLinkers(s, laneSnapshot({ pids: [1, 2] }), c)).toBe(1);
});
