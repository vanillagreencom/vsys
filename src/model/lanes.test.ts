import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { groupSnapshot, processSnapshot } from "../test/fixture";
import { effectiveMax, lanes, parentChain, processTree } from "./lanes";

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
  expect([only.mainPid, only.name]).toEqual([100, "claude wrapper"]);
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
  // The accounts already separate these two, so neither carries a pane.
  expect(a.name).toBe(".2claude claude kendex");
  expect(b.name).toBe(".codex codex review kendex");
  expect([a.account, a.pane, b.title]).toEqual([".2claude", "%3", "review"]);
});

test("lanes that resolve to one name are separated by what a reader recognises", () => {
  const c = defaults();
  const same = (n: number, pane: string, cwd = "/repo/kendex") =>
    processSnapshot({
      pid: n,
      cwd,
      group: `/agents.slice/${n}.scope`,
      env: { CLAUDE_CONFIG_DIR: "/home/x/.2claude", TMUX_PANE: pane },
    });
  const groups = [1, 2].map((n) =>
    groupSnapshot({
      path: `agents.slice/${n}.scope`,
      name: `${n}.scope`,
      pids: [n],
    }),
  );
  // Different worktrees: the directory separates them.
  const byDirectory = lanes(
    groups,
    [same(1, "%3", "/repo/one"), same(2, "%9", "/repo/two")],
    c,
  );
  expect(byDirectory.map((l) => l.name)).toEqual([
    ".2claude claude one",
    ".2claude claude two",
  ]);
  // One worktree and two panes: the pane addresses differ but name nothing a
  // reader can place, so the process id separates them instead.
  const byPid = lanes(groups, [same(1, "%17"), same(2, "%21")], c);
  expect(byPid.map((l) => l.name)).toEqual([
    ".2claude claude kendex PID 1",
    ".2claude claude kendex PID 2",
  ]);
  // The pane address is kept as the handle, on the lane, out of the name.
  expect(byPid.map((l) => l.pane)).toEqual(["%17", "%21"]);
  for (const lane of byPid) expect(lane.name).not.toContain("%");
  expect(new Set(byPid.map((l) => l.name)).size).toBe(byPid.length);
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
  expect([lane.memoryMax, lane.memoryMaxKnown, lane.cpuWeight]).toEqual([
    2147483648,
    true,
    50,
  ]);
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

test("an unread cgroup tree leaves the memory cap unknown rather than unlimited", () => {
  const c = defaults();
  const covered = groupSnapshot({
    path: "agents.slice/a.scope",
    name: "a.scope",
    pids: [1],
    max: null,
  });
  const proc = processSnapshot({ pid: 1, group: "/agents.slice/a.scope" });
  expect(effectiveMax([covered], "agents.slice/a.scope")).toEqual({
    max: null,
    known: true,
  });
  expect(effectiveMax([], "agents.slice/a.scope")).toEqual({
    max: null,
    known: false,
  });
  const [scoped] = lanes([covered], [proc], c);
  expect([scoped.memoryMax, scoped.memoryMaxKnown]).toEqual([null, true]);
  const [escaped] = lanes(
    [],
    [processSnapshot({ pid: 1, group: "/app.slice/x.scope" })],
    c,
  );
  expect([escaped.memoryMax, escaped.memoryMaxKnown]).toEqual([null, false]);
});

test("a lane with no configured account leaves that part out of its name", () => {
  const c = defaults();
  const group = "/agents.slice/a.scope";
  const [lane] = lanes(
    [
      groupSnapshot({
        path: "agents.slice/a.scope",
        name: "a.scope",
        pids: [1],
      }),
    ],
    [processSnapshot({ pid: 1, group, cwd: "/repo/kendex", env: {} })],
    c,
  );
  expect([lane.account, lane.name]).toEqual([null, "claude kendex"]);
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

test("a configured pane address is the address, not a key into the server", () => {
  const c = defaults();
  const groups = [groupSnapshot({ path: "a.scope", name: "a.scope" })];
  // `paneEnv` reads VSYS_PANE first, and that carries an address rather than a
  // pane id — which is what this project's own naming test asserts wins.
  const configured = processSnapshot({
    pid: 1,
    group: "a.scope",
    tool: "claude",
    env: { VSYS_PANE: "work:2.1" },
  });
  const handle = processSnapshot({
    pid: 2,
    group: "b.scope",
    tool: "claude",
    env: { TMUX_PANE: "%12" },
  });
  const panes = new Map([["%12", { address: "work:3.2", window: "build" }]]);
  const [byAddress] = lanes(groups, [configured], c, 0, panes);
  // Looked up in a map keyed by `%N` it found nothing and the row showed no
  // address at all, for the configuration this repository documents.
  expect({ pane: byAddress.pane, address: byAddress.address }).toEqual({
    pane: "work:2.1",
    address: "work:2.1",
  });
  // What it cannot give is a window name: only the server knows those, and it
  // was not asked about this pane.
  expect(byAddress.window).toBe("");
  // A handle still resolves through the server, which is the other half.
  const [byHandle] = lanes(
    [groupSnapshot({ path: "b.scope", name: "b.scope" })],
    [handle],
    c,
    0,
    panes,
  );
  expect({ address: byHandle.address, window: byHandle.window }).toEqual({
    address: "work:3.2",
    window: "build",
  });
});
