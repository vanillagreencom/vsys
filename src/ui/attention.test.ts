import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import type { CapabilityId, Snapshot } from "../model/types";
import { causeOrder, causes, meters, topSwapHolder } from "../model/verdict";
import {
  emptySnapshot,
  escapedSnapshot,
  everyCauseSnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
  volumeSnapshot,
} from "../test/fixture";
import { attention, meterTile, unread, verdictLine } from "./attention";
import { wrapLines } from "./columns";

const base = ["/usr/bin", "/bin"];
test("overview promotes active problems and does not call past events current", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.alerts = [
    { rule: "memory-cap", subject: "old", message: "past event", time: 0 },
  ];
  expect(attention(s, c, { basePath: base })).toEqual([]);
  expect(verdictLine([], s)).toBe("Healthy");
  s.lanes = [laneSnapshot({ dangerous: true })];
  const problems = attention(s, c, { basePath: base });
  expect(problems).toHaveLength(1);
  expect(problems[0].target).toEqual({ kind: "lane", id: s.lanes[0].id });
  expect(problems[0].danger).toBe(true);
});

test("every card kind ends with a next step of its own", () => {
  const c = defaults();
  const items = attention(everyCauseSnapshot(c), c, { basePath: base });
  expect(items.length).toBeGreaterThan(10);
  for (const item of items) {
    expect(item.next.length).toBeGreaterThan(20);
    expect(item.next).not.toBe(item.title);
    expect(item.next).not.toBe(item.detail);
    const text = [item.title, item.detail, item.headline];
    expect(text.every((line) => line.length > 0)).toBe(true);
  }
  // Every cause appears once, so no card text repeats anywhere in the list.
  const text = items.flatMap((item) => [item.title, item.detail, item.next]);
  expect(new Set(text).size).toBe(text.length);
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
});

test("the verdict is the worst cause, formatted with its numbers", () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const items = attention(s, c, { basePath: base });
  expect(verdictLine(items, s)).toBe(
    "Danger: 1 lane runs outside agents.slice: escaped PID 40",
  );
  const swapCard = items.find((item) => item.id === "desktop-swap");
  expect(swapCard?.title).toBe("Desktop swapped out: 512.0 MiB in app.slice");
  expect(swapCard?.detail).toBe(
    "gnome holds 992 B. Agents hold 80.0 GiB of page cache, which the desktop cannot use.",
  );
  // A card whose title names lanes names them again in its detail.
  const detail = (id: string) => items.find((item) => item.id === id)?.detail;
  expect(detail("memory-cap")).toEndWith(" Lane: capped PID 40.");
  expect(detail("unconfined")).toEndWith(" Lane: escaped PID 40.");
  s.lanes = s.lanes.filter((l) => !l.unconfined);
  s.storage.volumes = [];
  expect(verdictLine(attention(s, c, { basePath: base }), s)).toBe(
    "Slow: Disk I/O saturated: writer PID 40 writing 200.0 MiB/s",
  );
  s.system.pressure.io = { some: 1, full: 0, total: 0 };
  expect(verdictLine(attention(s, c, { basePath: base }), s)).toBe(
    "Slow: desktop swapped out, agents hold 80.0 GiB of page cache",
  );
  // A scratch overage is a card, but it never speaks for the machine.
  const idle = emptySnapshot();
  idle.storage.scratch = [
    { path: "/scratch", bytes: c.scratchQuota + 1, age: 0, error: null },
  ];
  const housekeeping = attention(idle, c, { basePath: base });
  expect(housekeeping.map((item) => item.verdictWorthy)).toEqual([false]);
  expect(verdictLine(housekeeping, idle)).toBe("Healthy");
  idle.system.pressure = {};
  expect(verdictLine([], idle)).toBe(
    "Health unknown: no pressure data on this kernel",
  );
});

test("nine stalling lanes produce one card that names them", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = Array.from({ length: 9 }, (_, i) =>
    laneSnapshot({
      id: `lane-${i}`,
      name: "kendex",
      mainPid: 100 + i,
      ioPressure: 40,
    }),
  );
  const stalls = attention(s, c, { basePath: base }).filter(
    (item) => item.id === "stalls",
  );
  expect(stalls).toHaveLength(1);
  expect(stalls[0].title).toBe(
    "9 lanes are stalling on a resource: kendex PID 100, kendex PID 101, kendex PID 102, kendex PID 103 and 5 more",
  );
  // The title lists four; the detail under it names every lane.
  const every = Array.from({ length: 9 }, (_, i) => `kendex PID ${100 + i}`);
  expect(stalls[0].detail).toBe(
    `Highest stall share 40.0% of the recent window. Lanes: ${every.join(", ")}.`,
  );
  expect(stalls[0].target?.kind).not.toBe("lane");
  const cause = causes(s, c).find((x) => x.id === "stalls");
  expect(cause?.consumer).toBe("kendex PID 100");
});

test("unconfined lanes are one card that states the launcher conclusion", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({
      id: "a",
      name: "kendex hclaude",
      pids: [11],
      unconfined: true,
    }),
    laneSnapshot({
      id: "b",
      name: "kendex nclaude",
      pids: [21],
      unconfined: true,
    }),
  ];
  s.procs = [
    processSnapshot({
      pid: 11,
      group: "/app.slice/tmux-spawn-4.scope",
      env: { CARGO_BUILD_JOBS: "16", PATH: "/home/user/.shadow/bin:/usr/bin" },
    }),
    processSnapshot({
      pid: 21,
      group: "/app.slice/tmux-spawn-3.scope",
      env: {},
    }),
  ];
  const card = attention(s, c, { basePath: base }).find(
    (item) => item.id === "unconfined",
  );
  if (!card) throw new Error("Expected one unconfined card");
  expect(card.title).toBe(
    "2 lanes run outside agents.slice: kendex hclaude PID 40, kendex nclaude PID 40",
  );
  expect(card.detail).toContain("shadowed");
  expect(card.detail).toContain("/home/user/.shadow/bin");
  expect(card.detail).toContain("Launched bare");
  expect(card.command).toBe(
    "systemd-run --user --slice=agents.slice --scope -- claude",
  );
  expect(card.target?.kind).not.toBe("lane");
  // The marker list is configuration, so a different marker changes the verdict.
  const other = attention(
    s,
    { ...c, capMarkers: ["MAKEFLAGS"] },
    { basePath: base },
  ).find((item) => item.id === "unconfined");
  expect(other?.detail).not.toContain("shadowed");
});

test("a saturated disk card names the lane, its linkers and a read command", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.system.pressure.io = { some: 70, full: 41, total: 0 };
  s.groups = [
    groupSnapshot({
      path: "a/510341.scope",
      name: "510341.scope",
      writeRate: 209715200,
    }),
  ];
  s.lanes = [
    laneSnapshot({ id: "a/510341.scope", name: "lane-510341", pids: [1, 2] }),
    laneSnapshot({ id: "waiter", name: "waiter", ioPressure: 30 }),
  ];
  s.procs = [
    processSnapshot({ pid: 1, build: "ld.mold" }),
    processSnapshot({ pid: 2, build: "mold" }),
  ];
  const card = attention(s, c, { basePath: base }).find(
    (item) => item.id === "disk",
  );
  if (!card) throw new Error("Expected a disk card");
  expect(card.title).toBe(
    "Disk I/O saturated: lane-510341 PID 40 writing 200.0 MiB/s",
  );
  expect(card.detail).toBe(
    "Tasks stalled on storage 70.0% of the recent window, 41.0% of it with nothing else to run, with 2 linkers running in that lane. Waiting on storage: lane-510341 PID 40, waiter PID 40.",
  );
  expect(card.command).toBe(`cat ${c.cgroupRoot}/a/510341.scope/io.stat`);
  expect(card.danger).toBe(true);
  // One card, not a second generic stalls card, and it opens the writer lane.
  expect(attention(s, c, { basePath: base }).map((item) => item.id)).toEqual([
    "disk",
  ]);
  expect(card.target).toEqual({ kind: "lane", id: "a/510341.scope" });
  expect(card.view).toBe("Agents");
  expect(card.next).toContain("build job count for that lane");
  // A desktop scope that is not a lane sends the reader to Resources instead.
  s.groups[0].path = "app.slice/gnome.scope";
  const scope = attention(s, c, { basePath: base })[0];
  expect(scope.view).toBe("Resources");
  expect(scope.target?.kind).not.toBe("lane");
  expect(scope.next).toContain("what is writing in that scope");
});

test("counted nouns in the meters and the cards are singular at one", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.procs = [processSnapshot({ pid: 1, build: "ld.mold" })];
  const builds = () => meterTile(meters(s, c)[3], s, c);
  expect(builds().value).toBe("1 of 8 cores");
  expect(builds().detail).toBe("1 linker · 1 lane");
  expect(builds().facts).toEqual([
    ["Compile and link", "1 of 8 cores"],
    ["Linkers", "1"],
    ["Lanes building", "1"],
    ["Busiest agent", "not available"],
  ]);
  s.procs.push(processSnapshot({ pid: 2, build: "mold", group: "/b.scope" }));
  expect(builds().detail).toBe("2 linkers · 2 lanes");
});

test("source read failures are not a machine problem and raise no card", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.errors = [
    { source: "/proc/1", message: "permission denied" },
    { source: "/proc/1", message: "permission denied" },
    { source: "/proc/2", message: "permission denied" },
  ];
  expect(attention(s, c, { basePath: base })).toEqual([]);
});

test("read-only mounts and device errors are one card each, not one per mount", () => {
  const s = emptySnapshot();
  const bad = { readOnly: true, delta: { "x/corruption_errs": 1 } };
  s.storage.volumes = [volumeSnapshot("/a", bad), volumeSnapshot("/b", bad)];
  const items = attention(s, defaults(), { basePath: base });
  // Nothing has checked either mount for damage, so the unchecked card is
  // there too; the point here is that neither cause draws one card per mount.
  expect(items.map((item) => item.id)).toEqual([
    "read-only",
    "device-errors",
    "unchecked",
  ]);
  expect(items[0].title).toBe("2 mounts are read-only: /a, /b");
});

test("the memory meter names the largest scope and only then the swap holder", () => {
  const c = defaults();
  const s = emptySnapshot();
  const g = (path: string, name: string, o = {}) =>
    groupSnapshot({ path, name, ...o });
  s.groups = [
    g("app.slice", c.desktopSlice, { swap: 0 }),
    g("app.slice/gnome.scope", "gnome.scope", { swap: 992, memory: 4 }),
    g("b.scope", "b.scope", { memory: 900 }),
  ];
  const tile = (snapshot: Snapshot) =>
    meterTile(meters(snapshot, c)[1], snapshot, c);
  expect(tile(s).value).toBe("500 B");
  expect(tile(s).detail).toBe("of 1000 B · swap 0 B");
  expect(tile(s).facts).toEqual([
    ["Used", "500 B of 1000 B"],
    ["Agent page cache", "not available"],
    ["Desktop swap", "0 B"],
    ["Largest", "b 900 B"],
  ]);
  expect(meters(s, c)[1].level).toBe("ok");
  s.groups[0].swap = c.swapFloor + 1;
  expect(tile(s).facts.slice(2)).toEqual([
    ["Desktop swap", "512.0 MiB"],
    ["Largest", "b 900 B"],
    ["Most swapped", "gnome 992 B"],
  ]);
  // Swap vsys could not read is a warning, never an untroubled reading.
  s.groups[0].swap = null;
  expect(meters(s, c)[1].level).toBe("warn");
  expect(tile(s).detail).toBe("of 1000 B · swap not available");
});

test("the disk meter reports free space and says when mounts are unreadable", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.system.pressure.io = { some: 12, full: 3, total: 0 };
  s.storage.volumes = [volumeSnapshot("/full", { free: 5368709120 })];
  const tile = (snapshot: Snapshot) =>
    meterTile(meters(snapshot, c)[2], snapshot, c);
  expect(tile(s).value).toBe("12.0%");
  expect(tile(s).facts).toEqual([
    ["Tasks waiting", "12.0% · nothing runnable 3.0%"],
    ["Least free", "5.0 GiB free"],
    ["Top writer", "not available"],
  ]);
  // A readable mount whose free space is unknown says so, in the same words.
  s.storage.volumes[0].free = null;
  expect(tile(s).detail).toBe("not available free");
  s.storage.mountsAvailable = false;
  expect(tile(s).detail).toBe("mount information unavailable");
  const bare = emptySnapshot();
  expect(tile(bare).detail).toBe("no watched filesystems");
});

test("a meter names the interface behind a missing reading", () => {
  const c = defaults();
  const s = emptySnapshot();
  const drop = (id: CapabilityId) => {
    s.capabilities = s.capabilities.map((cap) =>
      cap.id === id
        ? { ...cap, available: false, failure: "absent" as const }
        : cap,
    );
  };
  const facts = (index: number) =>
    Object.fromEntries(meterTile(meters(s, c)[index], s, c).facts);
  const cpu = () => facts(0);
  const memory = () => facts(1);
  const disk = () => facts(2);
  // On a complete host an unread quantity says only that it is unread.
  s.system.pressure.cpu = null;
  expect(cpu()).toEqual({
    "Time tasks waited": "not available",
    "Cores agents use": "not available",
    "Cores desktop uses": "not available",
    "Busiest agent": "not available",
  });
  drop("psi");
  expect(cpu()["Time tasks waited"]).toBe(
    "not available: no PSI on this kernel",
  );
  expect(cpu()["Cores agents use"]).toBe("not available");
  expect(disk()["Tasks waiting"]).toBe(
    "not available: no PSI on this kernel · nothing runnable not available: no PSI on this kernel",
  );
  // A reading the kernel did supply is unaffected by an absence elsewhere.
  s.system.pressure.io = { some: 12, full: 3, total: 0 };
  expect(disk()["Tasks waiting"]).toBe("12.0% · nothing runnable 3.0%");
  // Each absent interface explains only the numbers it would have supplied.
  drop("io-stat");
  expect(disk()["Top writer"]).toBe(
    "not available: no io.stat for these resource groups",
  );
  expect(memory()).toEqual({
    Used: "500 B of 1000 B",
    "Agent page cache": "not available",
    "Desktop swap": "not available",
    Largest: "not available",
  });
  drop("delegation");
  const delegated =
    "not available: resource control is not delegated to this login session";
  expect(memory()).toEqual({
    Used: "500 B of 1000 B",
    "Agent page cache": delegated,
    "Desktop swap": delegated,
    Largest: delegated,
  });
  expect(cpu()["Cores agents use"]).toBe(delegated);
});

test("a snapshot stored before the probe reads plainly and never claims a cause", () => {
  const c = defaults();
  const s = emptySnapshot();
  // What History.at returns for a row an older build wrote.
  s.capabilities = [];
  s.system.pressure.cpu = null;
  expect(meterTile(meters(s, c)[0], s, c).facts).toEqual([
    ["Time tasks waited", "not available"],
    ["Cores agents use", "not available"],
    ["Cores desktop uses", "not available"],
    ["Busiest agent", "not available"],
  ]);
  expect(unread(s, "psi")).toBe("not available");
  expect(unread(s)).toBe("not available");
});

test("a card that names one row carries it, and a card naming none carries nothing", () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const items = attention(s, c, { basePath: base });
  const target = (id: string) => items.find((item) => item.id === id)?.target;
  // Each card points at the thing its own sentence names.
  expect(target("scratch")).toEqual({ kind: "path", path: "/scratch" });
  expect(target("read-only")).toEqual({ kind: "path", path: "/ro" });
  expect(target("device-errors")).toEqual({ kind: "path", path: "/bad" });
  expect(target("free-space")).toEqual({ kind: "path", path: "/full" });
  expect(target("scrub")).toEqual({ kind: "path", path: "/scrub" });
  expect(target("memory-high")).toEqual({ kind: "group", path: "h.scope" });
  expect(target("desktop-swap")).toEqual({
    kind: "group",
    path: "app.slice/gnome.scope",
  });
  expect(target("memory-cap")).toEqual({ kind: "lane", id: "lane-capped" });
  // A machine-wide stall names no single row, so it points at none.
  expect(target("system-cpu")).toBeUndefined();
  // Every target the cards carry is one the destination can resolve.
  for (const item of items) {
    const at = item.target;
    if (!at) continue;
    if (at.kind === "lane")
      expect(s.lanes.some((l) => l.id === at.id)).toBe(true);
    if (at.kind === "group")
      expect(s.groups.some((g) => g.path === at.path)).toBe(true);
  }
});

test("no card offers a command with an unresolved value in it", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.system.pressure.io = { some: 70, full: 41, total: 0 };
  s.groups = [
    groupSnapshot({ path: "w.scope", name: "w.scope", writeRate: 209715200 }),
  ];
  s.lanes = [laneSnapshot({ id: "waiter", name: "waiter", ioPressure: 30 })];
  const disk = attention(s, c, { basePath: base }).find(
    (item) => item.id === "disk",
  );
  expect(disk?.command).toBe(`cat ${c.cgroupRoot}/w.scope/io.stat`);
  // A command is text the reader is invited to copy and run, so an optional
  // value interpolated into one would reach them as the word "undefined".
  for (const item of attention(everyCauseSnapshot(c), c, { basePath: base })) {
    expect(item.command ?? "").not.toContain("undefined");
    expect(item.command ?? "").not.toContain("null");
  }
});

test("the memory-reclaim card carries the scope its own text names", () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const holder = topSwapHolder(s.groups, c);
  expect(holder).toBeDefined();
  const items = attention(s, c, { basePath: base });
  const memory = items.find((item) => item.id === "system-memory");
  const swapped = items.find((item) => item.id === "desktop-swap");
  expect(memory).toBeDefined();
  expect(swapped).toBeDefined();
  // Both cards name this one scope in their own text, so both carry it and
  // both open on the same row. Naming it and carrying nothing left the card
  // opening on whichever row the screen already had selected.
  expect(memory?.target).toEqual({ kind: "group", path: holder?.path ?? "" });
  // And it points there without claiming the scope is one of the things
  // reclaim stalled: the swap cause is about that scope and carries it as a
  // subject, the reclaim cause only says where to look.
  const ladder = causes(s, c);
  expect(ladder.find((cause) => cause.id === "system-memory")?.groups).toEqual(
    [],
  );
  expect(ladder.find((cause) => cause.id === "desktop-swap")?.groups).toEqual(
    holder ? [holder] : [],
  );
  expect(swapped?.target).toEqual(memory?.target);
  // And they name it the same way, decoded rather than as its raw unit.
  expect(memory?.detail).toContain("gnome holds the most swap");
  expect(memory?.detail).not.toContain(".scope");
});

const escapedFleet = (lanes: number, perLane = 1) =>
  escapedSnapshot({ lanes, perLane });

test("the unconfined card writes one sentence per conclusion, not per process", () => {
  const c = defaults();
  const card = attention(escapedFleet(2, 6), c, { basePath: base }).find(
    (item) => item.id === "unconfined",
  );
  if (!card) throw new Error("Expected one unconfined card");
  // Twelve processes over two scopes are two sentences, each naming its scope
  // once with the count of processes in it.
  expect(card.detail.split("Launched bare")).toHaveLength(3);
  expect(card.detail).toContain("6 processes in the scope tmux-spawn-0.scope");
  expect(card.detail).toContain("6 processes in the scope tmux-spawn-1.scope");
  // The marker list is named once per group, never once per process.
  expect(card.detail.split("RUST_TEST_THREADS")).toHaveLength(3);
  // The title counts lanes and the sentences count processes, so the sentence
  // naming the lanes states both counts and reconciles them.
  expect(card.detail).toEndWith(
    "12 processes in 2 lanes: kendex agent-0 PID 1000, kendex agent-1 PID 1006.",
  );
  // One process per lane is the boundary: the counts agree, so the sentence
  // states the lanes alone.
  const even = attention(escapedFleet(2, 1), c, { basePath: base }).find(
    (item) => item.id === "unconfined",
  );
  expect(even?.detail).toEndWith(
    "Lanes: kendex agent-0 PID 1000, kendex agent-1 PID 1001.",
  );
});

test("a card's detail is cut to its line budget at the width it is drawn at", () => {
  const c = defaults();
  const crowded = escapedFleet(30, 4);
  crowded.system.pressure = {
    cpu: { some: 90, full: 0, total: 0 },
    memory: { some: 80, full: 0, total: 0 },
  };
  // Lanes stalling with no saturated disk under them, so the crowded machine
  // raises the causes everyCauseSnapshot cannot raise beside a disk cause.
  for (const lane of crowded.lanes) lane.ioPressure = 40;
  // Twelve scopes are twelve conclusions, which no width holds: the machine
  // that makes the cut run rather than only the cards that fit without it.
  const scattered = escapedSnapshot({ lanes: 12, scopes: 12 });
  let cut = 0;
  const measured = new Set<string>();
  // The floor detailWidth allows, an ordinary panel, and a wide one.
  for (const s of [everyCauseSnapshot(c), crowded, scattered])
    for (const width of [20, 38, 120]) {
      const items = attention(s, c, { basePath: base, width });
      for (const item of items) {
        measured.add(item.id);
        // Six rows, written out: a budget checked against the constant it is
        // built from passes whatever that constant is raised to.
        expect(wrapLines(item.detail, width).length).toBeLessThanOrEqual(6);
        if (item.detail.includes("…")) cut++;
      }
    }
  // A card that writes no ladder of its own is cut by the same budget: the
  // disk card on a panel at the floor is one.
  const narrow = attention(everyCauseSnapshot(c), c, {
    basePath: base,
    width: 20,
  }).find((item) => item.id === "disk");
  expect(narrow?.detail).toEndWith("…");
  expect(narrow?.detail).toContain("Tasks stalled on storage");
  // A lane whose name alone overruns the rows the sentence has: the name is
  // cut with its mark, and both counts the card promises are whole, because
  // the names are on the screen Enter opens and the counts are only here.
  const long = escapedSnapshot({ lanes: 2 });
  for (const lane of long.lanes)
    lane.name = `${"kendex vsys/issue-1234 ".repeat(5)}hclaude`;
  const tight = attention(long, c, { basePath: base, width: 20 }).find(
    (item) => item.id === "unconfined",
  );
  expect(tight?.detail).toBe(
    "2 groups of processes: 2 bare. Lanes: kendex vsys/is… and 1 more.",
  );
  expect(wrapLines(tight?.detail ?? "", 20)).toHaveLength(4);
  // Every cause the ladder can report was measured, read from the ladder's
  // own table rather than a list kept here: a cause added without a fixture
  // is a cause whose detail nothing measures.
  expect([...measured].sort()).toEqual(Object.keys(causeOrder).sort());
  // And a machine crowded enough to overrun the budget did overrun it, so the
  // cut above is a cut that ran rather than a case that never reached it.
  expect(cut).toBeGreaterThan(0);
});

test("a narrow card gives up the chain, then a conclusion, and counts both", () => {
  const c = defaults();
  const s = escapedSnapshot({ lanes: 12, scopes: 12 });
  const detail = (width: number) =>
    attention(s, c, { basePath: base, width }).find(
      (item) => item.id === "unconfined",
    )?.detail ?? "";
  // Wide enough for the ancestors of every conclusion.
  expect(detail(400)).toContain("Started from PID");
  expect(detail(400)).not.toContain("not written here");
  // Narrower, the ancestors go first. They are the part of the card the
  // reader can read again on the screen Enter opens.
  expect(detail(300)).not.toContain("Started from PID");
  expect(detail(300)).toContain("tmux-spawn-11.scope");
  // Then a conclusion at a time, from the last, and what goes is counted the
  // way the title counts the lanes it stopped at.
  expect(detail(200)).not.toContain("tmux-spawn-11.scope");
  expect(detail(200)).toContain(
    "And 5 more groups of processes not written here.",
  );
  // The first conclusion stays whole with its scope, so a card is never left
  // with no conclusion at all, and what it keeps it keeps whole rather than
  // as the head of a sentence the cut took the rest of.
  expect(detail(56)).toContain(
    "is set on PID 1000 in the scope tmux-spawn-0.scope.",
  );
  expect(detail(56).split("Launched bare")).toHaveLength(2);
  expect(detail(56)).not.toMatch(/Launched bare[^.]*…/);
  expect(detail(56)).toContain(
    "And 11 more groups of processes not written here.",
  );
  // Two groups in one cgroup: the one given up is counted even though the one
  // kept still names that cgroup, and one group is one, not one groups.
  const shared = escapedSnapshot({ lanes: 2, scopes: 1 });
  shared.procs[2].env = { CARGO_BUILD_JOBS: "16" };
  const merged =
    attention(shared, c, { basePath: base, width: 44 }).find(
      (item) => item.id === "unconfined",
    )?.detail ?? "";
  expect(merged).toContain("The launcher was shadowed");
  expect(merged).toContain("And 1 more group of processes not written here.");
  expect(merged).not.toContain("  ");
  expect(
    attention(escapedSnapshot({ lanes: 2, scopes: 2 }), c, {
      basePath: base,
      width: 44,
    }).find((item) => item.id === "unconfined")?.detail,
  ).toContain("And 1 more group of processes not written here.");
  // At the floor a panel can be, one whole conclusion and the count of what
  // went do not fit in the rows beside the lane sentence, so the card counts
  // every conclusion instead. Nothing it shows there is cut.
  expect(detail(20)).toBe(
    "12 groups of processes: 12 bare. Lanes: kendex agent-… and 11 more.",
  );
  expect(wrapLines(detail(20), 20)).toHaveLength(4);
  // Each kind is counted under the name the sentences give it.
  expect(
    attention(shared, c, { basePath: base, width: 20 }).find(
      (item) => item.id === "unconfined",
    )?.detail,
  ).toStartWith("2 groups of processes: 1 bare, 1 shadowed.");
});

test("the lane sentence stops rather than growing with the machine", () => {
  const c = defaults();
  const s = escapedFleet(57, 1);
  const card = attention(s, c, { basePath: base, width: 60 }).find(
    (item) => item.id === "unconfined",
  );
  if (!card) throw new Error("Expected one unconfined card");
  // It stops at the lanes it has room for and says how many it did not name.
  const lanes = card.detail.slice(card.detail.lastIndexOf("Lanes: "));
  expect(lanes).toBe(
    "Lanes: kendex agent-0 PID 1000, kendex agent-1 PID 1001, " +
      "kendex agent-2 PID 1002 and 54 more.",
  );
  // A wider panel is more room for the same sentence, not more sentences.
  const wide = attention(s, c, { basePath: base, width: 160 }).find(
    (item) => item.id === "unconfined",
  );
  const wider = wide?.detail.slice(wide.detail.lastIndexOf("Lanes: ")) ?? "";
  expect(wrapLines(wider, 160)).toHaveLength(2);
  expect(wider.split(", ").length).toBeGreaterThan(lanes.split(", ").length);
  // A panel too narrow for four names names fewer and still counts the rest,
  // because the budget holds before the list does.
  const four = attention(escapedFleet(4, 1), c, {
    basePath: base,
    width: 24,
  }).find((item) => item.id === "unconfined");
  expect(four?.detail).toEndWith("Lanes: kendex agent-0 PID 1000 and 3 more.");
  // One lane has no second name to count, so a name too long for the rows it
  // has is written whole and cut by the budget, never counted as 0 more.
  const alone = escapedSnapshot({ lanes: 1 });
  alone.lanes[0].name = `${"kendex vsys/issue-1234 ".repeat(3)}hclaude`;
  const single = attention(alone, c, { basePath: base, width: 24 }).find(
    (item) => item.id === "unconfined",
  );
  expect(single?.detail).not.toContain("and 0 more");
  // The name is cut to the rows the sentence has, marked where it stopped.
  expect(single?.detail).toBe(
    "1 group of processes: 1 bare. Lane: kendex vsys/issue-1234 kendex…",
  );
  expect(wrapLines(single?.detail ?? "", 24)).toHaveLength(3);
});

test("a storage card never tells the reader to delete data a rebuild cannot replace", () => {
  const c = defaults();
  const s = emptySnapshot();
  const scrub = (
    addresses: { logical: number; paths: string[]; changed?: string[] }[],
  ) => ({
    path: "/run/btrfs-scrub/root.result",
    text: "Error summary: csum=1",
    problem: true,
    readable: true,
    fsid: "fs",
    startedAt: s.time - 1000,
    status: "finished",
    uncorrectable: 1,
    addresses,
  });
  s.storage.volumes = [
    volumeSnapshot("/", {
      fsid: "fs",
      errors: { "1/corruption_errs": 1 },
      countersAvailable: true,
    }),
  ];
  // Every damaged address is build output, so deleting all of them is safe.
  s.storage.scrubs = [scrub([{ logical: 1, paths: ["/r/target/a"] }])];
  const build = attention(s, c, { basePath: base }).find(
    (i) => i.id === "damaged-files",
  );
  expect(build?.next).toContain("delete every path listed");
  // One address holds a file only a backup restores, and the step changes.
  s.storage.scrubs = [
    scrub([
      { logical: 1, paths: ["/r/target/a"] },
      { logical: 2, paths: ["/home/r/letter.txt"] },
    ]),
  ];
  const mixed = attention(s, c, { basePath: base }).find(
    (i) => i.id === "damaged-files",
  );
  expect(mixed?.next).toContain("Delete only the addresses it marks as build");
  expect(mixed?.next).not.toContain("delete every path");
  // All build output, but one address was written since the check, so that
  // one carries no command either and the step cannot say delete everything.
  s.storage.scrubs = [
    scrub([
      { logical: 1, paths: ["/r/target/a"] },
      { logical: 2, paths: ["/r/target/b"], changed: ["/r/target/b"] },
    ]),
  ];
  const stale = attention(s, c, { basePath: base }).find(
    (i) => i.id === "damaged-files",
  );
  expect(stale?.next).toContain("Delete only the addresses it marks as build");
});

test("an unchecked card counts never-checked filesystems apart from stale ones", () => {
  const c = defaults();
  const s = emptySnapshot();
  const checked = (fsid: string, mount: string, startedAt: number | null) => {
    s.storage.volumes.push(
      volumeSnapshot(mount, {
        fsid,
        errors: { "1/corruption_errs": 0 },
        countersAvailable: true,
      }),
    );
    if (startedAt !== null)
      s.storage.scrubs.push({
        path: `/run/btrfs-scrub/${fsid}.result`,
        text: "Error summary: no errors found",
        problem: false,
        readable: true,
        fsid,
        startedAt,
        status: "finished",
        uncorrectable: 0,
        addresses: [],
      });
  };
  // One never checked, one checked long enough ago to be stale.
  checked("never", "/a", null);
  checked("old", "/b", s.time - 40 * 86400000);
  const card = attention(s, c, { basePath: base }).find(
    (item) => item.id === "unchecked",
  );
  // The title cannot call both of them never checked: a timer did check one.
  expect(card?.title).toBe(
    "2 filesystems unchecked for damage, 1 of them never: /a, /b",
  );
  // Both alone still read as what they are.
  const alone = emptySnapshot();
  alone.storage.volumes = [volumeSnapshot("/only", { fsid: "only" })];
  expect(
    attention(alone, c, { basePath: base }).find(
      (item) => item.id === "unchecked",
    )?.title,
  ).toBe("1 filesystem never checked for damage: /only");
});

test("a card naming several filesystems shows no one filesystem's numbers", () => {
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
  grown("a", 26);
  const one = attention(s, c, { basePath: base }).find(
    (item) => item.id === "new-errors",
  );
  expect(one?.detail).toContain("26 failed reads");
  // A second filesystem, and the first one's count no longer speaks for both.
  grown("b", 9);
  const two = attention(s, c, { basePath: base }).find(
    (item) => item.id === "new-errors",
  );
  expect(two?.detail).not.toContain("26");
  expect(two?.detail).toContain("Open each one for its own times");
});
