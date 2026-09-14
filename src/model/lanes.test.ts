import { expect, test } from "bun:test";
import { type PaneAddress, serverPart } from "../collect/tmux";
import { defaults } from "../config/config";
import { groupSnapshot, processSnapshot } from "../test/fixture";
import {
  effectiveMax,
  lanes,
  ownPaneMark,
  parentChain,
  processTree,
} from "./lanes";
import type { Lane } from "./types";

/** What one tmux read gave, defaulting to a vsys that draws in no pane. */
const tmuxRead = (byId: Map<string, PaneAddress>, socket = "", own = "") => ({
  socket,
  own,
  byId,
});

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

test("a name carries no disambiguator, and what separates two is on the lane", () => {
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
  // One worktree and two panes: nothing about the two names differs, and
  // nothing is appended to make one. An id on some rows and not others reads
  // as arbitrary; the screens carry it in a column of its own instead.
  const same2 = lanes(groups, [same(1, "%17"), same(2, "%21")], c);
  expect(same2.map((l) => l.name)).toEqual([
    ".2claude claude kendex",
    ".2claude claude kendex",
  ]);
  for (const lane of same2) {
    expect(lane.name).not.toContain("PID");
    expect(lane.name).not.toContain("%");
  }
  // What tells them apart is on the lane for a column to draw: the process
  // that leads each one, and the pane handle it acts through.
  expect(same2.map((l) => l.mainPid)).toEqual([1, 2]);
  expect(same2.map((l) => l.pane)).toEqual(["%17", "%21"]);
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
  const [byAddress] = lanes(groups, [configured], c, 0, tmuxRead(panes));
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
    tmuxRead(panes),
  );
  expect({ address: byHandle.address, window: byHandle.window }).toEqual({
    address: "work:3.2",
    window: "build",
  });
});

test("a pane on another tmux server resolves to nothing, not to a stranger", () => {
  const c = defaults();
  const groups = [
    groupSnapshot({ path: "a.scope", name: "a.scope" }),
    groupSnapshot({ path: "b.scope", name: "b.scope" }),
  ];
  const path = "/tmp/tmux-1000/default";
  // The server vsys read, named the way the collector names it: from the
  // `TMUX` of vsys's own shell rather than written out by hand, so a test
  // cannot agree with a lane by a spelling production does not use.
  const socket = serverPart(`${path},4242,3`);
  // Two lanes carrying the same handle, because `%9` is unique per server and
  // says nothing across one. One belongs to the server vsys read; the other
  // does not.
  const here = processSnapshot({
    pid: 1,
    group: "a.scope",
    tool: "claude",
    env: { TMUX_PANE: "%9", TMUX: `${path},4242,0` },
  });
  const away = processSnapshot({
    pid: 2,
    group: "b.scope",
    tool: "claude",
    env: { TMUX_PANE: "%9", TMUX: "/tmp/tmux-1000/other,777,0" },
  });
  const panes = new Map([["%9", { address: "work:1.1", window: "build" }]]);
  const [mine, theirs] = lanes(
    groups,
    [here, away],
    c,
    0,
    tmuxRead(panes, socket),
  );
  // The lane on this server reads as it always did.
  expect({
    address: mine.address,
    window: mine.window,
    elsewhere: mine.elsewhere,
  }).toEqual({ address: "work:1.1", window: "build", elsewhere: false });
  // The other resolves to nothing and says why. Compared by handle alone both
  // rows showed `work:1.1`, and a switch would have moved the reader to a pane
  // they have never seen.
  expect({
    address: theirs.address,
    window: theirs.window,
    elsewhere: theirs.elsewhere,
  }).toEqual({ address: "", window: "", elsewhere: true });
  // A boundary vsys cannot see is not one it refuses at: with no server known
  // for the read, or none for the lane, both resolve as before.
  const [unknownServer] = lanes(groups, [away], c, 0, tmuxRead(panes));
  expect(unknownServer.elsewhere).toBe(false);
  const bare = processSnapshot({
    pid: 3,
    group: "a.scope",
    tool: "claude",
    env: { TMUX_PANE: "%9" },
  });
  const [unknownLane] = lanes(groups, [bare], c, 0, tmuxRead(panes, socket));
  expect(unknownLane.elsewhere).toBe(false);
  expect(unknownLane.address).toBe("work:1.1");
});

test("a restarted server on the same socket path is a different server", () => {
  const c = defaults();
  const groups = [
    groupSnapshot({ path: "a.scope", name: "a.scope" }),
    groupSnapshot({ path: "b.scope", name: "b.scope" }),
  ];
  const path = "/tmp/tmux-1000/default";
  // Measured on this machine: every client of one server carries the same
  // `socket,serverpid` and differs only in the session after it.
  const socket = serverPart(`${path},4242,3`);
  // A server that died and restarted takes the default socket path back, and
  // hands out `%N` from one again. This process outlived its own server, so
  // its `%9` is not the `%9` the running server holds.
  const stale = processSnapshot({
    pid: 1,
    group: "a.scope",
    tool: "claude",
    env: { TMUX_PANE: "%9", TMUX: `${path},777,0` },
  });
  // Another client of the server vsys read, in a different session. The path
  // and the pid both match, so nothing that compared equal stops doing so.
  const sibling = processSnapshot({
    pid: 2,
    group: "b.scope",
    tool: "claude",
    env: { TMUX_PANE: "%9", TMUX: `${path},4242,7` },
  });
  const panes = new Map([["%9", { address: "work:1.1", window: "build" }]]);
  const [dead, live] = lanes(
    groups,
    [stale, sibling],
    c,
    0,
    tmuxRead(panes, socket),
  );
  // Compared by path alone the stale lane showed `work:1.1` and offered a
  // switch, and the reader would have landed in a stranger's pane.
  expect({ address: dead.address, elsewhere: dead.elsewhere }).toEqual({
    address: "",
    elsewhere: true,
  });
  expect({ address: live.address, elsewhere: live.elsewhere }).toEqual({
    address: "work:1.1",
    elsewhere: false,
  });
});

test("vsys's own pane is marked however the lane's target spells it", () => {
  const c = defaults();
  const groups = [groupSnapshot({ path: "a.scope", name: "a.scope" })];
  const path = "/tmp/tmux-1000/default";
  const socket = serverPart(`${path},4242,3`);
  const ours = `${path},4242,0`;
  // vsys draws in `%146`, which this server calls `vsys:2.1` in a window named
  // `build`. `vsys:3` is a window of two panes, neither of them vsys's, and
  // another session uses the window name `build` again.
  const panes = new Map([
    ["%146", { address: "vsys:2.1", window: "build" }],
    ["%30", { address: "vsys:3.1", window: "editor" }],
    ["%31", { address: "vsys:3.2", window: "editor" }],
    ["%40", { address: "work:1.1", window: "build" }],
  ]);
  const asRead = { socket, own: "%146", byId: panes };
  const agent = (env: Record<string, string>) =>
    processSnapshot({ pid: 1, group: "a.scope", tool: "claude", env });
  const mark = (env: Record<string, string>, read = asRead) =>
    lanes(groups, [agent(env)], c, 0, read)[0]?.self;
  // The row's name, what the lane's own environment held, and the answer it
  // earns. Every one of these targets is a target tmux takes, so the mark
  // rests on which pane the target reaches and never on how it was spelled.
  type Row = [string, Record<string, string>, Lane["self"]];
  const rows: Row[] = [
    // vsys's own pane, in each spelling of it.
    ["address", { VSYS_PANE: "vsys:2.1" }, "yes"],
    ["window by name", { VSYS_PANE: "vsys:build.1" }, "yes"],
    ["pane left to tmux", { VSYS_PANE: "vsys:2" }, "yes"],
    ["exact match", { VSYS_PANE: "=vsys:2.1" }, "yes"],
    ["exact window name", { VSYS_PANE: "=vsys:=build.1" }, "yes"],
    // Another pane, in the same spellings. The map names it, vsys's own is
    // not it, and the lane keeps its terminal.
    ["another address", { VSYS_PANE: "vsys:3.1" }, "no"],
    ["another window by name", { VSYS_PANE: "vsys:editor.2" }, "no"],
    // Two panes, and vsys's own is neither, so which one tmux would pick does
    // not change the answer.
    ["another window, pane left to tmux", { VSYS_PANE: "vsys:3" }, "no"],
    // A window name belongs to its session, so this is a third pane again.
    [
      "that window name in another session",
      { VSYS_PANE: "work:build.1" },
      "no",
    ],
    // The map cannot say which pane these name: no session to match on, a name
    // tmux would match as a prefix, and a window this map does not hold. Each
    // could be vsys's own, so vsys says it cannot tell rather than `no`, which
    // is the answer that would run the capture against its own pane.
    ["no session", { VSYS_PANE: "2.1" }, "unknown"],
    ["window by prefix", { VSYS_PANE: "vsys:bui.1" }, "unknown"],
    ["a window the map does not hold", { VSYS_PANE: "vsys:9.1" }, "unknown"],
    // The same target, from a lane whose own shell tmux put in vsys's pane.
    // That handle settles what the target could not.
    [
      "unresolved, shell in vsys's pane",
      { VSYS_PANE: "vsys:bui.1", TMUX_PANE: "%146" },
      "yes",
    ],
    // And from a lane whose shell is elsewhere, which leaves it undecided:
    // the reader's target still might be vsys's pane spelled that way.
    [
      "unresolved, shell in another pane",
      { VSYS_PANE: "vsys:bui.1", TMUX_PANE: "%30" },
      "unknown",
    ],
  ];
  for (const [row, env, self] of rows)
    expect({ row, self: mark({ TMUX: ours, ...env }) }).toEqual({ row, self });
  // A window of two panes, one of them vsys's own, with the pane index left
  // out. tmux sends the capture to whichever pane is active and the map does
  // not say which that is, so the target may be vsys's own pane.
  const split = {
    ...asRead,
    byId: new Map([
      ["%146", { address: "vsys:2.1", window: "build" }],
      ["%147", { address: "vsys:2.2", window: "build" }],
    ]),
  };
  expect(mark({ TMUX: ours, VSYS_PANE: "vsys:2" }, split)).toBe("unknown");
  // Unless the lane's own shell is the pane vsys draws in.
  expect(
    mark({ TMUX: ours, VSYS_PANE: "vsys:2", TMUX_PANE: "%146" }, split),
  ).toBe("yes");
  // A `list-panes` that failed leaves no map, so no address spelling resolves
  // at all. The handle tmux exported into the lane's own pane is what is left,
  // and it names the pane vsys draws in.
  const lost = { ...asRead, byId: new Map() };
  expect(
    mark({ TMUX: ours, VSYS_PANE: "vsys:build.1", TMUX_PANE: "%146" }, lost),
  ).toBe("yes");
  // A lane on a server known to differ is still answered `no`: `elsewhere`
  // stops it earlier, and no spelling of a stranger's pane changes that.
  expect(
    mark({ TMUX: "/tmp/tmux-1000/other,777,0", VSYS_PANE: "vsys:build.1" }),
  ).toBe("no");
  // A vsys drawing in no pane, holding a target the map cannot resolve. Every
  // lane above reaches `no` through a target the map did resolve; this one has
  // nothing resolved to compare, and is still `no` because a vsys that draws
  // in no pane has no screen to nest and nothing to collide with.
  expect(ownPaneMark("vsys:bui.1", "", false, panes, null)).toBe("no");
  // A read that came back with the window's other pane but not vsys's own row,
  // which is what a vsys drawing in a tmux popup gets. A window-shaped target
  // names that window, and tmux would send the capture to whichever pane is
  // active there, which may be vsys's own. The map never said where vsys
  // draws, so it cannot rule that out and may not answer `no`.
  const partial = new Map([["%99", { address: "vsys:2.2", window: "build" }]]);
  expect(ownPaneMark("vsys:2", "%146", false, partial, null)).toBe("unknown");
  // A handle target is settled against vsys's own handle with no map at all,
  // so the same partial read still answers `no` and the guard above cannot be
  // widened into one that refuses every lane after a partial read.
  expect(ownPaneMark("%99", "%146", false, partial, null)).toBe("no");
  // Three targets tmux resolves to vsys's own pane that a comparison on the
  // text alone sends elsewhere. Each answered `no` before, which is the answer
  // that runs the capture, and the capture carries the lane's raw target.
  //
  // A handle padded with zeros. `%00146` and `%146` are one pane to tmux, and
  // the map is keyed by tmux's own output, which never pads.
  expect(ownPaneMark("%00146", "%146", false, panes, null)).toBe("yes");
  // A handle in the pane component, which tmux resolves without reference to
  // the window beside it, against a server holding a window whose literal name
  // is that whole dotted string.
  const collide = new Map([
    ["%146", { address: "vsys:2.1", window: "build" }],
    ["%9", { address: "vsys:5.1", window: "build.%146" }],
  ]);
  expect(ownPaneMark("vsys:build.%146", "%146", false, collide, null)).toBe(
    "yes",
  );
  // A bare `+` is the next window to tmux, not the window named `+`, and a
  // server can hold both readings at once. vsys cannot tell which pane tmux
  // would reach, so it says so rather than naming the window it can see.
  const relative = new Map([
    ["%1", { address: "vsys:1.0", window: "other" }],
    ["%2", { address: "vsys:2.0", window: "+" }],
  ]);
  expect(ownPaneMark("vsys:+", "%1", false, relative, null)).toBe("unknown");
  // The exact-match prefix names that window in tmux and here alike, so it
  // stays decided and the lane keeps its terminal.
  expect(ownPaneMark("vsys:=+", "%1", false, relative, null)).toBe("no");
});

test("the pane vsys draws in is marked on the lane, in either form it carries", () => {
  const c = defaults();
  const groups = ["a", "b", "d", "e"].map((n) =>
    groupSnapshot({ path: `${n}.scope`, name: `${n}.scope` }),
  );
  const path = "/tmp/tmux-1000/default";
  const socket = serverPart(`${path},4242,3`);
  // vsys draws in `%146`, which this server calls `vsys:2.1`.
  const panes = new Map([
    ["%146", { address: "vsys:2.1", window: "vsys" }],
    ["%12", { address: "work:1.1", window: "build" }],
  ]);
  const ours = `${path},4242,0`;
  const theirs = "/tmp/tmux-1000/other,777,0";
  /** vsys's own pane, in the two forms a lane can carry it. */
  const own = "%146";
  const ownAt = "vsys:2.1";
  const agent = (pid: number, scope: string, env: Record<string, string>) =>
    processSnapshot({ pid, group: `${scope}.scope`, tool: "claude", env });
  const asRead = { socket, own, byId: panes };
  // The two forms a lane carries vsys's own pane, against the three things a
  // lane can say about its server. One rule decides every row: the capture
  // and the switch run against vsys's own server, so a pane string matching
  // vsys's own reaches vsys's own pane whatever server handed it out, and the
  // mark is made unless the lane is known to be on another server. The lane
  // that names none is marked for that reason, not refused for naming none.
  // The address the lane resolves to is a separate question: only a lane on a
  // known other server resolves to nothing.
  // The row's name, the lane's own environment, then the three it earns:
  // whether it is vsys's own pane, whether it is on another server, and the
  // address it resolves to. `ours` and `theirs` name the server it sat on.
  type Row = [string, Record<string, string>, Lane["self"], boolean, string];
  const rows: Row[] = [
    ["handle, ours", { TMUX: ours, TMUX_PANE: own }, "yes", false, ownAt],
    ["address, ours", { TMUX: ours, VSYS_PANE: ownAt }, "yes", false, ownAt],
    ["handle, theirs", { TMUX: theirs, TMUX_PANE: own }, "no", true, ""],
    ["address, theirs", { TMUX: theirs, VSYS_PANE: ownAt }, "no", true, ""],
    ["handle, no server", { TMUX_PANE: own }, "yes", false, ownAt],
    ["address, no server", { VSYS_PANE: ownAt }, "yes", false, ownAt],
  ];
  for (const [row, env, self, elsewhere, address] of rows) {
    const [lane] = lanes(groups, [agent(1, "a", env)], c, 0, asRead);
    expect({
      row,
      self: lane.self,
      elsewhere: lane.elsewhere,
      address: lane.address,
    }).toEqual({ row, self, elsewhere, address });
  }
  const env = { TMUX: ours };
  // The shell vsys runs in, which is an agent lane like any other: it exports
  // the handle tmux gave it.
  const byHandle = agent(1, "a", { ...env, TMUX_PANE: own });
  // A reader who configured `VSYS_PANE` carries the same pane as an address,
  // and a comparison against the handle alone would not recognise it.
  const byAddress = agent(2, "b", { ...env, VSYS_PANE: ownAt });
  // A pane on vsys's own server that is not the one vsys draws in: the server
  // matching is what the mark rests on, never what it is.
  const other = agent(3, "d", { ...env, TMUX_PANE: "%12" });
  // The same in the address form. With the map in hand vsys knows its own
  // address, so an address that is not it is a settled `no` rather than the
  // undecided answer the failed read gives below.
  const otherAddress = agent(4, "e", { ...env, VSYS_PANE: "work:1.1" });
  const lot = [byHandle, byAddress, other, otherAddress];
  const read = lanes(groups, lot, c, 0, asRead);
  expect(read.map((lane) => lane.self)).toEqual(["yes", "yes", "no", "no"]);
  // Outside tmux vsys occupies no pane, so no lane is its own screen and every
  // one of them is still readable. Nothing is undecided either: a vsys that
  // draws in no pane has no comparison left to fail.
  const outside = lanes(groups, lot, c, 0, { ...asRead, own: "" });
  expect(outside.map((lane) => lane.self)).toEqual(["no", "no", "no", "no"]);
  // A `list-panes` that failed leaves no map. The handle form is still
  // decided, because vsys's own handle comes from its own environment and
  // compares directly. The address form is not: only the map says which pane
  // `vsys:2.1` is, so vsys cannot tell whether this lane holds the pane it
  // draws in, and it says that rather than `no`. Answering `no` is what let
  // the capture run against vsys's own pane on the sample after a failed read.
  // The third lane is the reason only the address form goes undecided: a
  // handle that is not vsys's own is settled without the map too, so a failed
  // read does not cost the reader every terminal on the machine.
  const refused = lanes(groups, [byHandle, byAddress, other], c, 0, {
    ...asRead,
    byId: new Map(),
  });
  expect(refused.map((lane) => lane.self)).toEqual(["yes", "unknown", "no"]);
  // The lane keeps the address the reader configured either way: the map is
  // what vsys lost, not what the reader typed.
  expect(refused[1]?.pane).toBe(ownAt);
});
