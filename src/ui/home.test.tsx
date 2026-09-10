import { expect, test } from "bun:test";
import type { Config } from "../config/config";
import { defaults } from "../config/config";
import type { Snapshot } from "../model/types";
import type { TimelineEvent } from "../store/events";
import { History } from "../store/history";
import {
  emptySnapshot,
  everyCauseSnapshot,
  groupSnapshot,
  laneSnapshot,
} from "../test/fixture";
import { mount, selectedRow } from "../test/harness";
import { attention } from "./attention";
import { osc52 } from "./clipboard";
import type { HomeItem } from "./home";
import { homeItems, homeTarget, recentChanges } from "./home";
import { eventKey } from "./timeline";

test("Home lists every concern first, then the busiest agents, capped", () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  s.lanes = [
    ...s.lanes,
    ...Array.from({ length: 6 }, (_, i) =>
      laneSnapshot({ id: `x${i}`, name: `x${i}`, cpu: 100 + i }),
    ),
  ];
  const items = attention(s, c, ["/usr/bin"]);
  const rows = homeItems(items, s);
  expect(rows.slice(0, items.length).every((r) => r.kind === "concern")).toBe(
    true,
  );
  const agents = rows.slice(items.length);
  expect(agents.length).toBe(5);
  expect(agents.map((r) => (r.kind === "agent" ? r.lane.name : ""))).toEqual([
    "x5",
    "x4",
    "x3",
    "x2",
    "x1",
  ]);
  expect(homeItems([], emptySnapshot())).toEqual([]);
});

test("Home lists the newest changes first, and each opens the moment it names", () => {
  const s = emptySnapshot();
  s.lanes = [laneSnapshot()];
  // The Timeline hands its list newest first, and Home takes the head of it.
  const changes: TimelineEvent[] = [5, 4, 3, 2, 1].map((n) => ({
    time: n * 1000,
    kind: "lane-start" as const,
    subject: `lane-${n}`,
    subjectId: `lane-${n}`,
    cause: "" as const,
    names: {},
    values: {},
  }));
  const rows = homeItems([], s, 5, changes);
  const listed = rows.flatMap((row) =>
    row.kind === "change" ? [row.event.time] : [],
  );
  expect(listed).toEqual([5000, 4000, 3000]);
  expect(listed.length).toBe(recentChanges);
  // Concerns come first, then the changes, then the agents.
  expect(rows.map((row) => row.kind)).toEqual([
    "change",
    "change",
    "change",
    "agent",
  ]);
  // Opening one asks for that moment and for which change at it. Every change
  // found in one sample carries that sample's time, so the time alone would
  // name the first of them however far down the reader had moved.
  const first = rows[0];
  expect(first.kind).toBe("change");
  if (first.kind !== "change") throw new Error("no change row to open");
  expect(homeTarget(first)).toEqual({
    kind: "time",
    at: 5000,
    id: eventKey(first.event),
  });
  expect(homeTarget(rows[3])).toEqual({ kind: "lane", id: s.lanes[0].id });
  // With no changes recorded, the section lists none rather than inventing one.
  expect(homeItems([], s, 5).some((row) => row.kind === "change")).toBe(false);
});

test("Home keeps the selected concern in view and opens its agent", async () => {
  const c = defaults();
  // One card per cause, so the list is grouped and still long enough to scroll.
  const s = everyCauseSnapshot(c);
  const t = await mount(s, c, { width: 80, height: 24 });
  try {
    await t.ui.renderOnce();
    const cards = attention(s, c);
    expect(cards.length).toBeGreaterThan(10);
    // Only the selected card shows its next step; the rest stay one row.
    expect(
      t
        .frame()
        .split("\n")
        .filter((row) => row.includes("Next")).length,
    ).toBe(1);
    for (let i = 0; i < cards.length - 1; i++) await t.press("down");
    expect(t.frame()).toContain("/scratch");
    expect(t.frame().split("\n")[0]).toContain("vsys");
    for (let i = 0; i < cards.length - 1; i++) await t.press("up");
    await t.press("enter");
    expect(t.frame()).toContain("escaped");
    expect(t.frame()).toContain("PID 40");
  } finally {
    await t.close();
  }
});

test("the copy key puts the selected card's command on the clipboard", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const items = attention(s, c);
  const index = items.findIndex((item) => item.command !== undefined);
  const command = items[index].command;
  const t = await mount(s, c, { width: 160, height: 45 });
  try {
    for (let i = 0; i < index; i++) await t.press("j");
    await t.press("y");
    expect(t.written).toEqual([osc52(command ?? "")]);
    // The notice names where the text went and what silence means, because
    // OSC 52 is a request to the terminal that vsys cannot confirm.
    expect(t.frame()).toContain("Copied to the clipboard");
    expect(t.frame()).toContain("OSC 52");
    // A card with no command copies nothing rather than an empty clipboard.
    const bare = items.findIndex((item) => item.command === undefined);
    expect(bare).toBeGreaterThanOrEqual(0);
    for (let i = index; i < bare; i++) await t.press("j");
    await t.press("y");
    expect(t.written.length).toBe(1);
    expect(t.frame()).toContain("no command to copy");
  } finally {
    await t.close();
  }
});

test("a wide terminal puts the concerns and the agents side by side", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const wide = await mount(s, c, { width: 180, height: 44 });
  try {
    await wide.press("1");
    const heading = wide
      .frame()
      .split("\n")
      .find((line) => line.includes("Needs attention"));
    // One row carries two headings, so the columns sit beside each other:
    // what is wrong now on the left, what happened and who is busy on the right.
    expect(heading).toContain("Recent changes");
    expect(wide.frame()).toContain("Busiest agents");
  } finally {
    await wide.close();
  }
  // Below the width they stack, and the headings sit on separate rows.
  const tall = await mount(s, c, { width: 120, height: 44 });
  try {
    await tall.press("1");
    const lines = tall.frame().split("\n");
    const heading = lines.find((line) => line.includes("Needs attention"));
    expect(heading).not.toContain("Recent changes");
    expect(lines.some((line) => line.includes("Recent changes"))).toBe(true);
    expect(lines.some((line) => line.includes("Busiest agents"))).toBe(true);
  } finally {
    await tall.close();
  }
});

test("opening a concern lands on the row the card names", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const items = attention(s, c);
  const t = await mount(s, c, { width: 160, height: 44 });
  try {
    await t.press("1");
    // The scratch card names /scratch and opens Storage on it.
    const at = items.findIndex((item) => item.id === "scratch");
    expect(at).toBeGreaterThan(-1);
    for (let i = 0; i < at; i++) await t.press("j");
    await t.press("enter");
    expect(t.frame()).toContain("Written since boot");
    expect(selectedRow(t.frame())).toContain("/scratch");
  } finally {
    await t.close();
  }
  // The memory-threshold card names a group and opens Resources on it.
  const g = await mount(s, c, { width: 160, height: 44 });
  try {
    await g.press("1");
    const at = items.findIndex((item) => item.id === "memory-high");
    for (let i = 0; i < at; i++) await g.press("j");
    await g.press("enter");
    expect(g.frame()).toContain("Groups");
    expect(selectedRow(g.frame())).toContain("h");
  } finally {
    await g.close();
  }
});

test("Home opens with the most urgent row selected", async () => {
  const c = defaults();
  const busy = everyCauseSnapshot(c);
  const t = await mount(busy, c, { width: 160, height: 44 });
  try {
    await t.press("1");
    // With a concern open, the selection is that concern, not an agent. The
    // two columns share a row, so the line carries the agent heading too.
    expect(selectedRow(t.frame())).toContain(attention(busy, c)[0].title);
  } finally {
    await t.close();
  }
  const calm = emptySnapshot();
  calm.lanes = [
    laneSnapshot({ id: "slow", name: "lane-slow", cpu: 1 }),
    laneSnapshot({ id: "busy", name: "lane-busy", cpu: 90 }),
  ];
  const quiet = await mount(calm, c, { width: 160, height: 44 });
  try {
    await quiet.press("1");
    expect(attention(calm, c)).toEqual([]);
    expect(quiet.frame()).toContain("Healthy");
    expect(selectedRow(quiet.frame())).toContain("lane-busy");
  } finally {
    await quiet.close();
  }
  // Between the two: no concern, but something changed. The change is what
  // the reader has not seen, so it is what the selection opens on.
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const moved = { ...calm, time: 2000 };
  h.add(moved);
  const changed = await mount(
    moved,
    c,
    { width: 160, height: 44 },
    {
      history: h,
    },
  );
  try {
    await changed.press("1");
    expect(attention(moved, c)).toEqual([]);
    expect(selectedRow(changed.frame())).toContain("Lane started");
    expect(selectedRow(changed.frame())).not.toContain("lane-busy ");
  } finally {
    await changed.close();
  }
});

test("the arrow keys reach the tiles and open the screen behind one", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a" })];
  s.groups = [groupSnapshot()];
  const rows: [number, string][] = [
    // CPU and Memory break down under Resources, Disk under Storage, Builds
    // under Builds.
    [0, "Groups"],
    [1, "Groups"],
    [2, "Written since boot"],
    [3, "Lanes building"],
  ];
  for (const [tile, lands] of rows) {
    const t = await mount(s, c, { width: 160, height: 30 });
    try {
      await t.press("1");
      for (let i = 0; i <= tile; i++) await t.press("right");
      await t.press("enter");
      expect({ tile, on: t.frame().includes(lands) }).toEqual({
        tile,
        on: true,
      });
    } finally {
      await t.close();
    }
  }
  // Up or down leaves the tiles, so Enter opens a row again rather than a
  // screen behind a tile.
  const back = await mount(s, c, { width: 160, height: 30 });
  try {
    await back.press("1");
    await back.press("right");
    await back.press("down");
    await back.press("enter");
    expect(back.frame()).toContain("lane-a");
    expect(back.frame()).not.toContain("Groups");
  } finally {
    await back.close();
  }
});

test("a tile in a narrow pane marks its cut instead of stopping mid-word", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a", cpu: 12.3, cpuShare: 12.3 })];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 180, height: 30 });
  try {
    await t.press("2");
    // The preview pane's tiles are a third of the screen, so their sentences
    // do not fit; a cut with no mark reads as a sentence that simply ended.
    const line = t
      .frame()
      .split("\n")
      .find((row) => row.includes("of one core"));
    expect(line).toBeDefined();
    expect(line).toContain("…");
  } finally {
    await t.close();
  }
});

/**
 * A history holding a lane start, then a quiet sample after it. The change is
 * older than the newest sample, so the cursor a change asks for is not the
 * cursor the screen would take on its own.
 */
function withChange(c: Config) {
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const change = emptySnapshot(2000);
  change.lanes = [laneSnapshot({ id: "a", name: "lane-a" })];
  h.add(change);
  const latest = { ...change, time: 3000 };
  h.add(latest);
  return { h, snapshot: latest };
}

test("Home lists what changed and opening one lands on Timeline at that moment", async () => {
  const c = defaults();
  const { h, snapshot } = withChange(c);
  const t = await mount(
    snapshot,
    c,
    { width: 180, height: 44 },
    { history: h },
  );
  try {
    await t.press("1");
    const frame = t.frame();
    expect(frame).toContain("Recent changes");
    expect(frame).toContain("Lane started");
    // The newest change is the first row of the section.
    const rows = frame.split("\n");
    const first = rows.findIndex((row) => row.includes("Recent changes"));
    expect(rows[first + 1]).toContain("Lane started");
    // With no concern open, the newest change is the selected row already.
    await t.press("enter");
    const timeline = t.frame();
    expect(timeline).toContain("What changed");
    // The cursor sits on the change, not on the newest sample it would take.
    expect(timeline).toContain(`cursor ${new Date(2000).toLocaleString()}`);
    expect(timeline).not.toContain(`cursor ${new Date(3000).toLocaleString()}`);
    expect(selectedRow(timeline)).toContain(
      new Date(2000).toLocaleTimeString(),
    );
  } finally {
    await t.close();
  }
});

test("clicking a tile opens the screen its key opens", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a" })];
  s.groups = [groupSnapshot()];
  // The click lands on the same target the arrow keys reach, because both
  // read `meterView`. The tile is found by its own caption, so the test does
  // not repeat the layout's arithmetic.
  const rows: [string, string][] = [
    ["CPU wait", "Groups"],
    ["Memory", "Groups"],
    ["Disk wait", "Written since boot"],
    ["Builds", "Lanes building"],
  ];
  for (const [label, lands] of rows) {
    const t = await mount(s, c, { width: 160, height: 30 });
    try {
      await t.press("1");
      const lines = t.frame().split("\n");
      const row = lines.findIndex(
        (line) => line.includes("CPU wait") && line.includes("Builds"),
      );
      expect(row).toBeGreaterThan(-1);
      await t.click(lines[row].indexOf(label), row);
      expect({ label, on: t.frame().includes(lands) }).toEqual({
        label,
        on: true,
      });
    } finally {
      await t.close();
    }
  }
});

test("Home counts the alerts that open while it runs", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  const quiet = emptySnapshot(1000);
  h.add(quiet);
  const t = await mount(quiet, c, { width: 160, height: 44 }, { history: h });
  try {
    await t.press("1");
    // Nothing has happened yet, and the baseline sample is not counted.
    expect(t.frame()).toContain("0 alerts opened since vsys started");
    // A lane escapes its slice, which opens an alert. The sample reaches the
    // running dashboard the way collection delivers it.
    const firing = emptySnapshot(2000);
    firing.lanes = [
      laneSnapshot({ id: "e.scope", name: "escaped", unconfined: true }),
    ];
    h.add(firing);
    await t.update(firing);
    expect(t.frame()).toContain("1 alert opened since vsys started");
    // A second sample with a second cause adds to it rather than replacing it.
    const worse = emptySnapshot(3000);
    worse.lanes = [
      laneSnapshot({ id: "e.scope", name: "escaped", unconfined: true }),
      laneSnapshot({ id: "c.scope", name: "capped", dangerous: true }),
    ];
    h.add(worse);
    await t.update(worse);
    expect(t.frame()).toContain("2 alerts opened since vsys started");
  } finally {
    await t.close();
  }
});

test("Home marks one focus at a time, on every kind of row it lists", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  // A sample with all three row types on screen at once: concerns, a change,
  // and agents. The rule was written at each render site, so it reached two of
  // the three and the test that named it used only a concern.
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const s = everyCauseSnapshot(c);
  s.time = 2000;
  h.add(s);
  const rows = homeItems(
    attention(s, c),
    s,
    5,
    h.events(s.time, c.historyHours * 3600000),
  );
  const kinds = ["concern", "change", "agent"] as const;
  for (const kind of kinds)
    expect({ kind, present: rows.some((row) => row.kind === kind) }).toEqual({
      kind,
      present: true,
    });
  for (const kind of kinds) {
    const at = rows.findIndex((row) => row.kind === kind);
    const t = await mount(s, c, { width: 160, height: 44 }, { history: h });
    try {
      await t.press("1");
      for (let i = 0; i < at; i++) await t.press("j");
      // The rows hold the focus, so this row is marked.
      expect({ kind, marked: selectedRow(t.frame()) !== "" }).toEqual({
        kind,
        marked: true,
      });
      // Moving onto a tile takes the focus with it. A row marked here would
      // say one thing while Enter opened another.
      await t.press("right");
      expect({ kind, marked: selectedRow(t.frame()) !== "" }).toEqual({
        kind,
        marked: false,
      });
      // And moving back off the tiles restores it.
      await t.press("down");
      expect({ kind, marked: selectedRow(t.frame()) !== "" }).toEqual({
        kind,
        marked: true,
      });
    } finally {
      await t.close();
    }
  }
  // The selected concern's detail follows the same rule, and so does copy:
  // while a tile holds the focus there is no row for either to act on.
  const t = await mount(s, c, { width: 160, height: 44 }, { history: h });
  try {
    await t.press("1");
    expect(t.frame()).toContain("Next ");
    await t.press("right");
    expect(t.frame()).not.toContain("Next ");
    await t.press("y");
    expect(t.frame()).toContain("no command to copy");
  } finally {
    await t.close();
  }
});

test("Home opens the row the reader chose after the list moves under it", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  /** A history holding one sample that carries all three Home row kinds. */
  const fresh = () => {
    const h = new History(c);
    h.add(emptySnapshot(1000));
    const s = everyCauseSnapshot(c);
    s.time = 2000;
    h.add(s);
    return { h, s };
  };
  const seed = fresh();
  const rows = homeItems(
    attention(seed.s, c),
    seed.s,
    5,
    seed.h.recentEvents(seed.s.time, recentChanges),
  );
  const firstOf = (kind: HomeItem["kind"]) =>
    rows.findIndex((row) => row.kind === kind);
  const lastOf = (kind: HomeItem["kind"]) =>
    rows.length - 1 - [...rows].reverse().findIndex((row) => row.kind === kind);
  /** A sample carrying a new lane, which records a change and adds an agent. */
  const arrives = (s: Snapshot): Snapshot => ({
    ...s,
    time: 3000,
    lanes: [...s.lanes, laneSnapshot({ id: "new.scope", name: "newcomer" })],
  });
  /** A sample where CPU pressure is gone, so that card leaves the list. */
  const clears = (s: Snapshot): Snapshot => ({
    ...s,
    time: 3000,
    system: {
      ...s.system,
      pressure: {
        ...s.system.pressure,
        cpu: { some: 0, full: 0, total: 0 },
      },
    },
  });
  // One case per row kind. Home mixes three and each list moves in its own
  // way, so each kind is chosen, moved under and opened on its own: a rule
  // written per kind reaches only the kinds someone remembered.
  /** The agent screen opens on one lane and names it above everything else. */
  const laneTitle = (frame: string) => (frame.split("\n")[2] ?? "").trim();
  const cases = [
    // The scratch card is the last concern, so the card above it clearing
    // moves it up a row.
    {
      kind: "concern" as const,
      at: lastOf("concern"),
      later: clears,
      opens: "/scratch",
      reads: selectedRow,
    },
    // A new lane records a change, and a change lands above every change
    // already listed.
    {
      kind: "change" as const,
      at: firstOf("change"),
      later: arrives,
      opens: "escaped",
      reads: selectedRow,
    },
    // The same lane adds an agent row, and agents sort by id, so it lands
    // above the last of them.
    {
      kind: "agent" as const,
      at: lastOf("agent"),
      later: arrives,
      opens: "writer",
      reads: laneTitle,
    },
  ];
  for (const { kind, at, later, opens, reads } of cases) {
    // Standing still: the presses reach the intended row, and opening it lands
    // on what that row names. This is what the moved list has to preserve.
    const still = fresh();
    const t = await mount(
      still.s,
      c,
      { width: 160, height: 44 },
      { history: still.h },
    );
    try {
      await t.press("1");
      for (let i = 0; i < at; i++) await t.press("j");
      await t.press("enter");
      expect({ kind, on: reads(t.frame()) }).toEqual({
        kind,
        on: expect.stringContaining(opens) as unknown as string,
      });
    } finally {
      await t.close();
    }
    // Moving: a sample lands while the reader sits on that row and puts
    // something above it. Enter has to open the row the reader chose, not
    // whatever took its place.
    const shifting = fresh();
    const m = await mount(
      shifting.s,
      c,
      { width: 160, height: 44 },
      { history: shifting.h },
    );
    try {
      await m.press("1");
      for (let i = 0; i < at; i++) await m.press("j");
      const next = later(shifting.s);
      shifting.h.add(next);
      await m.update(next);
      await m.press("enter");
      expect({ kind, on: reads(m.frame()) }).toEqual({
        kind,
        on: expect.stringContaining(opens) as unknown as string,
      });
    } finally {
      await m.close();
    }
  }
});

test("a Home row opens the change the reader chose, not the first at its moment", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  h.add(emptySnapshot(1000));
  // Three lanes start in one sample, so all three changes carry time 2000.
  // A timestamp names the moment, not the change.
  const busy = emptySnapshot(2000);
  busy.lanes = ["alpha", "beta", "gamma"].map((name) =>
    laneSnapshot({ id: `${name}.scope`, name }),
  );
  h.add(busy);
  const changes = h.events(busy.time, c.historyHours * 3600000);
  expect(changes.length).toBe(3);
  expect(new Set(changes.map((e) => e.time)).size).toBe(1);
  const t = await mount(busy, c, { width: 160, height: 44 }, { history: h });
  try {
    await t.press("1");
    // Open the second of the three.
    const rows = homeItems(attention(busy, c), busy, 5, changes);
    const at = rows.findIndex((row) => row.kind === "change");
    expect(at).toBeGreaterThan(-1);
    for (let i = 0; i < at + 1; i++) await t.press("j");
    const chosen = selectedRow(t.frame());
    expect(chosen).toContain(changes[1].subject);
    await t.press("enter");
    // The Timeline lands on that change, not on the first one sharing its
    // time. Matching by time always found the first however far down the
    // reader had moved.
    expect(t.frame()).toContain("What changed");
    expect(selectedRow(t.frame())).toContain(changes[1].subject);
  } finally {
    await t.close();
  }
});

test("a row opened with the keyboard keeps its change when one arrives above it", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const first = emptySnapshot(2000);
  first.lanes = [laneSnapshot({ id: "alpha.scope", name: "alpha" })];
  h.add(first);
  const t = await mount(first, c, { width: 160, height: 40 }, { history: h });
  try {
    await t.press("6");
    const changes = h.events(first.time, c.historyHours * 3600000);
    expect(changes.length).toBe(1);
    // Open the only row with the keyboard, without ever pressing an arrow, so
    // this is the entry that recorded no identity.
    await t.press("enter");
    expect(selectedRow(t.frame())).toContain("alpha");
    const cursor = `cursor ${new Date(changes[0].time).toLocaleString()}`;
    expect(t.frame()).toContain(cursor);
    // A later sample puts a change above it. The list is newest first, so the
    // row the reader opened is no longer row zero.
    const second = emptySnapshot(3000);
    second.lanes = [
      laneSnapshot({ id: "alpha.scope", name: "alpha" }),
      laneSnapshot({ id: "beta.scope", name: "beta" }),
    ];
    h.add(second);
    await t.update(second);
    const after = h.events(second.time, c.historyHours * 3600000);
    expect(after.length).toBe(2);
    expect(after[0].subject).toBe("beta");
    // The highlight, the cursor and the sample the pin key acts on all still
    // name the row the reader chose, rather than the highlight jumping to the
    // new top row while the cursor stayed behind.
    expect(selectedRow(t.frame())).toContain("alpha");
    expect(t.frame()).toContain(cursor);
    await t.press("p");
    expect(t.frame()).toContain("Agents, Resources, Builds and Storage show");
  } finally {
    await t.close();
  }
  // And the first row is a choice before the reader touches anything: a
  // change arriving above it must not take the highlight off the row they
  // were reading. This is what the seeded initial identity holds on its own,
  // since no key has been pressed to record one.
  const untouched = new History(c);
  untouched.add(emptySnapshot(1000));
  const one = emptySnapshot(2000);
  one.lanes = [laneSnapshot({ id: "alpha.scope", name: "alpha" })];
  untouched.add(one);
  const quiet = await mount(
    one,
    c,
    { width: 160, height: 40 },
    {
      history: untouched,
    },
  );
  try {
    await quiet.press("6");
    expect(selectedRow(quiet.frame())).toContain("alpha");
    const two = emptySnapshot(3000);
    two.lanes = [
      laneSnapshot({ id: "alpha.scope", name: "alpha" }),
      laneSnapshot({ id: "beta.scope", name: "beta" }),
    ];
    untouched.add(two);
    await quiet.update(two);
    expect(selectedRow(quiet.frame())).toContain("alpha");
  } finally {
    await quiet.close();
  }
  // The case that isolates the key path from the seed: the seeded change
  // leaves the window, so the highlight falls back to a row the selection does
  // not name, and Enter is the only thing that can record what it opened.
  const drifting = new History(c);
  drifting.add(emptySnapshot(1000));
  const early = emptySnapshot(2000);
  early.lanes = [laneSnapshot({ id: "alpha.scope", name: "alpha" })];
  drifting.add(early);
  const t2 = await mount(
    early,
    c,
    { width: 160, height: 40 },
    {
      history: drifting,
    },
  );
  try {
    await t2.press("6");
    expect(selectedRow(t2.frame())).toContain("alpha");
    // Ten minutes on, alpha's change is outside the five-minute window and
    // beta's is the only row. The highlight is on a change the selection does
    // not name.
    const later = emptySnapshot(602000);
    later.lanes = [
      laneSnapshot({ id: "alpha.scope", name: "alpha" }),
      laneSnapshot({ id: "beta.scope", name: "beta" }),
    ];
    drifting.add(later);
    await t2.update(later);
    expect(selectedRow(t2.frame())).toContain("beta");
    await t2.press("enter");
    const cursor = `cursor ${new Date(602000).toLocaleString()}`;
    expect(t2.frame()).toContain(cursor);
    // A third change arrives above it.
    const newest = emptySnapshot(603000);
    newest.lanes = [
      ...later.lanes,
      laneSnapshot({ id: "gamma.scope", name: "gamma" }),
    ];
    drifting.add(newest);
    await t2.update(newest);
    // The highlight and the cursor still name beta. Without the key path
    // recording what it opened, the highlight follows the stale index to
    // gamma while the cursor stays on beta.
    expect(selectedRow(t2.frame())).toContain("beta");
    expect(t2.frame()).toContain(cursor);
  } finally {
    await t2.close();
  }
});

test("a tile opens live data, not the sample the reader pinned", async () => {
  const c = defaults();
  const h = new History(c);
  const s = emptySnapshot(1000);
  s.groups = [
    groupSnapshot({ path: "busy.scope", name: "busy.scope", cpuPercent: 50 }),
  ];
  h.add(s);
  const t = await mount(s, c, { width: 160, height: 40 }, { history: h });
  try {
    await t.press("6");
    await t.press("p");
    // Timeline is not one of the pinned screens, so it says which ones are.
    expect(t.frame()).toContain("Agents, Resources, Builds and Storage show");
    await t.press("1");
    await t.press("right");
    await t.press("enter");
    // A tile drills down like a card does, so it clears the pin. Landing on
    // Resources with the pin still set would show the pinned sample beside a
    // Home that was live.
    expect(t.frame()).toContain("Groups");
    expect(t.frame().split("\n")[0]).toContain("● live");
  } finally {
    await t.close();
  }
});

test("no alerts opened reads as a count, not as a missing one", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a" })];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 160, height: 44 });
  try {
    await t.press("1");
    // Nothing has gone wrong, so the count is zero. A zero that renders as
    // absence cannot be told from a count vsys never took.
    expect(t.frame()).toContain("0 alerts opened since vsys started");
  } finally {
    await t.close();
  }
});

test("the recap holds what happened while the reader was away for longer than the window", async () => {
  const c = defaults();
  const h = new History(c);
  h.add(emptySnapshot(1000));
  // A lane starts, and then half an hour passes with nothing further. The
  // default Timeline window is five minutes, so this change is outside it.
  const started = emptySnapshot(2000);
  started.lanes = [laneSnapshot({ id: "a.scope", name: "lane-a" })];
  h.add(started);
  // The lane keeps running, so the start is the only change there is and it
  // is half an hour old. Stopping it would put a fresh event in the window
  // and the recap would look right for the wrong reason.
  const later = { ...started, time: 2000 + 30 * 60000 };
  h.add(later);
  const t = await mount(later, c, { width: 160, height: 44 }, { history: h });
  try {
    await t.press("1");
    const frame = t.frame();
    // The section is for the reader who was away. Sourcing it from the window
    // told them nothing had changed while the change sat in history.
    expect(frame).not.toContain("Nothing has changed");
    expect(frame).toContain("lane-a");
    // And opening that row lands on it, which needs a window wide enough to
    // hold it: the five-minute window does not contain it at all.
    const at = t
      .frame()
      .split("\n")
      .findIndex((row) => row.includes("Recent changes"));
    expect(at).toBeGreaterThan(-1);
    const rows = t.frame().split("\n");
    const row = rows.findIndex((line, i) => i > at && line.includes("lane-a"));
    expect(row).toBeGreaterThan(-1);
    for (let i = 0; i < row - at - 1; i++) await t.press("j");
    await t.press("enter");
    const timeline = t.frame();
    expect(timeline).toContain("What changed");
    expect(selectedRow(timeline)).toContain("lane-a");
  } finally {
    await t.close();
  }
});

test("a memory-reclaim card opens on the scope holding the swap", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const items = attention(s, c);
  const at = items.findIndex((item) => item.id === "system-memory");
  expect(at).toBeGreaterThan(-1);
  const t = await mount(s, c, { width: 160, height: 44 });
  try {
    await t.press("1");
    for (let i = 0; i < at; i++) await t.press("j");
    await t.press("enter");
    // The card's own text names the scope holding the most swap, so that is
    // the row it lands on. Carrying no group landed on whichever row
    // Resources already had selected, silently and without an error.
    expect(t.frame()).toContain("Groups");
    expect(selectedRow(t.frame())).toContain("gnome");
  } finally {
    await t.close();
  }
});

test("the copy notice does not claim a silent terminal empties the clipboard", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const items = attention(s, c);
  const at = items.findIndex((item) => item.command !== undefined);
  expect(at).toBeGreaterThan(-1);
  // The toast cuts at its own width rather than wrapping, so this is wide
  // enough to draw the clause the assertion is about.
  const t = await mount(s, c, { width: 200, height: 44 });
  try {
    await t.press("1");
    for (let i = 0; i < at; i++) await t.press("j");
    await t.press("y");
    const frame = t.frame();
    // A terminal that ignores the request leaves the clipboard alone. Saying
    // a paste gives nothing sends the reader to paste stale text believing it
    // is the command they just copied.
    expect(frame).toContain("leaves the clipboard unchanged");
    expect(frame).not.toContain("pastes nothing");
  } finally {
    await t.close();
  }
});
