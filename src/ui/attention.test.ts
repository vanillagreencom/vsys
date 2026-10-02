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
import { present } from "../test/present";
import {
  type Attention,
  attention,
  cardDetail,
  meterTile,
  unread,
  verdictLine,
} from "./attention";
import { wrapLines } from "./columns";

const base = ["/usr/bin", "/bin"];
/**
 * Everything a card has to say, as one string: its best way of writing the
 * description and the sentence naming the lanes, with no room taken off it.
 * The checks about the words a card writes read this; the checks about the
 * rows it has fit it against a room with `cardDetail`.
 */
const said = (item?: Attention): string =>
  [...(item?.ways[0] ?? []), item?.keep ?? ""]
    .filter((part) => part !== "")
    .join(" ");
/** The rows the description had before the room a card sits in decided it. */
const sixRows = 6;
/** A description fitted to a stated room, as the screen fits it. */
const fitted = (item: Attention | undefined, width: number, rows = sixRows) =>
  item === undefined ? [] : cardDetail(item, width, rows);
/** The rows those paragraphs draw: their own, their breaks, and the blank
 * above the action lines. */
const drawnRows = (parts: string[], width: number) =>
  parts.reduce((rows, part) => rows + wrapLines(part, width).length, 0) +
  parts.length;
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
  const problem = present(problems[0], "the lane card");
  expect(problem.target).toEqual({
    kind: "lane",
    id: present(s.lanes[0], "the dangerous lane").id,
  });
  expect(problem.danger).toBe(true);
});

test("every card kind ends with a next step of its own", () => {
  const c = defaults();
  const items = attention(everyCauseSnapshot(c), c, { basePath: base });
  expect(items.length).toBeGreaterThan(10);
  for (const item of items) {
    expect(item.next.length).toBeGreaterThan(20);
    expect(item.next).not.toBe(item.title);
    expect(item.next).not.toBe(said(item));
    const text = [item.title, said(item), item.headline];
    expect(text.every((line) => line.length > 0)).toBe(true);
  }
  // Every cause appears once, so no card text repeats anywhere in the list.
  const text = items.flatMap((item) => [item.title, said(item), item.next]);
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
  expect(said(swapCard)).toBe(
    "gnome holds 992 B. Agents hold 80.0 GiB of page cache, which the desktop cannot use.",
  );
  // A card whose title names lanes names them again in its detail.
  const detail = (id: string) => said(items.find((item) => item.id === id));
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
    {
      path: "/scratch",
      bytes: c.scratchQuota + 1,
      age: 0,
      error: null,
      origin: "configured",
    },
  ];
  const housekeeping = attention(idle, c, { basePath: base });
  expect(housekeeping.map((item) => item.verdictWorthy)).toEqual([false]);
  expect(verdictLine(housekeeping, idle)).toBe("Healthy");
  idle.system.pressure = {};
  expect(verdictLine([], idle)).toBe(
    "Health unknown: no pressure data on this kernel",
  );
});

test("a process whose agent name was not confirmed by install location gets a visible card", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.procs = [
    processSnapshot({
      pid: 99,
      comm: "pi",
      tool: null,
      unconfirmedTool: "pi",
      unconfirmedPath: "/usr/bin/pi",
    }),
  ];
  const items = attention(s, c, { basePath: base });
  expect(items.map((item) => item.id)).toEqual(["unconfirmed-tool"]);
  const card = present(items[0], "the unconfirmed-tool card");
  // Visible, but housekeeping never speaks for the machine.
  expect(card.verdictWorthy).toBe(false);
  expect(verdictLine(items, s)).toBe("Healthy");
  // The process, the tool it almost matched and the path tested are all
  // named, not only carried as fields a reader never sees.
  expect(card.title).toContain("pi");
  expect(said(card)).toContain("pi (pid 99): pi at /usr/bin/pi");
  // The reader is pointed at the Settings overlay's paths fragment.
  expect(card.view).toBe("Settings");
  expect(card.next).toContain("Settings");
  expect(card.next).toContain("paths fragment");
  expect(card.next).toContain("agent-tools.json");
});

test("several unconfirmed processes share one card, and a repeated tool name is counted once", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.procs = [
    processSnapshot({
      pid: 10,
      comm: "pi",
      tool: null,
      unconfirmedTool: "pi",
      unconfirmedPath: "/usr/bin/pi",
    }),
    // A second process naming the same tool: the title counts the tool once,
    // not once per process.
    processSnapshot({
      pid: 11,
      comm: "pi",
      tool: null,
      unconfirmedTool: "pi",
      unconfirmedPath: "/opt/pi/pi",
    }),
    processSnapshot({
      pid: 12,
      comm: "node",
      tool: null,
      unconfirmedTool: "codex",
      unconfirmedPath: "/home/reader/scripts/codex.js",
    }),
  ];
  const items = attention(s, c, { basePath: base });
  expect(items.map((item) => item.id)).toEqual(["unconfirmed-tool"]);
  const card = present(items[0], "the unconfirmed-tool card");
  // Three processes, two distinct tool names: the title's count and its name
  // list disagree in length, and neither double-counts "pi". The plural verb
  // follows the process count, not the deduped name count.
  expect(card.title).toBe(
    "3 processes carry an unconfirmed agent name: pi, codex",
  );
  expect(card.title).not.toContain("pi, pi");
  // Every process is still named in the detail, each with its own path, so
  // the two "pi" processes are not collapsed into the dedup either.
  expect(said(card)).toContain("pi (pid 10): pi at /usr/bin/pi");
  expect(said(card)).toContain("pi (pid 11): pi at /opt/pi/pi");
  expect(said(card)).toContain(
    "node (pid 12): codex at /home/reader/scripts/codex.js",
  );
  // Two processes share the tool name "pi" but differ in path: the advice
  // names every distinct path, never one path standing in for both.
  expect(card.next).toContain("/usr/bin/pi (pi)");
  expect(card.next).toContain("/opt/pi/pi (pi)");
  expect(card.next).toContain("/home/reader/scripts/codex.js (codex)");
});

test("five or more unconfirmed processes are all named, none dropped behind a count", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.procs = Array.from({ length: 6 }, (_, i) =>
    processSnapshot({
      pid: 30 + i,
      comm: `tool${i}`,
      tool: null,
      unconfirmedTool: `name${i}`,
      unconfirmedPath: `/opt/name${i}/bin`,
    }),
  );
  const card = present(
    attention(s, c, { basePath: base })[0],
    "the unconfirmed-tool card",
  );
  // Nothing else on the dashboard names an unconfirmed process, so this card
  // never elides the fifth one behind "and N more" the way a lane list does.
  for (let i = 0; i < 6; i++) {
    expect(said(card)).toContain(
      `tool${i} (pid ${30 + i}): name${i} at /opt/name${i}/bin`,
    );
    expect(card.next).toContain(`/opt/name${i}/bin (name${i})`);
  }
  expect(said(card)).not.toContain("more");
  expect(card.next).not.toContain("more");
});

test("an unconfirmed process with no readable path gets guidance to check it directly, not a path fragment", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.procs = [
    processSnapshot({
      pid: 20,
      comm: "bash",
      tool: null,
      unconfirmedTool: "pi",
      unconfirmedPath: null,
    }),
  ];
  const card = present(
    attention(s, c, { basePath: base })[0],
    "the unconfirmed-tool card",
  );
  expect(said(card)).toContain(
    "bash (pid 20): pi at a path vsys could not read",
  );
  // No path was recorded, so the advice never names a specific path to add.
  expect(card.next).not.toContain("(pi)");
  expect(card.next).toContain("check each such process directly");
  expect(card.next).toContain("pi");
  expect(card.next).toContain("Settings");
});

test("a mix of readable and unreadable unconfirmed paths gets both pieces of advice", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.procs = [
    processSnapshot({
      pid: 21,
      comm: "pi",
      tool: null,
      unconfirmedTool: "pi",
      unconfirmedPath: "/usr/bin/pi",
    }),
    processSnapshot({
      pid: 22,
      comm: "bash",
      tool: null,
      unconfirmedTool: "codex",
      unconfirmedPath: null,
    }),
  ];
  const card = present(
    attention(s, c, { basePath: base })[0],
    "the unconfirmed-tool card",
  );
  // The readable one still gets the fragment advice, naming its own path.
  expect(card.next).toContain("add a paths fragment");
  expect(card.next).toContain("/usr/bin/pi (pi)");
  // The unreadable one gets the direct-check advice instead, naming only its
  // tool, never telling the reader to cover a path that was never recorded.
  expect(card.next).toContain("check each such process directly");
  expect(card.next).toContain("a script path for codex");
  expect(card.next).not.toContain("/usr/bin/pi (codex)");
});

test("a named-executable match gets an executables entry recommended, not a paths fragment", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.procs = [
    processSnapshot({
      pid: 23,
      comm: "pi",
      tool: null,
      unconfirmedTool: "pi",
      unconfirmedPath: "/usr/bin/pi",
      unconfirmedMatch: "name",
    }),
  ];
  const card = present(
    attention(s, c, { basePath: base })[0],
    "the unconfirmed-tool card",
  );
  // The process matched by its own executable name, so the narrower fix is
  // an executables entry naming that whole path, never a paths fragment,
  // which would over-match other processes sharing the same bin directory.
  expect(card.next).toContain("add an executables entry");
  expect(card.next).toContain("/usr/bin/pi (pi)");
  expect(card.next).not.toContain("paths fragment");
});

test("a mix of a named match and a scripted match gets both pieces of advice", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.procs = [
    processSnapshot({
      pid: 24,
      comm: "pi",
      tool: null,
      unconfirmedTool: "pi",
      unconfirmedPath: "/usr/bin/pi",
      unconfirmedMatch: "name",
    }),
    processSnapshot({
      pid: 25,
      comm: "node",
      tool: null,
      unconfirmedTool: "codex",
      unconfirmedPath: "/home/reader/scripts/codex.js",
      unconfirmedMatch: "script",
    }),
  ];
  const card = present(
    attention(s, c, { basePath: base })[0],
    "the unconfirmed-tool card",
  );
  expect(card.next).toContain("add an executables entry");
  expect(card.next).toContain("/usr/bin/pi (pi)");
  expect(card.next).toContain("add a paths fragment");
  expect(card.next).toContain("/home/reader/scripts/codex.js (codex)");
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
  const stall = present(stalls[0], "the stalls card");
  expect(stall.title).toBe(
    "9 lanes are stalling on a resource: kendex PID 100, kendex PID 101, kendex PID 102, kendex PID 103 and 5 more",
  );
  // The title lists four; the detail under it names every lane.
  const every = Array.from({ length: 9 }, (_, i) => `kendex PID ${100 + i}`);
  expect(said(stall)).toBe(
    `Highest stall share 40.0% of the recent window. Lanes: ${every.join(", ")}.`,
  );
  expect(stall.target?.kind).not.toBe("lane");
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
  expect(said(card)).toContain("shadowed");
  expect(said(card)).toContain("/home/user/.shadow/bin");
  expect(said(card)).toContain("Launched bare");
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
  expect(said(other)).not.toContain("shadowed");
});

test("the unconfined card names a launcher only where a slice and markers exist", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ id: "a", pids: [11], unconfined: true })];
  s.procs = [
    processSnapshot({ pid: 11, group: "/app.slice/tmux-spawn-4.scope" }),
  ];
  const slice = (failure: "unreadable" | null) =>
    s.capabilities.map((cap) =>
      cap.id === "agent-slice"
        ? { ...cap, available: failure === null, failure }
        : cap,
    );
  const rows: [string, Snapshot["capabilities"], string[], boolean][] = [
    ["slice and markers", slice(null), c.capMarkers, true],
    ["no markers configured", slice(null), [], false],
    // A slice vsys could not read still raises the card, but nothing says a
    // launcher exists to have placed the agent there.
    ["unreadable slice", slice("unreadable"), c.capMarkers, false],
    // A sample stored before the probe still names its slice's launcher.
    [
      "unrecorded slice",
      s.capabilities.filter((cap) => cap.id !== "agent-slice"),
      c.capMarkers,
      true,
    ],
  ];
  for (const [name, capabilities, capMarkers, launcher] of rows) {
    const card = attention(
      { ...s, capabilities },
      { ...c, capMarkers },
      { basePath: base },
    ).find((item) => item.id === "unconfined");
    expect({
      name,
      bare: said(card).includes("Launched bare"),
      next: card?.next.includes("launcher"),
      command: card?.command,
    }).toEqual({
      name,
      bare: launcher,
      next: launcher,
      command: "systemd-run --user --slice=agents.slice --scope -- claude",
    });
  }
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
  expect(said(card)).toBe(
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
  present(s.groups[0], "the writer scope").path = "app.slice/gnome.scope";
  const scope = present(
    attention(s, c, { basePath: base })[0],
    "the scope card",
  );
  expect(scope.view).toBe("Resources");
  expect(scope.target?.kind).not.toBe("lane");
  expect(scope.next).toContain("what is writing in that scope");
});

test("counted nouns in the meters and the cards are singular at one", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.procs = [processSnapshot({ pid: 1, build: "ld.mold" })];
  const builds = () =>
    meterTile(present(meters(s, c)[3], "the builds meter"), s, c);
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
  expect(items[0]?.title).toBe("2 mounts are read-only: /a, /b");
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
    meterTile(present(meters(snapshot, c)[1], "the memory meter"), snapshot, c);
  expect(tile(s).value).toBe("500 B");
  expect(tile(s).detail).toBe("of 1000 B · swap 0 B");
  expect(tile(s).facts).toEqual([
    ["Used", "500 B of 1000 B"],
    ["Agent page cache", "not available"],
    ["Desktop swap", "0 B"],
    ["Largest", "b 900 B"],
  ]);
  expect(present(meters(s, c)[1], "the memory meter").level).toBe("ok");
  const desktop = present(s.groups[0], "the desktop slice");
  desktop.swap = c.swapFloor + 1;
  expect(tile(s).facts.slice(2)).toEqual([
    ["Desktop swap", "512.0 MiB"],
    ["Largest", "b 900 B"],
    ["Most swapped", "gnome 992 B"],
  ]);
  // Swap vsys could not read is a warning, never an untroubled reading.
  desktop.swap = null;
  expect(present(meters(s, c)[1], "the memory meter").level).toBe("warn");
  expect(tile(s).detail).toBe("of 1000 B · swap not available");
});

test("the disk meter reports free space and says when mounts are unreadable", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.system.pressure.io = { some: 12, full: 3, total: 0 };
  s.storage.volumes = [volumeSnapshot("/full", { free: 5368709120 })];
  const tile = (snapshot: Snapshot) =>
    meterTile(present(meters(snapshot, c)[2], "the disk meter"), snapshot, c);
  expect(tile(s).value).toBe("12.0%");
  expect(tile(s).facts).toEqual([
    ["Tasks waiting", "12.0% · nothing runnable 3.0%"],
    ["Least free", "5.0 GiB free"],
    ["Top writer", "not available"],
  ]);
  // A readable mount whose free space is unknown says so, in the same words.
  present(s.storage.volumes[0], "the /full volume").free = null;
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
    Object.fromEntries(
      meterTile(present(meters(s, c)[index], `meter ${index}`), s, c).facts,
    );
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
  expect(
    meterTile(present(meters(s, c)[0], "the cpu meter"), s, c).facts,
  ).toEqual([
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
  expect(said(memory)).toContain("gnome holds the most swap");
  expect(said(memory)).not.toContain(".scope");
});

test("the desktop-swap card drops the agents.slice command and step where no agent slice exists", () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const swapCard = () =>
    attention(s, c, { basePath: base }).find(
      (item) => item.id === "desktop-swap",
    );
  // With the slice present, the card still reads and caps agents.slice.
  const present = swapCard();
  expect(present?.command).toBe(
    `cat ${c.cgroupRoot}/${c.agentSlice}/memory.stat`,
  );
  expect(present?.next).toBe(
    "Reduce concurrent build work, or cap the agent slice memory so the desktop keeps its pages.",
  );
  // With no slice, the command is gone and the step names the agent lanes
  // holding the swap instead of the nonexistent slice.
  s.capabilities = s.capabilities.map((cap) =>
    cap.id === "agent-slice"
      ? { ...cap, available: false, failure: "absent" as const }
      : cap,
  );
  // A memory-capped group can produce a lane with no tool at all (a bare
  // scope, not an agent). The step names agent lanes only, so this one
  // must not appear alongside them.
  s.lanes = [
    ...s.lanes,
    laneSnapshot({ id: "bare.scope", name: "idle", tool: "", pids: [99] }),
  ];
  const absent = swapCard();
  expect(absent?.command).toBeUndefined();
  expect(absent?.next).toBe(
    "Reduce concurrent build work, or check escaped PID 40, capped PID 40, writer PID 40 for the memory holding the desktop's pages.",
  );
  expect(absent?.next).not.toContain("idle");
  // No lane left to name falls back to a step naming no slice at all.
  s.lanes = [];
  expect(swapCard()?.next).toBe(
    "Reduce concurrent build work so the desktop keeps its pages.",
  );
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
  expect(said(card).split("Launched bare")).toHaveLength(3);
  expect(said(card)).toContain("6 processes in the scope tmux-spawn-0.scope");
  expect(said(card)).toContain("6 processes in the scope tmux-spawn-1.scope");
  // The marker list is named once per group, never once per process.
  expect(said(card).split("RUST_TEST_THREADS")).toHaveLength(3);
  // The title counts lanes and the sentences count processes, so the sentence
  // naming the lanes states both counts and reconciles them.
  expect(said(card)).toEndWith(
    "12 processes in 2 lanes: kendex agent-0 PID 1000, kendex agent-1 PID 1006.",
  );
  // One process per lane is the boundary: the counts agree, so the sentence
  // states the lanes alone.
  const even = attention(escapedFleet(2, 1), c, { basePath: base }).find(
    (item) => item.id === "unconfined",
  );
  expect(said(even)).toEndWith(
    "Lanes: kendex agent-0 PID 1000, kendex agent-1 PID 1001.",
  );
});

test("a card's description holds the rows the screen gives it", () => {
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
  // The one column detailWidth floors at, the card of a 20-column terminal,
  // an ordinary panel, and a wide one.
  for (const s of [everyCauseSnapshot(c), crowded, scattered])
    for (const width of [1, 12, 38, 120]) {
      const items = attention(s, c, { basePath: base, width });
      for (const item of items) {
        measured.add(item.id);
        // Every room from the one a card is given on a crowded screen up to
        // one no card needs, written out rather than read from the production
        // rule the fitting used.
        for (const rows of [4, sixRows, 12]) {
          const drawn = fitted(item, width, rows);
          // The floor is what a card writes however short the room, and it is
          // the card's own: one row of the first thing it says and the blank
          // above the action lines, plus, where the card names lanes, the two
          // rows that sentence is written to and the break above it.
          const floor = item.keep === "" ? 2 : 5;
          expect(drawnRows(drawn, width)).toBeLessThanOrEqual(
            Math.max(rows, floor),
          );
          if (drawn.join(" ").includes("…")) cut++;
        }
        // Asked for a room under its floor, a card writes that floor. A card
        // naming no lane, which every storage card is, holds one row of the
        // first thing it says and the blank above the action lines; one that
        // names lanes holds that sentence too, at the rows it needs.
        const atFloor = drawnRows(fitted(item, width, 1), width);
        if (item.keep === "") expect(atFloor).toBe(2);
        else expect(atFloor).toBeLessThanOrEqual(5);
        // Given the rows its best way of writing itself needs, a card writes
        // that way: every paragraph of its own, nothing given up, nothing cut.
        const whole = [
          ...present(item.ways[0], "the first way"),
          item.keep,
        ].filter((p) => p !== "");
        expect(fitted(item, width, drawnRows(whole, width))).toEqual(whole);
      }
    }
  // A card that writes no ladder of its own is cut by the same budget: the
  // disk card on a panel at the floor is one.
  const narrow = fitted(
    attention(everyCauseSnapshot(c), c, { basePath: base, width: 20 }).find(
      (item) => item.id === "disk",
    ),
    20,
  ).join(" ");
  expect(narrow).toEndWith("…");
  expect(narrow).toContain("Tasks stalled on storage");
  // A lane whose name alone overruns the rows the sentence has: the name is
  // cut with its mark, and both counts the card promises are whole, because
  // the names are on the screen Enter opens and the counts are only here.
  const long = escapedSnapshot({ lanes: 2 });
  for (const lane of long.lanes)
    lane.name = `${"kendex vsys/issue-1234 ".repeat(5)}hclaude`;
  const tight = attention(long, c, { basePath: base, width: 20 }).find(
    (item) => item.id === "unconfined",
  );
  expect(fitted(tight, 20)).toEqual([
    "2 groups of processes: 2 bare.",
    "Lanes: kendex vsys/is… and 1 more.",
  ]);
  // The rung between every idea apart and everything in one: the conclusions
  // join into one paragraph and the sentence naming the lanes stays a
  // paragraph of its own, which is what a card gives up last.
  expect(
    fitted(
      attention(crowded, c, { basePath: base, width: 38 }).find(
        (item) => item.id === "unconfined",
      ),
      38,
      12,
    ),
  ).toEqual([
    "Launched bare: none of RUST_TEST_THREADS, CARGO_BUILD_JOBS is set on 60 processes in the scope tmux-spawn-0.scope. Launched bare: none of RUST_TEST_THREADS, CARGO_BUILD_JOBS is set on 60 processes in the scope tmux-spawn-1.scope.",
    "120 processes in 30 lanes: kendex agent-0 PID 1000 and 29 more.",
  ]);
  // Every cause the ladder can report was measured, read from the ladder's
  // own table rather than a list kept here: a cause added without a fixture
  // is a cause whose detail nothing measures.
  expect([...measured].sort()).toEqual(Object.keys(causeOrder).sort());
  // And a machine crowded enough to overrun the budget did overrun it, so the
  // cut above is a cut that ran rather than a case that never reached it.
  expect(cut).toBeGreaterThan(0);
});

test("a card short of room gives up the chain, then a conclusion, and counts both", () => {
  const c = defaults();
  const s = escapedSnapshot({ lanes: 12, scopes: 12 });
  // One room throughout, so what changes down this test is the width and the
  // order the card gives ground in, never the rows it was handed.
  const detail = (width: number) =>
    fitted(
      attention(s, c, { basePath: base, width }).find(
        (item) => item.id === "unconfined",
      ),
      width,
    ).join(" ");
  // Wide enough for the ancestors of every conclusion.
  expect(detail(600)).toContain("Started from PID");
  expect(detail(600)).not.toContain("not written here");
  // Narrower, the ancestors go first. They are the part of the card the
  // reader can read again on the screen Enter opens.
  expect(detail(400)).not.toContain("Started from PID");
  expect(detail(400)).toContain("tmux-spawn-11.scope");
  // Then a conclusion at a time, from the last, and what goes is counted the
  // way the title counts the lanes it stopped at.
  expect(detail(300)).not.toContain("tmux-spawn-11.scope");
  expect(detail(300)).toContain(
    "And 2 more groups of processes not written here.",
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
  present(shared.procs[2], "the third process").env = {
    CARGO_BUILD_JOBS: "16",
  };
  const merged = fitted(
    attention(shared, c, { basePath: base, width: 44 }).find(
      (item) => item.id === "unconfined",
    ),
    44,
  ).join(" ");
  expect(merged).toContain("The launcher was shadowed");
  expect(merged).toContain("And 1 more group of processes not written here.");
  expect(merged).not.toContain("  ");
  expect(
    fitted(
      attention(escapedSnapshot({ lanes: 2, scopes: 2 }), c, {
        basePath: base,
        width: 44,
      }).find((item) => item.id === "unconfined"),
      44,
    ).join(" "),
  ).toContain("And 1 more group of processes not written here.");
  // At the floor a panel can be, one whole conclusion and the count of what
  // went do not fit in the rows beside the lane sentence, so the card counts
  // every conclusion instead. Nothing it shows there is cut.
  expect(detail(20)).toBe(
    "12 groups of processes: 12 bare. Lanes: kendex agent-… and 11 more.",
  );
  // Each kind is counted under the name the sentences give it.
  expect(
    fitted(
      attention(shared, c, { basePath: base, width: 20 }).find(
        (item) => item.id === "unconfined",
      ),
      20,
    ).join(" "),
  ).toStartWith("2 groups of processes: 1 bare, 1 shadowed.");
});

test("a card cut to the bone still says one thing and names the lanes", () => {
  const c = defaults();
  // Written for a wide panel and fitted into a narrow one, so the sentence
  // naming the lanes needs more rows than the room has. No caller does this
  // today; `cardDetail` is exported, and a screen must not raise.
  const wide = attention(escapedFleet(6, 1), c, {
    basePath: base,
    width: 120,
  }).find((item) => item.id === "unconfined");
  if (!wide) throw new Error("Expected one unconfined card");
  const cut = cardDetail(wide, 20, 4);
  // One paragraph, because every break is given up first, and the lane names
  // are still at the end of it: the row kept back for the first thing the
  // card says is what leaves both of them on the screen.
  expect(cut).toHaveLength(1);
  expect(cut[0]).toStartWith("2 groups of");
  expect(cut[0]).toContain("Lanes: kendex agent-0 PID 1000");
});

test("the lane sentence stops rather than growing with the machine", () => {
  const c = defaults();
  const s = escapedFleet(57, 1);
  const card = attention(s, c, { basePath: base, width: 60 }).find(
    (item) => item.id === "unconfined",
  );
  if (!card) throw new Error("Expected one unconfined card");
  // It stops at the lanes it has room for and says how many it did not name.
  const lanes = said(card).slice(said(card).lastIndexOf("Lanes: "));
  expect(lanes).toBe(
    "Lanes: kendex agent-0 PID 1000, kendex agent-1 PID 1001, " +
      "kendex agent-2 PID 1002 and 54 more.",
  );
  // A wider panel is more room for the same sentence, not more sentences.
  const wide = attention(s, c, { basePath: base, width: 160 }).find(
    (item) => item.id === "unconfined",
  );
  const wider = said(wide).slice(said(wide).lastIndexOf("Lanes: "));
  expect(wrapLines(wider, 160)).toHaveLength(2);
  expect(wider.split(", ").length).toBeGreaterThan(lanes.split(", ").length);
  // A panel too narrow for four names names fewer and still counts the rest,
  // because the budget holds before the list does.
  const four = attention(escapedFleet(4, 1), c, {
    basePath: base,
    width: 24,
  }).find((item) => item.id === "unconfined");
  expect(said(four)).toEndWith("Lanes: kendex agent-0 PID 1000 and 3 more.");
  // One lane has no second name to count, so a name too long for the rows it
  // has is written whole and cut by the budget, never counted as 0 more.
  const alone = escapedSnapshot({ lanes: 1 });
  present(alone.lanes[0], "the one lane").name =
    `${"kendex vsys/issue-1234 ".repeat(3)}hclaude`;
  const single = attention(alone, c, { basePath: base, width: 24 }).find(
    (item) => item.id === "unconfined",
  );
  expect(said(single)).not.toContain("and 0 more");
  // The name is cut to the rows the sentence has, marked where it stopped.
  expect(fitted(single, 24)).toEqual([
    "1 group of processes: 1 bare.",
    "Lane: kendex vsys/issue-1234 kendex…",
  ]);
});

test("a storage card never tells the reader to remove a listed file", () => {
  const c = defaults();
  const s = emptySnapshot();
  const scrub = (addresses: { logical: number; paths: string[] }[]) => ({
    path: "/run/btrfs-scrub/root.result",
    text: "Error summary: csum=1",
    problem: true,
    readable: true,
    fsid: "fs",
    startedAt: s.time - 1000,
    status: "finished",
    uncorrectable: 2,
    addresses,
  });
  s.storage.volumes = [
    volumeSnapshot("/", {
      fsid: "fs",
      errors: { "1/corruption_errs": 1 },
      countersAvailable: true,
    }),
  ];
  // Build output and a letter alike: the report names the block's start, so
  // either file may be sound, and the card says so rather than calling one
  // safe to remove.
  s.storage.scrubs = [
    scrub([
      { logical: 1, paths: ["/r/target/a"] },
      { logical: 2, paths: ["/home/r/letter.txt"] },
    ]),
  ];
  const card = attention(s, c, { basePath: base }).find(
    (i) => i.id === "damaged-files",
  );
  expect(card?.title).toContain("2 possibly damaged files");
  expect(said(card)).toContain("a listed file may be sound");
  expect(said(card)).toContain("more than one file can share a block");
  expect(card?.next).toContain("may not be among the names shown");
  // No step tells the reader to judge a file by reading it: a refused read
  // is not damage, and a cached one is not soundness.
  expect(`${said(card)} ${card?.next}`).not.toMatch(/\bread\b/i);
  expect(said(card)).not.toMatch(/delete|build output/i);
  expect(card?.next).not.toMatch(/delete|build output/i);
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
  expect(said(one)).toContain("26 failed reads");
  // A second filesystem, and the first one's count no longer speaks for both.
  grown("b", 9);
  const two = attention(s, c, { basePath: base }).find(
    (item) => item.id === "new-errors",
  );
  expect(said(two)).not.toContain("26");
  expect(said(two)).toContain("Open each one for its own times");
});

test("a new-errors card's next step matches the ways text's singular/plural framing", () => {
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
  const one = present(
    attention(s, c, { basePath: base }).find(
      (item) => item.id === "new-errors",
    ),
    "the one-filesystem new-errors card",
  );
  expect(said(one)).not.toContain("Open each one for its own times");
  expect(one.next).toContain("that filesystem");
  expect(one.next).not.toContain("each of these filesystems");
  expect(one.target).toEqual({ kind: "path", path: "a" });
  // A second filesystem turns `ways` plural; `next` and `target` must still
  // agree with it, rather than the first filesystem's singular wording.
  grown("b", 9);
  const two = present(
    attention(s, c, { basePath: base }).find(
      (item) => item.id === "new-errors",
    ),
    "the multi-filesystem new-errors card",
  );
  expect(said(two)).toContain("Open each one for its own times");
  expect(two.next).toContain("each of these filesystems");
  expect(two.next).not.toContain("that filesystem");
  expect(two.target).toEqual({ kind: "path", path: "a" });
});

test("a new error only the kernel log recorded is not told as counter growth", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes.push(
    volumeSnapshot("/", {
      fsid: "fs",
      errors: { "1/corruption_errs": 0 },
      countersAvailable: true,
    }),
  );
  s.storage.csumFailures = {
    fs: [{ root: 257, inode: 4242, at: s.time - 7200000 }],
  };
  const card = attention(s, c, { basePath: base }).find(
    (item) => item.id === "new-errors",
  );
  expect(said(card)).toContain(
    "The kernel logged a failed checksum read 2.0h ago.",
  );
  expect(said(card)).not.toContain("The counter grew");
});

test("a new-errors card says no full check has ever run, not an unstated age", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes.push(
    volumeSnapshot("/", {
      fsid: "fs",
      errors: { "1/corruption_errs": 0 },
      countersAvailable: true,
    }),
  );
  s.storage.csumFailures = {
    fs: [{ root: 257, inode: 4242, at: s.time - 7200000 }],
  };
  const card = attention(s, c, { basePath: base }).find(
    (item) => item.id === "new-errors",
  );
  expect(said(card)).toContain(
    "The kernel logged a failed checksum read 2.0h ago. No full check has ever run.",
  );
  expect(said(card)).not.toContain("longer ago than that");
});

test("a new-errors card names the age of a finished check an aborted one replaced", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes.push(
    volumeSnapshot("/", {
      fsid: "fs",
      errors: { "1/corruption_errs": 0 },
      countersAvailable: true,
    }),
  );
  s.storage.csumFailures = {
    fs: [{ root: 257, inode: 4242, at: s.time - 7200000 }],
  };
  // The reporter's one report for this filesystem now holds an aborted scrub,
  // started after the error above, which overwrote the finished report that
  // ran 3 days ago. The collector still remembers that finished report.
  s.storage.scrubs = [
    {
      path: "/run/btrfs-scrub/root.result",
      text: "scrub status:\naborted",
      problem: true,
      readable: true,
      fsid: "fs",
      startedAt: s.time - 3600000,
      status: "aborted",
      uncorrectable: null,
      addresses: null,
    },
  ];
  s.storage.lastFinishedScrub = {
    fs: { at: s.time - 3 * 86400000, damaged: false },
  };
  const card = attention(s, c, { basePath: base }).find(
    (item) => item.id === "new-errors",
  );
  expect(said(card)).toContain(
    "The kernel logged a failed checksum read 2.0h ago. The last full check ran 3.0d ago.",
  );
  expect(said(card)).not.toContain("No full check has ever run.");
});

test("a damage card never calls a partial list the whole of the damage", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes = [
    volumeSnapshot("/", {
      fsid: "fs",
      errors: { "1/corruption_errs": 3 },
      countersAvailable: true,
    }),
  ];
  const card = (addresses: { logical: number; paths: string[] }[]) => {
    s.storage.scrubs = [
      {
        path: "/run/btrfs-scrub/root.result",
        text: "Error summary: csum=3",
        problem: true,
        readable: true,
        fsid: "fs",
        startedAt: s.time - 1000,
        status: "finished",
        uncorrectable: 3,
        addresses,
      },
    ];
    return attention(s, c, { basePath: base }).find(
      (i) => i.id === "damaged-files",
    );
  };
  // Three blocks counted and none named: the damage is unnamed, not free space.
  const none = card([]);
  expect(said(none)).not.toContain("free space");
  expect(said(none)).toContain("could not name a file for 3 damaged blocks");
  expect(none?.next).toContain("restore what the unnamed blocks held");
  // One address named of three blocks: its files are not all of the damage.
  const some = card([{ logical: 1, paths: ["/r/target/a"] }]);
  expect(said(some)).toContain("2 damaged blocks could not be tied to a file");
});

test("a damage card known only from a remembered check never says the damage is in free space", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes = [
    volumeSnapshot("/", {
      fsid: "fs",
      errors: { "1/corruption_errs": 1 },
      countersAvailable: true,
    }),
  ];
  // The current report stopped early, so it names no address of its own. The
  // only reason this filesystem is damaged at all is the remembered check,
  // and that check's file-level detail is gone with its report.
  s.storage.scrubs = [
    {
      path: "/run/btrfs-scrub/root.result",
      text: "scrub status:\naborted",
      problem: true,
      readable: true,
      fsid: "fs",
      startedAt: s.time - 1000,
      status: "aborted",
      uncorrectable: null,
      addresses: null,
    },
  ];
  s.storage.lastFinishedScrub = {
    fs: { at: s.time - 3 * 86400000, damaged: true },
  };
  const card = attention(s, c, { basePath: base }).find(
    (i) => i.id === "damaged-files",
  );
  expect(said(card)).not.toContain("free space");
  expect(said(card)).toContain(
    "The report naming this damage is no longer available, so vsys cannot say which files hold it.",
  );
  expect(card?.next).toContain("run a check on that filesystem");
  // The report vanishing entirely, rather than stopping early, reads the same.
  s.storage.scrubs = [];
  const gone = attention(s, c, { basePath: base }).find(
    (i) => i.id === "damaged-files",
  );
  expect(said(gone)).not.toContain("free space");
  expect(said(gone)).toContain("no longer available");
});

test("a damaged-files card keeps a readable filesystem's own count beside one that is unread", () => {
  const c = defaults();
  const s = emptySnapshot();
  // /a has a live, complete report naming one damaged file.
  s.storage.volumes = [
    volumeSnapshot("/a", {
      fsid: "a",
      errors: { "1/corruption_errs": 1 },
      countersAvailable: true,
    }),
    // /b is damaged only through a remembered finished check: its current
    // report stopped early and names no address data of its own.
    volumeSnapshot("/b", {
      fsid: "b",
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
      startedAt: s.time - 1000,
      status: "finished",
      uncorrectable: 1,
      addresses: [{ logical: 1, paths: ["/r/target/a"] }],
    },
    {
      path: "/run/btrfs-scrub/b.result",
      text: "scrub status:\naborted",
      problem: true,
      readable: true,
      fsid: "b",
      startedAt: s.time - 500,
      status: "aborted",
      uncorrectable: null,
      addresses: null,
    },
  ];
  s.storage.lastFinishedScrub = {
    b: { at: s.time - 3 * 86400000, damaged: true },
  };
  const card = attention(s, c, { basePath: base }).find(
    (i) => i.id === "damaged-files",
  );
  // /a's own file is still named and counted, not collapsed to unknown
  // because /b's report cannot say anything about its own damage.
  expect(card?.title).toBe("Damage on /a, /b: 1 possibly damaged file");
  expect(said(card)).toContain("a listed file may be sound");
  expect(said(card)).toContain(
    "1 filesystem here has no report naming its damage, so the damage there is not in this count.",
  );
  // The block total is /a's own count alone, and says so: /b's block count
  // is just as unread as the rest of its damage, never folded in as zero.
  expect(said(card)).toContain(
    "The last check could not repair 1 block, not counting 1 filesystem whose block count is unread.",
  );
  // /a's card never reads as if /b had no damage at all.
  expect(said(card)).not.toContain("no longer available");
  // /b has no report of its own, so the next step sends the reader to check
  // it first, before telling them to restore /a's own named damage as if
  // every filesystem in the card already had a report in hand.
  expect(card?.next).toContain(
    "run a check on that filesystem to find out which files hold the damage",
  );
  expect(card?.next).toContain("open the filesystem, then restore");
  expect(card?.next).not.toContain("each of these filesystems");
  // The first affected filesystem still lands the card, VSY-98's precedent.
  expect(card?.target).toEqual({ kind: "path", path: "a" });
});

test("a damaged-files card's mixed next step pluralizes each clause by its own count, not the card's total", () => {
  const c = defaults();
  const unreadFs = (s: Snapshot, fsid: string, mount: string) => {
    s.storage.volumes.push(
      volumeSnapshot(mount, {
        fsid,
        errors: { "1/corruption_errs": 1 },
        countersAvailable: true,
      }),
    );
    s.storage.scrubs.push({
      path: `/run/btrfs-scrub/${fsid}.result`,
      text: "scrub status:\naborted",
      problem: true,
      readable: true,
      fsid,
      startedAt: s.time - 500,
      status: "aborted",
      uncorrectable: null,
      addresses: null,
    });
    s.storage.lastFinishedScrub = {
      ...s.storage.lastFinishedScrub,
      [fsid]: { at: s.time - 3 * 86400000, damaged: true },
    };
  };
  const knownFs = (s: Snapshot, fsid: string, mount: string) => {
    s.storage.volumes.push(
      volumeSnapshot(mount, {
        fsid,
        errors: { "1/corruption_errs": 1 },
        countersAvailable: true,
      }),
    );
    s.storage.scrubs.push({
      path: `/run/btrfs-scrub/${fsid}.result`,
      text: "Error summary: csum=1",
      problem: true,
      readable: true,
      fsid,
      startedAt: s.time - 1000,
      status: "finished",
      uncorrectable: 1,
      addresses: [{ logical: 1, paths: [`/r/target/${fsid}`] }],
    });
  };
  // Two unread filesystems beside one known one: the check-first clause must
  // pluralize on its own two, the remedy clause stay singular on its own
  // one, neither reading off the card's total of three.
  const moreUnread = emptySnapshot();
  knownFs(moreUnread, "a", "/a");
  unreadFs(moreUnread, "b", "/b");
  unreadFs(moreUnread, "c", "/c");
  const moreUnreadCard = attention(moreUnread, c, { basePath: base }).find(
    (i) => i.id === "damaged-files",
  );
  expect(moreUnreadCard?.next).toContain(
    "run a check on each of these filesystems to find out which files hold the damage",
  );
  expect(moreUnreadCard?.next).toContain("open the filesystem, then restore");
  expect(moreUnreadCard?.next).not.toContain(
    "run a check on that filesystem to find out",
  );
  expect(moreUnreadCard?.next).not.toContain(
    "open each of these filesystems, then restore",
  );
  // The reverse asymmetry: one unread filesystem beside two known ones.
  const moreKnown = emptySnapshot();
  knownFs(moreKnown, "a", "/a");
  knownFs(moreKnown, "b", "/b");
  unreadFs(moreKnown, "c", "/c");
  const moreKnownCard = attention(moreKnown, c, { basePath: base }).find(
    (i) => i.id === "damaged-files",
  );
  expect(moreKnownCard?.next).toContain(
    "run a check on that filesystem to find out which files hold the damage",
  );
  expect(moreKnownCard?.next).toContain(
    "open each of these filesystems, then restore",
  );
  expect(moreKnownCard?.next).not.toContain(
    "run a check on each of these filesystems to find out",
  );
  expect(moreKnownCard?.next).not.toContain(
    "open the filesystem, then restore",
  );
});

test("a damaged-files card's block total discloses a filesystem whose own block count is unread, independent of its files", () => {
  const c = defaults();
  // A finished, readable report whose own files are always named, so `files`
  // is known for every row here; only `blocks` (the "Uncorrectable:" field)
  // varies, to isolate the block-only disclosure from the files-based one.
  const row = (fsid: string, mount: string, blocks: number | null) => ({
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
  const build = (rows: ReturnType<typeof row>[]) => {
    const s = emptySnapshot();
    s.storage.volumes = rows.map((r) => r.volume);
    s.storage.scrubs = rows.map((r) => r.scrub);
    return attention(s, c, { basePath: base }).find(
      (i) => i.id === "damaged-files",
    );
  };
  // /b's own file is still named and counted (`files` known for both), so
  // the files-based unread note stays silent; only /b's block count could
  // not be read, which must still be disclosed rather than dropped as zero.
  const mixed = build([row("a", "/a", 9), row("b", "/b", null)]);
  expect(said(mixed)).not.toContain("no report naming its damage");
  expect(said(mixed)).toContain(
    "The last check could not repair 9 blocks, not counting 1 filesystem whose block count is unread.",
  );
  // Every filesystem's own block count is unread: the card still discloses
  // that, rather than stating a total of zero blocks repaired or, worse,
  // staying silent about blocks entirely.
  const allUnknown = build([row("a", "/a", null), row("b", "/b", null)]);
  expect(said(allUnknown)).not.toContain("The last check could not repair");
  expect(said(allUnknown)).toContain(
    "No filesystem here has a readable block count.",
  );
});

test("a damaged-files card's unread note reaches the unnamed-only and free-space branches too", () => {
  const c = defaults();
  const unread = (s: Snapshot, fsid: string, mount: string) => {
    s.storage.volumes.push(
      volumeSnapshot(mount, {
        fsid,
        errors: { "1/corruption_errs": 1 },
        countersAvailable: true,
      }),
    );
    s.storage.scrubs.push({
      path: `/run/btrfs-scrub/${fsid}.result`,
      text: "scrub status:\naborted",
      problem: true,
      readable: true,
      fsid,
      startedAt: s.time - 500,
      status: "aborted",
      uncorrectable: null,
      addresses: null,
    });
    s.storage.lastFinishedScrub = {
      ...s.storage.lastFinishedScrub,
      [fsid]: { at: s.time - 3 * 86400000, damaged: true },
    };
  };
  const known = (
    s: Snapshot,
    fsid: string,
    mount: string,
    uncorrectable: number | null,
  ) => {
    s.storage.volumes.push(
      volumeSnapshot(mount, {
        fsid,
        errors: { "1/corruption_errs": 1 },
        countersAvailable: true,
      }),
    );
    s.storage.scrubs.push({
      path: `/run/btrfs-scrub/${fsid}.result`,
      text: "Error summary: csum=1",
      problem: true,
      readable: true,
      fsid,
      startedAt: s.time - 1000,
      status: "finished",
      uncorrectable,
      addresses: [],
    });
  };
  // The readable filesystem names blocks but no file: the unnamed-only
  // branch, beside a filesystem whose damage is only remembered.
  const unnamedOnly = emptySnapshot();
  known(unnamedOnly, "a", "/a", 1);
  unread(unnamedOnly, "b", "/b");
  const unnamedCard = attention(unnamedOnly, c, { basePath: base }).find(
    (i) => i.id === "damaged-files",
  );
  expect(said(unnamedCard)).toContain(
    "The report could not name a file for 1 damaged block",
  );
  expect(said(unnamedCard)).toContain(
    "1 filesystem here has no report naming its damage, so the damage there is not in this count.",
  );
  // The readable filesystem names neither block nor file: the free-space
  // branch, beside the same kind of remembered-only filesystem.
  const freeSpace = emptySnapshot();
  known(freeSpace, "a", "/a", null);
  unread(freeSpace, "b", "/b");
  const freeCard = attention(freeSpace, c, { basePath: base }).find(
    (i) => i.id === "damaged-files",
  );
  expect(said(freeCard)).toContain(
    "The report named no file, so the damage is in free space or in a file already deleted.",
  );
  expect(said(freeCard)).toContain(
    "1 filesystem here has no report naming its damage, so the damage there is not in this count.",
  );
});

test("a damaged-files card's next step matches the ways text's singular/plural framing across every branch", () => {
  // One row per `next` branch in copy()'s damaged-files case: the report is
  // gone, the report named neither block nor file, the report named blocks
  // but no file, and the report named a file. Each row is built identically
  // for every filesystem in the card, so the aggregate across several stays
  // in that same branch.
  const branches: {
    name: string;
    build: (s: Snapshot, fsid: string, mount: string) => void;
    singular: string;
    plural: string;
  }[] = [
    {
      name: "the report naming the damage is gone",
      build: (s, fsid, mount) => {
        s.storage.volumes.push(
          volumeSnapshot(mount, {
            fsid,
            errors: { "1/corruption_errs": 1 },
            countersAvailable: true,
          }),
        );
        s.storage.scrubs.push({
          path: `/run/btrfs-scrub/${fsid}.result`,
          text: "scrub status:\naborted",
          problem: true,
          readable: true,
          fsid,
          startedAt: s.time - 1000,
          status: "aborted",
          uncorrectable: null,
          addresses: null,
        });
        s.storage.lastFinishedScrub = {
          ...s.storage.lastFinishedScrub,
          [fsid]: { at: s.time - 3 * 86400000, damaged: true },
        };
      },
      singular: "run a check on that filesystem to find out",
      plural: "run a check on each of these filesystems to find out",
    },
    {
      name: "the report named neither block nor file",
      build: (s, fsid, mount) => {
        s.storage.volumes.push(
          volumeSnapshot(mount, {
            fsid,
            errors: { "1/corruption_errs": 1 },
            countersAvailable: true,
          }),
        );
        s.storage.scrubs.push({
          path: `/run/btrfs-scrub/${fsid}.result`,
          text: "Error summary: no errors found",
          problem: true,
          readable: true,
          fsid,
          startedAt: s.time - 1000,
          status: "finished",
          uncorrectable: null,
          addresses: [],
        });
      },
      singular: "check the filesystem again; an address",
      plural: "check each of these filesystems again; an address",
    },
    {
      name: "the report named blocks but no file",
      build: (s, fsid, mount) => {
        s.storage.volumes.push(
          volumeSnapshot(mount, {
            fsid,
            errors: { "1/corruption_errs": 1 },
            countersAvailable: true,
          }),
        );
        s.storage.scrubs.push({
          path: `/run/btrfs-scrub/${fsid}.result`,
          text: "Error summary: csum=1",
          problem: true,
          readable: true,
          fsid,
          startedAt: s.time - 1000,
          status: "finished",
          uncorrectable: 1,
          addresses: [],
        });
      },
      singular: "read the check report; restore",
      plural: "read the check report for each of these filesystems; restore",
    },
    {
      name: "the report named a file",
      build: (s, fsid, mount) => {
        s.storage.volumes.push(
          volumeSnapshot(mount, {
            fsid,
            errors: { "1/corruption_errs": 1 },
            countersAvailable: true,
          }),
        );
        s.storage.scrubs.push({
          path: `/run/btrfs-scrub/${fsid}.result`,
          text: "Error summary: csum=1",
          problem: true,
          readable: true,
          fsid,
          startedAt: s.time - 1000,
          status: "finished",
          uncorrectable: 1,
          addresses: [{ logical: 1, paths: ["/r/target/a"] }],
        });
      },
      singular: "open the filesystem, then restore",
      plural: "open each of these filesystems, then restore",
    },
  ];
  for (const branch of branches) {
    const c = defaults();
    const one = emptySnapshot();
    branch.build(one, "a", "/a");
    const oneCard = present(
      attention(one, c, { basePath: base }).find(
        (i) => i.id === "damaged-files",
      ),
      `the one-filesystem card for ${branch.name}`,
    );
    expect(oneCard.next).toContain(branch.singular);
    expect(oneCard.next).not.toContain(branch.plural);
    expect(oneCard.target).toEqual({ kind: "path", path: "a" });
    // A second filesystem built the same way turns `next` plural; `target`
    // still points at the first filesystem, per VSY-98's decision.
    const two = emptySnapshot();
    branch.build(two, "a", "/a");
    branch.build(two, "b", "/b");
    const twoCard = present(
      attention(two, c, { basePath: base }).find(
        (i) => i.id === "damaged-files",
      ),
      `the multi-filesystem card for ${branch.name}`,
    );
    expect(twoCard.next).toContain(branch.plural);
    expect(twoCard.next).not.toContain(branch.singular);
    expect(twoCard.target).toEqual({ kind: "path", path: "a" });
  }
});

test("a new-errors card tells only the errors newer than the last check", () => {
  const c = defaults();
  const s = emptySnapshot();
  const hour = 3600000;
  const card = (lastErrorAt: number, logged: number, checked: number) => {
    s.storage.volumes = [
      volumeSnapshot("/", {
        fsid: "fs",
        errors: { "1/corruption_errs": 26 },
        countersAvailable: true,
        lastErrorAt: s.time - lastErrorAt,
        lastErrorSize: 26,
      }),
    ];
    s.storage.csumFailures = {
      fs: [{ root: 257, inode: 4242, at: s.time - logged }],
    };
    s.storage.scrubs = [
      {
        path: "/run/btrfs-scrub/root.result",
        text: "Error summary: no errors found",
        problem: false,
        readable: true,
        fsid: "fs",
        startedAt: s.time - checked,
        status: "finished",
        uncorrectable: 0,
        corrected: 0,
        addresses: [],
      },
    ];
    return said(
      attention(s, c, { basePath: base }).find((i) => i.id === "new-errors"),
    );
  };
  // Both sources recorded an error since the check: one sentence names both.
  expect(card(hour, 2 * hour, 3 * hour)).toContain(
    "The counter grew 1.0h ago by 26 failed reads, and the kernel logged a failed checksum read 2.0h ago. The last full check ran 3.0h ago.",
  );
  // The counter grew before the check and the log after it: only the log's
  // error is new, so the counter's is not told as one.
  const between = card(3 * hour, hour, 2 * hour);
  expect(between).toContain(
    "The kernel logged a failed checksum read 1.0h ago. The last full check ran 2.0h ago.",
  );
  expect(between).not.toContain("counter grew");
  // The log's failure came before the check and the counter grew after it:
  // only the counter's error is new, so the logged one is not told.
  const counted = card(hour, 3 * hour, 2 * hour);
  expect(counted).toContain(
    "The counter grew 1.0h ago by 26 failed reads. The last full check ran 2.0h ago.",
  );
  expect(counted).not.toContain("kernel logged");
});
