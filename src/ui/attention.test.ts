import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import type { CapabilityId, Snapshot } from "../model/types";
import { meters, topSwapHolder } from "../model/verdict";
import {
  emptySnapshot,
  everyCauseSnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
  volumeSnapshot,
} from "../test/fixture";
import { attention, meterTile, unread, verdictLine } from "./attention";

const base = ["/usr/bin", "/bin"];
test("overview promotes active problems and does not call past events current", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.alerts = [
    { rule: "memory-cap", subject: "old", message: "past event", time: 0 },
  ];
  expect(attention(s, c, base)).toEqual([]);
  expect(verdictLine([], s)).toBe("Healthy");
  s.lanes = [laneSnapshot({ dangerous: true })];
  const problems = attention(s, c, base);
  expect(problems).toHaveLength(1);
  expect(problems[0].target).toEqual({ kind: "lane", id: s.lanes[0].id });
  expect(problems[0].danger).toBe(true);
});

test("every card kind ends with a next step of its own", () => {
  const c = defaults();
  const items = attention(everyCauseSnapshot(c), c, base);
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
  const items = attention(s, c, base);
  expect(verdictLine(items, s)).toBe(
    "Danger: 1 lane runs outside agents.slice: escaped",
  );
  const swapCard = items.find((item) => item.id === "desktop-swap");
  expect(swapCard?.title).toBe("Desktop swapped out: 512.0 MiB in app.slice");
  expect(swapCard?.detail).toBe(
    "gnome holds 992 B. Agents hold 80.0 GiB of page cache, which the desktop cannot use.",
  );
  s.lanes = s.lanes.filter((l) => !l.unconfined);
  s.storage.volumes = [];
  expect(verdictLine(attention(s, c, base), s)).toBe(
    "Slow: Disk I/O saturated: writer writing 200.0 MiB/s",
  );
  s.system.pressure.io = { some: 1, full: 0, total: 0 };
  expect(verdictLine(attention(s, c, base), s)).toBe(
    "Slow: desktop swapped out, agents hold 80.0 GiB of page cache",
  );
  // A scratch overage is a card, but it never speaks for the machine.
  const idle = emptySnapshot();
  idle.storage.scratch = [
    { path: "/scratch", bytes: c.scratchQuota + 1, age: 0, error: null },
  ];
  const housekeeping = attention(idle, c, base);
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
    laneSnapshot({ id: `lane-${i}`, name: `kendex-${i}`, ioPressure: 40 }),
  );
  const stalls = attention(s, c, base).filter((item) => item.id === "stalls");
  expect(stalls).toHaveLength(1);
  expect(stalls[0].title).toBe(
    "9 lanes are stalling on a resource: kendex-0, kendex-1, kendex-2, kendex-3 and 5 more",
  );
  expect(stalls[0].detail).toBe(
    "Highest stall share 40.0% of the recent window.",
  );
  expect(stalls[0].target?.kind).not.toBe("lane");
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
  const card = attention(s, c, base).find((item) => item.id === "unconfined");
  if (!card) throw new Error("Expected one unconfined card");
  expect(card.title).toBe(
    "2 lanes run outside agents.slice: kendex hclaude, kendex nclaude",
  );
  expect(card.detail).toContain("shadowed");
  expect(card.detail).toContain("/home/user/.shadow/bin");
  expect(card.detail).toContain("Launched bare");
  expect(card.command).toBe(
    "systemd-run --user --slice=agents.slice --scope -- claude",
  );
  expect(card.target?.kind).not.toBe("lane");
  // The marker list is configuration, so a different marker changes the verdict.
  const other = attention(s, { ...c, capMarkers: ["MAKEFLAGS"] }, base).find(
    (item) => item.id === "unconfined",
  );
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
  const card = attention(s, c, base).find((item) => item.id === "disk");
  if (!card) throw new Error("Expected a disk card");
  expect(card.title).toBe(
    "Disk I/O saturated: lane-510341 writing 200.0 MiB/s",
  );
  expect(card.detail).toBe(
    "Tasks stalled on storage 70.0% of the recent window, 41.0% of it with nothing else to run, with 2 linkers running in that lane. Waiting on storage: lane-510341, waiter.",
  );
  expect(card.command).toBe(`cat ${c.cgroupRoot}/a/510341.scope/io.stat`);
  expect(card.danger).toBe(true);
  // One card, not a second generic stalls card, and it opens the writer lane.
  expect(attention(s, c, base).map((item) => item.id)).toEqual(["disk"]);
  expect(card.target).toEqual({ kind: "lane", id: "a/510341.scope" });
  expect(card.view).toBe("Agents");
  expect(card.next).toContain("build job count for that lane");
  // A desktop scope that is not a lane sends the reader to Resources instead.
  s.groups[0].path = "app.slice/gnome.scope";
  const scope = attention(s, c, base)[0];
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
  expect(attention(s, c, base)).toEqual([]);
});

test("read-only mounts and device errors are one card each, not one per mount", () => {
  const s = emptySnapshot();
  const bad = { readOnly: true, delta: { "x/corruption_errs": 1 } };
  s.storage.volumes = [volumeSnapshot("/a", bad), volumeSnapshot("/b", bad)];
  const items = attention(s, defaults(), base);
  expect(items.map((item) => item.id)).toEqual(["read-only", "device-errors"]);
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
  const items = attention(s, c, base);
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
  const disk = attention(s, c, base).find((item) => item.id === "disk");
  expect(disk?.command).toBe(`cat ${c.cgroupRoot}/w.scope/io.stat`);
  // A command is text the reader is invited to copy and run, so an optional
  // value interpolated into one would reach them as the word "undefined".
  for (const item of attention(everyCauseSnapshot(c), c, base)) {
    expect(item.command ?? "").not.toContain("undefined");
    expect(item.command ?? "").not.toContain("null");
  }
});

test("the memory-reclaim card carries the scope its own text names", () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const holder = topSwapHolder(s.groups, c);
  expect(holder).toBeDefined();
  const items = attention(s, c, base);
  const memory = items.find((item) => item.id === "system-memory");
  const swapped = items.find((item) => item.id === "desktop-swap");
  expect(memory).toBeDefined();
  expect(swapped).toBeDefined();
  // Both cards name this one scope in their own text, so both carry it and
  // both open on the same row. Naming it and carrying nothing left the card
  // opening on whichever row the screen already had selected.
  expect(memory?.target).toEqual({ kind: "group", path: holder?.path ?? "" });
  expect(swapped?.target).toEqual(memory?.target);
  // And they name it the same way, decoded rather than as its raw unit.
  expect(memory?.detail).toContain("gnome holds the most swap");
  expect(memory?.detail).not.toContain(".scope");
});
