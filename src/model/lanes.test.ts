import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { groupSnapshot, processSnapshot } from "../test/fixture";
import { lanes, parentChain, processTree } from "./lanes";

test("process trees keep children under their own parent despite PID order", () => {
  const a = processSnapshot({ pid: 40, ppid: 1, start: 10 });
  const b = processSnapshot({ pid: 20, ppid: 1, start: 20 });
  const child = processSnapshot({ pid: 10, ppid: 40, start: 30 });
  const grandchild = processSnapshot({ pid: 30, ppid: 10, start: 40 });
  expect(
    processTree([child, b, grandchild, a]).map(({ proc, depth }) => [
      proc.pid,
      depth,
    ]),
  ).toEqual([
    [40, 0],
    [10, 1],
    [30, 2],
    [20, 0],
  ]);
  expect(parentChain(child, [child, { ...a, start: 50 }])).toEqual([]);
});

test("an ungrouped lane takes its main PID from the scope root, not enumeration order", () => {
  const c = defaults();
  const wrapper = processSnapshot({
    pid: 100,
    ppid: 1,
    start: 100,
    comm: "wrapper",
    cwd: "/repo/wrapper",
    group: "/user.slice/escaped",
  });
  const child = processSnapshot({
    pid: 50,
    ppid: 100,
    start: 200,
    comm: "claude",
    cwd: "/repo/child",
    group: "/user.slice/escaped",
  });
  const [only] = lanes([], [child, wrapper], c);
  expect([only.mainPid, only.name]).toEqual([100, "default claude wrapper"]);
});

test("two agents in one worktree under different accounts get different names", () => {
  const c = defaults();
  const groups = [
    groupSnapshot({ path: "agents.slice/a.scope", name: "a.scope", pids: [1] }),
    groupSnapshot({ path: "agents.slice/b.scope", name: "b.scope", pids: [2] }),
  ];
  const procs = [
    processSnapshot({
      pid: 1,
      cwd: "/repo/kendex",
      group: "/agents.slice/a.scope",
      env: { CLAUDE_CONFIG_DIR: "/home/x/.2claude", TMUX_PANE: "%3" },
    }),
    processSnapshot({
      pid: 2,
      comm: "codex",
      tool: "codex",
      cwd: "/repo/kendex",
      group: "/agents.slice/b.scope",
      env: { CODEX_HOME: "/home/x/.codex", VSYS_PANE_TITLE: "review" },
    }),
  ];
  const [a, b] = lanes(groups, procs, c);
  expect(a.name).toBe(".2claude claude %3 kendex");
  expect(b.name).toBe(".codex codex review kendex");
  expect([a.account, a.pane, b.title]).toEqual([".2claude", "%3", "review"]);
});

test("a lane reports its cgroup, its charged resources and its effective caps", () => {
  const c = defaults();
  const groups = [
    groupSnapshot({
      path: "agents.slice",
      name: "agents.slice",
      max: 2147483648,
    }),
    groupSnapshot({
      path: "agents.slice/a.scope",
      name: "a.scope",
      pids: [1, 2, 3, 4, 5],
      cpuPercent: 200,
      cache: 4096,
      readRate: 1048576,
      writeRate: 2097152,
      weight: 50,
      max: null,
    }),
  ];
  const group = "/agents.slice/a.scope";
  const procs = [
    processSnapshot({
      pid: 1,
      group,
      env: { MAKEFLAGS: "-j6 --jobserver-auth=fifo:/tmp/f" },
    }),
    processSnapshot({ pid: 2, group, build: "rustc", tool: null }),
    processSnapshot({ pid: 3, group, build: "ld.mold", tool: null }),
    processSnapshot({ pid: 4, group, build: "test", tool: null }),
    processSnapshot({
      pid: 5,
      group,
      tool: null,
      comm: "sccache",
      command: ["/usr/bin/sccache", "rustc"],
    }),
  ];
  const [lane] = lanes(groups, procs, c, 4);
  expect(lane.cgroup).toBe("agents.slice/a.scope");
  expect([lane.cache, lane.readRate, lane.writeRate]).toEqual([
    4096, 1048576, 2097152,
  ]);
  expect([lane.cpu, lane.cpuShare]).toEqual([200, 50]);
  expect(lane.builds).toEqual({ rustc: 1, "ld.mold": 1, test: 1 });
  expect([lane.linkers, lane.rustc, lane.tests, lane.sccache]).toEqual([
    1, 1, 1, 1,
  ]);
  expect([lane.memoryMax, lane.cpuWeight]).toEqual([2147483648, 50]);
  expect([lane.jobs, lane.jobserver]).toEqual([6, "fifo:/tmp/f"]);
});

test("counters the kernel did not report stay unknown rather than becoming zero", () => {
  const c = defaults();
  const groups = [
    groupSnapshot({
      path: "agents.slice/a.scope",
      name: "a.scope",
      pids: [1],
      cache: null,
      readRate: null,
      writeRate: null,
      cpuPercent: null,
      weight: null,
    }),
  ];
  const [lane] = lanes(
    groups,
    [
      processSnapshot({
        pid: 1,
        group: "/agents.slice/a.scope",
        cpuPercent: null,
      }),
    ],
    c,
    4,
  );
  expect([
    lane.cache,
    lane.readRate,
    lane.writeRate,
    lane.cpuShare,
    lane.cpuWeight,
    lane.memoryMax,
  ]).toEqual([null, null, null, null, null, null]);
});

test("a blocked lane counts its waiting tasks and names the resource they wait on", () => {
  const c = defaults();
  const psi = (io: number, memory: number) => ({
    cpu: { some: 1, full: 0, total: 0 },
    io: { some: io, full: 0, total: 0 },
    memory: { some: memory, full: 0, total: 0 },
  });
  const group = "/agents.slice/a.scope";
  const procs = [
    processSnapshot({ pid: 1, group, state: "D" }),
    processSnapshot({ pid: 2, group, state: "D" }),
    processSnapshot({ pid: 3, group, state: "S" }),
  ];
  const base = {
    path: "agents.slice/a.scope",
    name: "a.scope",
    pids: [1, 2, 3],
  };
  const on = (io: number, memory: number) =>
    lanes([groupSnapshot({ ...base, pressure: psi(io, memory) })], procs, c)[0];
  const storage = on(40, 5);
  expect([storage.state, storage.blocked, storage.blockedOn]).toEqual([
    "blocked",
    2,
    "io",
  ]);
  expect(on(5, 40).blockedOn).toBe("memory");
  expect(lanes([groupSnapshot(base)], procs, c)[0].blockedOn).toBeNull();
});
