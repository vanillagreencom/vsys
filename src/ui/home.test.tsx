import { expect, test } from "bun:test";
import { act } from "react";
import type { Config } from "../config/config";
import { defaults } from "../config/config";
import type { Snapshot } from "../model/types";
import type { TimelineEvent } from "../store/events";
import { History } from "../store/history";
import {
  emptySnapshot,
  escapedSnapshot,
  everyCauseSnapshot,
  groupSnapshot,
  laneSnapshot,
} from "../test/fixture";
import {
  cellStyle,
  isChildLine,
  mount,
  overflowing,
  selectedRow,
  sortMarks,
} from "../test/harness";
import { attention } from "./attention";
import { osc52 } from "./clipboard";
import type { HomeItem } from "./home";
import { homeItems, homeTarget, recentChanges } from "./home";
import { ui } from "./theme";
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
  const items = attention(s, c, { basePath: ["/usr/bin"] });
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
    // A title longer than its row is cut with the mark, not at the edge.
    const cpu = t
      .frame()
      .split("\n")
      .find((row) => row.includes("wait for CPU"));
    expect(cpu?.trimEnd().endsWith("…")).toBe(true);
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
  const rows: [string[], string][] = [
    // CPU and Memory break down under Resources, Disk under Storage, Builds
    // under Builds. Left moves back one tile rather than leaving the row.
    [[], "Groups"],
    [["right"], "Groups"],
    [["right", "right"], "Written since boot"],
    [["right", "right", "right"], "Lanes building"],
    [["right", "right", "right", "left"], "Written since boot"],
  ];
  for (const [arrows, lands] of rows) {
    const t = await mount(s, c, { width: 160, height: 30 });
    try {
      await t.press("1");
      // The region key reaches the tile row; the arrows move along it.
      await t.press(c.keys.previous);
      for (const arrow of arrows) await t.press(arrow);
      await t.press("enter");
      expect({ arrows, on: t.frame().includes(lands) }).toEqual({
        arrows,
        on: true,
      });
    } finally {
      await t.close();
    }
  }
  // The region key leaves the tiles, so Enter opens a row again rather than a
  // screen behind a tile.
  const back = await mount(s, c, { width: 160, height: 30 });
  try {
    await back.press("1");
    await back.press(c.keys.previous);
    await back.press(c.keys.next);
    await back.press("enter");
    expect(back.frame()).toContain("lane-a");
    expect(back.frame()).not.toContain("Groups");
  } finally {
    await back.close();
  }
});

test("the region key and the arrows move across all four Home regions, and the focused one says so", async () => {
  const c = defaults();
  // The forward and back keys, then the screen Enter opens once back has left
  // the lists for the tiles. The region key lands on the first tile, CPU wait,
  // behind which is Resources; left arrives at the last, Builds.
  const pairs: [string, string, string][] = [
    [c.keys.next, c.keys.previous, "Groups"],
    ["right", "left", "Lanes building"],
    [c.keys.right, c.keys.left, "Lanes building"],
  ];
  for (const [forward, back, behind] of pairs) {
    const { s, h } = everyRegion(c);
    const t = await mount(s, c, { width: 180, height: 44 }, { history: h });
    try {
      await t.press("1");
      // The key pressed, then the titles drawn in the accent colour, and how
      // many rules beside a title are undimmed. Home opens on a concern; the
      // last region holds rather than wrapping; the tiles light no list title.
      const steps: [string | null, string[], number][] = [
        [null, ["Needs attention"], 1],
        [forward, ["Recent changes"], 1],
        [forward, ["Busiest agents"], 1],
        [forward, ["Busiest agents"], 1],
        [back, ["Recent changes"], 1],
        [back, ["Needs attention"], 1],
        [back, [], 0],
      ];
      for (const [key, lit, rules] of steps) {
        if (key) await t.press(key);
        expect({ forward, key, ...focusMarks(t) }).toEqual({
          forward,
          key,
          lit,
          rules,
        });
      }
      // On the tiles, Enter opens the screen behind one.
      await t.press("enter");
      expect({ forward, on: t.frame().includes(behind) }).toEqual({
        forward,
        on: true,
      });
    } finally {
      await t.close();
    }
  }
  // With no row in any list the tiles hold the focus: no list title is lit,
  // and the arrows and Enter act on the tiles.
  const idle = await mount(emptySnapshot(), c, { width: 180, height: 44 });
  try {
    await idle.press("1");
    expect(focusMarks(idle)).toEqual({ lit: [], rules: 0 });
    await idle.press("right");
    await idle.press("right");
    await idle.press("enter");
    expect(idle.frame()).toContain("Written since boot");
  } finally {
    await idle.close();
  }
});

/** A Home with a row in every region: concerns, a recent change, agents. */
function everyRegion(c: Config) {
  const { h, snapshot } = withChange(c);
  const s = everyCauseSnapshot(c);
  s.time = snapshot.time;
  s.lanes = [...s.lanes, laneSnapshot({ id: "z", name: "lane-z", cpu: 90 })];
  return { s, h };
}

const regionTitles = ["Needs attention", "Recent changes", "Busiest agents"];
/**
 * What says which Home region holds the focus: the region titles drawn in the
 * accent colour, one entry per drawn span, and the count of undimmed rules on
 * the lines that carry a title.
 */
function focusMarks(t: Awaited<ReturnType<typeof mount>>) {
  const titled = t.ui
    .captureSpans()
    .lines.filter((line) =>
      line.spans.some((span) =>
        regionTitles.some((title) => span.text.includes(title)),
      ),
    )
    .flatMap((line) => line.spans);
  return {
    lit: titled
      .filter((span) => span.fg.equals(ui.accent))
      .flatMap((span) =>
        regionTitles.filter((title) => span.text.includes(title)),
      ),
    rules: titled.filter(
      (span) => span.text.includes("─") && (span.attributes & ui.dim) === 0,
    ).length,
  };
}

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
    const t = await mount(s, c, { width: 160, height: 44 }, { history: h });
    try {
      await t.press("1");
      // Each kind is a region of its own, reached by the region key.
      const region = kinds.indexOf(kind);
      for (let i = 0; i < region; i++) await t.press(c.keys.next);
      expect({ kind, lit: focusMarks(t).lit }).toEqual({
        kind,
        lit: [regionTitles[region]],
      });
      // The rows hold the focus, so this row is marked.
      expect({ kind, marked: selectedRow(t.frame()) !== "" }).toEqual({
        kind,
        marked: true,
      });
      // Moving onto a tile takes the focus with it. A row marked here would
      // say one thing while Enter opened another. The tiles are the first
      // region, and the region key holds there once it arrives.
      for (let i = 0; i < kinds.length; i++) await t.press(c.keys.previous);
      expect({ kind, marked: selectedRow(t.frame()) !== "" }).toEqual({
        kind,
        marked: false,
      });
      // And moving back off the tiles restores it.
      await t.press(c.keys.next);
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
    // The region key steps back to the tiles.
    await t.press(c.keys.previous);
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
    // Up and down move inside one list and the region key moves to the next,
    // so a row is reached by its region and its offset within it.
    const region = ["concern", "change", "agent"].indexOf(kind);
    const offset = at - firstOf(kind);
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
      for (let i = 0; i < region; i++) await t.press(c.keys.next);
      for (let i = 0; i < offset; i++) await t.press("j");
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
      for (let i = 0; i < region; i++) await m.press(c.keys.next);
      for (let i = 0; i < offset; i++) await m.press("j");
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
    await t.press(c.keys.previous);
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

/**
 * Two agents whose order flips the moment their CPU readings swap. Their
 * memory readings differ too, so a memory sort also reorders them.
 */
function twoAgents(topFirst: boolean) {
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({
      id: "a",
      name: "lane-a",
      cpu: topFirst ? 90 : 10,
      rss: 1024,
    }),
    laneSnapshot({
      id: "b",
      name: "lane-b",
      cpu: topFirst ? 10 : 90,
      rss: 8192,
    }),
  ];
  s.groups = [groupSnapshot()];
  return s;
}

/** The Busiest agents rows of `twoAgents`, top first. */
const agentRows = (frame: string) =>
  frame
    .split("\n")
    .filter((line) => /lane-[ab]/.test(line))
    .map((line) => line.trim());

test("the held order keeps its rows while their numbers keep moving", async () => {
  const c = defaults();
  const t = await mount(twoAgents(true), c, { width: 160, height: 30 });
  try {
    await t.press("1");
    expect(agentRows(t.frame())[0]).toContain("lane-a");
    expect(agentRows(t.frame())[0]).toContain("90.0%");
    await t.press(c.keys.hold);
    // The section says it is holding, in the place its count sits, and no
    // heading marks a sort the held rows do not follow.
    expect(t.frame()).toContain("Busiest agents  order held");
    expect(sortMarks(t.frame())).toEqual([]);
    // The readings swap, so the sort would put lane-b on top.
    await t.update(twoAgents(false));
    const held = agentRows(t.frame());
    expect(held[0]).toContain("lane-a");
    expect(held[1]).toContain("lane-b");
    // Held is the order, never the data: the numbers are the new ones.
    expect(held[0]).toContain("10.0%");
    expect(held[1]).toContain("90.0%");
  } finally {
    await t.close();
  }
});

test("a held order is released by anything that asks for an order", async () => {
  const c = defaults();
  // What releases the hold, the sample that follows it, and the row the order
  // it releases to puts on top. The held order has lane-a on top in each.
  const releases: [string[], boolean, string][] = [
    [[c.keys.hold], false, "lane-b"],
    [["2", "1"], false, "lane-b"],
    // The sort key moves to Memory, largest first.
    [[c.keys.sort], true, "lane-b"],
    // The reverse key turns CPU to smallest first.
    [[c.keys.reverse], true, "lane-b"],
  ];
  for (const [keys, topFirst, top] of releases) {
    const t = await mount(twoAgents(true), c, { width: 160, height: 30 });
    try {
      await t.press("1");
      await t.press(c.keys.hold);
      expect(t.frame()).toContain("order held");
      for (const key of keys) await t.press(key);
      await t.update(twoAgents(topFirst));
      const frame = t.frame();
      expect({
        keys,
        held: frame.includes("order held"),
        onTop: (agentRows(frame)[0] ?? "").includes(top),
        marks: sortMarks(frame).length,
      }).toEqual({ keys, held: false, onTop: true, marks: 1 });
    } finally {
      await t.close();
    }
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

test("a remediation command is copy text, never an action to run", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const t = await mount(s, c, { width: 200, height: 40 });
  try {
    await t.ui.renderOnce();
    // The card offers the command as something to copy. Nothing on this screen
    // runs it, which is what keeps a read-only dashboard read-only.
    const item = attention(s, c, { basePath: ["/usr/bin"] }).find(
      (i) => i.command !== undefined,
    );
    expect(item?.command).toBeDefined();
    expect(t.frame()).toContain(`Copy ${item?.command}`);
  } finally {
    await t.close();
  }
});

test("a held row that ends drops out, and one that climbs does not push in", () => {
  const s = twoAgents(true);
  // A third agent arrives at the top of the ranking.
  s.lanes = [...s.lanes, laneSnapshot({ id: "c", name: "lane-c", cpu: 99 })];
  const agents = (held?: string[]) =>
    homeItems([], s, 5, [], held).flatMap((row) =>
      row.kind === "agent" ? [row.lane.id] : [],
    );
  expect(agents(["a", "b"])).toEqual(["a", "b"]);
  // Without a hold the ranking decides, and the newcomer leads it.
  expect(agents()).toEqual(["c", "a", "b"]);
  // One of the held lanes ends between samples.
  s.lanes = s.lanes.filter((lane) => lane.id !== "a");
  expect(agents(["a", "b"])).toEqual(["b"]);
});

test("a concern's detail is drawn as a child of its row while the row holds the focus", async () => {
  const c = defaults();
  const { s, h } = everyRegion(c);
  const t = await mount(s, c, { width: 160, height: 44 }, { history: h });
  try {
    await t.press("1");
    const lines = t.frame().split("\n");
    const row = lines.findIndex((line) => line.includes("▍▾ "));
    expect(row).toBeGreaterThan(-1);
    // The row carries the marker; the lines under it carry the rule.
    expect(isChildLine(lines[row])).toBe(false);
    expect(isChildLine(lines[row + 1])).toBe(true);
    // An unselected concern still says it has more inside it.
    expect(lines.some((line) => line.includes("▸ "))).toBe(true);
    // The verdict line names the same concern, so the row is the one carrying
    // a marker.
    const top = () =>
      t
        .frame()
        .split("\n")
        .find(
          (line) =>
            line.includes("runs outside agents.slice") &&
            (line.includes("▸") || line.includes("▾")),
        ) ?? "";
    expect(top()).toContain("▾");
    expect(t.frame()).toContain("Next ");
    // Off the rows and onto the tiles: nothing is open under the concern, and
    // its marker says so.
    await t.press(c.keys.previous);
    expect(top()).toContain("▸");
    expect(t.frame()).not.toContain("Next ");
  } finally {
    await t.close();
  }
});

test("up and down stay inside the region in focus", async () => {
  const c = defaults();
  const { s, h } = everyRegion(c);
  const t = await mount(s, c, { width: 180, height: 44 }, { history: h });
  try {
    await t.press("1");
    expect(focusMarks(t).lit).toEqual(["Needs attention"]);
    // Two columns put two regions on one physical line, so the row is read
    // with its runs of spaces collapsed rather than column by column.
    const row = () => selectedRow(t.frame()).replace(/\s+/g, " ");
    const first = row();
    await t.press("down");
    expect(row()).not.toBe(first);
    // Far more presses than the region has rows: it holds at its last row
    // rather than walking into the next region, and at its first going up.
    for (let i = 0; i < 20; i++) await t.press("down");
    expect(focusMarks(t).lit).toEqual(["Needs attention"]);
    for (let i = 0; i < 20; i++) await t.press("up");
    expect(focusMarks(t).lit).toEqual(["Needs attention"]);
    expect(row()).toBe(first);
    // The next region is reached by a key that moves between regions.
    await t.press(c.keys.next);
    expect(focusMarks(t).lit).toEqual(["Recent changes"]);
    for (let i = 0; i < 20; i++) await t.press("down");
    expect(focusMarks(t).lit).toEqual(["Recent changes"]);
  } finally {
    await t.close();
  }
});

/** Agents and nothing else: no concern and no change, so two lists are empty. */
function agentsOnly(c: Config) {
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "slow", name: "lane-slow", cpu: 1 }),
    laneSnapshot({ id: "busy", name: "lane-busy", cpu: 90 }),
  ];
  expect(attention(s, c)).toEqual([]);
  return s;
}

test("right from the last tile enters the first list with a row, and left returns to the last tile", async () => {
  const c = defaults();
  const t = await mount(agentsOnly(c), c, { width: 180, height: 44 });
  try {
    await t.press("1");
    expect(focusMarks(t).lit).toEqual(["Busiest agents"]);
    // The region key lands on the first tile and right walks the row. No
    // list title is lit while a tile holds the focus.
    await t.press(c.keys.previous);
    for (let i = 0; i < 3; i++) {
      await t.press("right");
      expect({ i, lit: focusMarks(t).lit }).toEqual({ i, lit: [] });
    }
    // Past the last tile, over the two empty lists, to the one with rows.
    await t.press("right");
    expect(focusMarks(t).lit).toEqual(["Busiest agents"]);
    // And back to the tile right left from: the last, whose screen is Builds.
    await t.press("left");
    expect(focusMarks(t).lit).toEqual([]);
    await t.press("enter");
    expect(t.frame()).toContain("Lanes building");
  } finally {
    await t.close();
  }
});

test("a Home region's own key lands on its first place", async () => {
  const c = defaults();
  const { s, h } = everyRegion(c);
  const t = await mount(s, c, { width: 180, height: 44 }, { history: h });
  try {
    await t.press("1");
    const row = () => selectedRow(t.frame()).replace(/\s+/g, " ");
    // The key, then the list title it lights. Each key is pressed from another
    // region, then again from lower down its own list, and both times it lands
    // on the list's first row, the row up cannot leave.
    const lists: [string, string][] = [
      [c.keys.busiest, "Busiest agents"],
      [c.keys.changes, "Recent changes"],
      [c.keys.attention, "Needs attention"],
    ];
    for (const [key, title] of lists) {
      await t.press(key);
      const landed = row();
      await t.press("up");
      expect({ key, lit: focusMarks(t).lit, row: row() }).toEqual({
        key,
        lit: [title],
        row: landed,
      });
      await t.press("down");
      await t.press(key);
      expect({ key, lit: focusMarks(t).lit, row: row() }).toEqual({
        key,
        lit: [title],
        row: landed,
      });
    }
    // Left from the first list stands on the last tile; the tiles' key moves
    // to the first, whose screen is Resources.
    await t.press("left");
    await t.press(c.keys.tiles);
    expect(focusMarks(t).lit).toEqual([]);
    await t.press("enter");
    expect(t.frame()).toContain("Groups");
    expect(t.frame()).not.toContain("Lanes building");
  } finally {
    await t.close();
  }
});

test("a key for a Home region with no rows changes nothing", async () => {
  const c = defaults();
  const t = await mount(agentsOnly(c), c, { width: 180, height: 44 });
  try {
    await t.press("1");
    // Off the first row, so a key that fell through to the first row there is
    // would show.
    await t.press("down");
    const before = t.frame();
    for (const key of [c.keys.attention, c.keys.changes]) {
      await t.press(key);
      expect({ key, same: t.frame() === before }).toEqual({ key, same: true });
    }
  } finally {
    await t.close();
  }
});

test("each Home region draws the key that jumps to it, dimmed before its name", async () => {
  // A rebound key, so what is drawn is read from the binding.
  const c = { ...defaults(), keys: { ...defaults().keys, attention: "i" } };
  const { s, h } = everyRegion(c);
  const t = await mount(s, c, { width: 180, height: 44 }, { history: h });
  try {
    await t.press("1");
    // The tile row has no heading, so its key leads the first tile's label.
    const names: [string, string][] = [
      ["t", "CPU wait"],
      ["i", "Needs attention"],
      ["g", "Recent changes"],
      ["b", "Busiest agents"],
    ];
    for (const [key, name] of names)
      expect({ name, key: cellStyle(t.ui, `${key} ${name}`, ui.dim) }).toEqual({
        name,
        key: "dim",
      });
  } finally {
    await t.close();
  }
});

test("Busiest agents sorts from its own headings, and the heading says which", async () => {
  const c = defaults();
  // One Home column, wide enough to draw all four headings the sort cycles
  // through.
  const t = await mount(twoAgents(true), c, { width: 140, height: 30 });
  try {
    await t.press("1");
    // The key pressed, the one heading it leaves marked, and the agent on
    // top. lane-a has the higher CPU and the lower memory, and a tie on state
    // falls to the lane id.
    const steps: [string | null, string, string][] = [
      [null, "↓ CPU", "lane-a"],
      [c.keys.reverse, "↑ CPU", "lane-b"],
      [c.keys.sort, "↑ Memory", "lane-a"],
      [c.keys.reverse, "↓ Memory", "lane-b"],
      [c.keys.reverse, "↑ Memory", "lane-a"],
      [c.keys.sort, "Agent ↑", "lane-a"],
      [c.keys.sort, "State ↑", "lane-a"],
      [c.keys.sort, "↑ CPU", "lane-b"],
    ];
    for (const [key, heading, top] of steps) {
      if (key) await t.press(key);
      const frame = t.frame();
      expect({
        key,
        marks: sortMarks(frame),
        onTop: (agentRows(frame)[0] ?? "").includes(top),
      }).toEqual({ key, marks: [heading], onTop: true });
    }
  } finally {
    await t.close();
  }
  // Two Home columns leave no room for State, so a full cycle of the sort key
  // passes over it and every press lands on a heading that is drawn.
  const shed = await mount(twoAgents(true), c, { width: 160, height: 30 });
  try {
    await shed.press("1");
    const marks: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await shed.press(c.keys.sort);
      marks.push(sortMarks(shed.frame()));
    }
    expect(marks).toEqual([["↓ Memory"], ["Agent ↓"], ["↓ CPU"]]);
  } finally {
    await shed.close();
  }
});

test("a change row cuts with a mark, at any width, and its columns line up", async () => {
  const c = defaults();
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const change = emptySnapshot(2000);
  // Subjects longer than any column they could be given, so each is cut at
  // both widths.
  change.lanes = ["a", "b"].map((id) =>
    laneSnapshot({ id, name: `lane-${id}-${"long-".repeat(40)}end` }),
  );
  h.add(change);
  const latest = { ...change, time: 3000 };
  h.add(latest);
  for (const width of [120, 180]) {
    const t = await mount(latest, c, { width, height: 30 }, { history: h });
    try {
      await t.press("1");
      const rows = t
        .frame()
        .split("\n")
        .filter((line) => /Lane started/.test(line));
      expect({ width, rows: rows.length }).toEqual({ width, rows: 2 });
      // The subject was cut, and it says so. A row that simply stopped
      // mid-word leaves a reader guessing whether that was the whole name.
      for (const row of rows)
        expect({ width, cut: row.trimEnd().slice(-8).includes("…") }).toEqual({
          width,
          cut: true,
        });
      // The kind starts at the same column on every row.
      const at = rows.map((row) => row.indexOf("Lane started"));
      expect({ width, columns: new Set(at).size }).toEqual({
        width,
        columns: 1,
      });
      // Timeline draws the same changes at its own width, cut the same way.
      await t.press("6");
      const listed = t
        .frame()
        .split("\n")
        .filter((line) => /Lane started/.test(line));
      expect({
        width,
        cut: listed.map((row) => row.trimEnd().endsWith("…")),
      }).toEqual({ width, cut: [true, true] });
    } finally {
      await t.close();
    }
  }
});

/** Lanes that resolve to one name, with identical readings. */
function sameName(count = 6) {
  const s = emptySnapshot();
  // Every reading identical, so nothing but an identity column can separate
  // them.
  s.lanes = Array.from({ length: count }, (_, i) =>
    laneSnapshot({
      id: `lane-${i}`,
      name: "method",
      mainPid: 3400 + i * 17,
      cpu: 40,
      rss: 1024,
      builds: { rustc: 2 },
      pids: [3400 + i * 17],
    }),
  );
  s.groups = [groupSnapshot()];
  return s;
}

/**
 * The ids the screen drew: on each row, the digits that end where the id
 * column's heading ends, so an id drawn off its column is not read. Whole
 * lines are not compared: from `wideWidth` up the side pane draws beside the
 * list, so one physical line carries a list row and side-pane text, and
 * identical rows read as different.
 */
function drawnIds(frame: string): string[] {
  const lines = frame.split("\n");
  const heading = lines.find((line) => line.includes("PID")) ?? "";
  const end = heading.indexOf("PID") + "PID".length;
  if (end < "PID".length) return [];
  return lines
    .filter((line) => line.includes("method"))
    .map((line) => line.slice(0, end).match(/\d+$/)?.[0] ?? "")
    .filter((id) => id !== "");
}

test("no list of lane names draws two rows a reader cannot tell apart", async () => {
  const c = defaults();
  const s = sameName();
  // Every view that draws lane names, by the keys that reach it: Home's
  // Busiest agents, the Agents list, the Agents table and the Builds lanes.
  // Each width is a different Agents list: the narrowest terminal the screens
  // support (80), the narrow list (99), a list that sheds its program column
  // without the side pane (106) and with it (163), and the same two keeping it
  // (120, 180).
  const views = [["1"], ["2"], ["2", c.keys.details], ["4"]];
  for (const view of views) {
    for (const width of [80, 99, 106, 120, 163, 180]) {
      const t = await mount(s, c, { width, height: 40 });
      try {
        for (const key of view) await t.press(key);
        const ids = drawnIds(t.frame());
        // The id is the only thing that can tell these rows apart, so every
        // row carries one and no two rows carry the same, and no row is wider
        // than the box the screen gives it.
        expect({
          view,
          width,
          drawn: ids.length,
          distinct: new Set(ids).size,
          cut: overflowing(t.ui, "method"),
        }).toEqual({ view, width, drawn: 6, distinct: 6, cut: [] });
      } finally {
        await t.close();
      }
    }
  }
});

test("Home keeps the name readable rather than the state column", async () => {
  const c = defaults();
  const s = sameName(2);
  // Names exactly at the floor, so a column that starved the name would cut
  // them and a reader would be left with two identical stubs.
  const long = ["method-worktree-alpha-01", "method-worktree-alpha-02"];
  s.lanes.forEach((lane, i) => {
    lane.name = long[i];
  });
  // Two Home columns, and not enough width for the name, the id and the state
  // together: the state is what goes.
  const t = await mount(s, c, { width: 160, height: 40 });
  try {
    await t.press("1");
    const frame = t.frame();
    for (const name of long) expect(frame).toContain(name);
    const rows = frame.split("\n").filter((line) => line.includes("method-"));
    expect(new Set(rows.map((row) => row.trimEnd())).size).toBe(rows.length);
  } finally {
    await t.close();
  }
});

/** Lets the settled layout reading land, which is when a scroll follows it. */
async function settled(t: Awaited<ReturnType<typeof mount>>) {
  await t.ui.renderOnce();
  await act(async () => {
    await Bun.sleep(20);
  });
  await t.ui.renderOnce();
}

test("moving back to the tiles brings the tiles back on screen", async () => {
  const c = defaults();
  const { s, h } = everyRegion(c);
  // Short enough that Home does not fit whole, which is the only shape in
  // which anything can be off screen.
  const t = await mount(s, c, { width: 120, height: 22 }, { history: h });
  try {
    // A tile draws this under its number and nothing else on Home does.
    const tilesShown = () => t.frame().includes("in use: agents");
    await t.press("1");
    await settled(t);
    // Walk to the bottom of the last list, which scrolls the tiles away.
    for (let i = 0; i < 3; i++) await t.press(c.keys.next);
    for (let i = 0; i < 30; i++) await t.press("j");
    await settled(t);
    expect(tilesShown()).toBe(false);
    // Back to the tiles. The tile row holds the focus now, so it is what has
    // to be in view.
    for (let i = 0; i < 3; i++) await t.press(c.keys.previous);
    await settled(t);
    expect(tilesShown()).toBe(true);
  } finally {
    await t.close();
  }
});

test("a sample leaves a Home reader where they scrolled to", async () => {
  const c = defaults();
  const { s, h } = everyRegion(c);
  const t = await mount(s, c, { width: 120, height: 22 }, { history: h });
  try {
    const band = () => t.frame().split("\n").slice(2, 6).join("\n");
    await t.press("1");
    // A reader arrives at a screen that has finished drawing itself.
    await settled(t);
    // Down to the bottom, so there is somewhere above to scroll back to.
    for (let i = 0; i < 3; i++) await t.press(c.keys.next);
    for (let i = 0; i < 30; i++) await t.press("j");
    await settled(t);
    const standing = band();
    // The wheel moves this box, so an effect that scrolled on every render
    // would take the reader back to the selection on the next tick.
    for (let i = 0; i < 6; i++) await t.wheel(40, 10, "up");
    const wheeled = band();
    expect(wheeled).not.toBe(standing);
    await t.update({ ...s, time: s.time + 1000 });
    await settled(t);
    expect(band()).toBe(wheeled);
  } finally {
    await t.close();
  }
});

test("an open card keeps its next step and its command on an ordinary screen", async () => {
  const c = defaults();
  // A machine whose agents were all started outside the agent slice: the card
  // has a sentence's worth of trail for each of two scopes and a lane list
  // that grows with every one of them.
  const s = escapedSnapshot({ lanes: 5, perLane: 2 });
  for (const size of [
    { width: 80, height: 32 },
    { width: 160, height: 36 },
  ]) {
    const t = await mount(s, c, size);
    try {
      await t.ui.renderOnce();
      const rows = t.frame().split("\n");
      const card = rows.findIndex((row) => row.includes("▾"));
      const next = rows.findIndex((row) => row.includes("Next "));
      const copied = rows.findIndex((row) =>
        row.includes("systemd-run --user --slice=agents.slice"),
      );
      // The two lines the reader acts on are the two a detail must not push
      // off the screen, however many processes escaped.
      expect(card).toBeGreaterThan(0);
      expect(next).toBeGreaterThan(card);
      expect(copied).toBeGreaterThan(next);
      // The detail between the card and its next step draws six rows, which
      // is what leaves room for the two lines under it.
      expect(next - card - 1).toBe(6);
      // In those six rows it names both scopes once each, and still holds the
      // lane names the cut title above it lost.
      const detail = rows.slice(card + 1, next).join(" ");
      expect(detail.split("Launched bare")).toHaveLength(3);
      expect(detail).toContain("tmux-spawn-0.scope");
      expect(detail).toContain("tmux-spawn-1.scope");
      expect(detail).toContain("Lanes: kendex agent-0 PID 1000");
    } finally {
      await t.close();
    }
  }
});
