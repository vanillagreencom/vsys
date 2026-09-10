import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { History } from "../store/history";
import type { Point } from "../store/point";
import {
  emptySnapshot,
  everyCauseSnapshot,
  laneSnapshot,
} from "../test/fixture";
import { mount, selectedRow } from "../test/harness";
import { markerRuns, pointAt, windowLabel } from "./timeline-screen";

test("marker runs merge neighbours and let the cursor win over a change", () => {
  expect(markerRuns([false, false, true, true, false], undefined)).toEqual([
    { kind: "quiet", at: 0, text: "··" },
    { kind: "change", at: 2, text: "!!" },
    { kind: "quiet", at: 4, text: "·" },
  ]);
  expect(markerRuns([true, true], 1)).toEqual([
    { kind: "change", at: 0, text: "!" },
    { kind: "cursor", at: 1, text: "▲" },
  ]);
  expect(markerRuns([], 0)).toEqual([]);
});

test("a window reads as minutes under an hour and whole hours above", () => {
  const rows: [number, string][] = [
    [300000, "5m"],
    [900000, "15m"],
    [3600000, "1h"],
    [21600000, "6h"],
    [86400000, "24h"],
  ];
  for (const [ms, label] of rows) expect(windowLabel(ms)).toBe(label);
});

test("the cursor stands on the last sample at or before it", () => {
  const point = (time: number) => ({ time }) as Point;
  const points = [point(1000), point(2000), point(3000)];
  expect(pointAt(points, null)?.time).toBe(3000);
  expect(pointAt(points, 2500)?.time).toBe(2000);
  expect(pointAt(points, 2000)?.time).toBe(2000);
  expect(pointAt(points, 500)).toBeUndefined();
  expect(pointAt([], null)).toBeUndefined();
});

test("Timeline lists what changed with a cause instead of raw samples", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const later = emptySnapshot(2000);
  later.lanes = [
    laneSnapshot({ name: "lane-a", account: "work", unconfined: true }),
  ];
  h.add(later);
  const t = await mount(later, c, { width: 160, height: 40 }, { history: h });
  try {
    await t.press("6");
    const frame = t.frame();
    expect(frame).toContain("What changed  3, newest first");
    expect(frame).toMatch(/Lane started\s+lane-a/);
    expect(frame).toContain("account work in agents.slice");
    expect(frame).toMatch(/Alert opened\s+an agent ran outside/);
  } finally {
    await t.close();
  }
});

test("the Timeline change list stops at the rows the viewport has", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const busy = emptySnapshot(2000);
  busy.lanes = Array.from({ length: 12 }, (_, i) =>
    laneSnapshot({
      id: `lane-${i}.scope`,
      name: i === 0 ? `wide-${"x".repeat(400)}` : `lane-${i}`,
    }),
  );
  h.add(busy);
  const t = await mount(busy, c, { width: 160, height: 30 }, { history: h });
  try {
    await t.press("6");
    const frame = t.frame();
    // The heading counts what there is; the list says which of them it drew,
    // in the one place that knows, rather than in two that can disagree.
    expect(frame).toContain("What changed  12, newest first");
    expect(frame).toContain("1\u20136 of 12");
    expect(frame).toMatch(/Lane started\s+lane-5/);
    expect(frame).not.toContain("lane-11");
    // The cursor tiles summarise the six metrics, so a terminal too short for
    // both drops the sparkline rows rather than the change list.
    expect(frame).toContain("Memory wait");
    expect(frame).not.toMatch(/Memory wait\s+·/);
    // A 400-character subject takes one row and cannot push the rest out.
    expect(frame).not.toContain("xxxxxxxxxx\n");
    expect(frame).toContain("? keys");
  } finally {
    await t.close();
  }
});

test("an alert inside its hold does not mark a change on the strip", async () => {
  const c = defaults();
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const alarmed = emptySnapshot(2000);
  alarmed.alerts = [
    { time: 2000, rule: "scrub", subject: "/x", message: "Scrub problem: /x" },
  ];
  h.add(alarmed);
  const t = await mount(alarmed, c, { width: 160, height: 40 }, { history: h });
  try {
    await t.press("6");
    const frame = t.frame();
    expect(frame).toContain("Nothing changed in this window");
    // The rule fired, but no event holds yet, so the strip stays unmarked.
    // The strip is the row carrying the cursor mark, under the charts.
    const strip = frame.split("\n").find((row) => row.includes("▲"));
    expect(strip).toBeDefined();
    expect(strip).not.toContain("!");
  } finally {
    await t.close();
  }
});

test("the cursor readings are tiles, one quantity above each number", async () => {
  const c = defaults();
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const s = emptySnapshot(2000);
  s.system.pressure.cpu = { some: 12, full: 0, total: 0 };
  h.add(s);
  const t = await mount(s, c, { width: 180, height: 44 }, { history: h });
  try {
    await t.press("6");
    const lines = t.frame().split("\n");
    // Six readings on one row joined by dots is a run to parse; each now
    // names its quantity on the row above its own number.
    const labels = lines.findIndex(
      (line) => line.includes("CPU wait") && line.includes("Disk wait"),
    );
    expect(labels).toBeGreaterThan(-1);
    expect(lines[labels + 1]).toContain("12.0%");
    expect(t.frame()).not.toMatch(/cpu wait 12\.0% ·/);
  } finally {
    await t.close();
  }
  // No sample under the cursor says so rather than printing a row of dots.
  const bare = new History(c);
  const empty = emptySnapshot(1000);
  const b = await mount(
    empty,
    c,
    { width: 180, height: 44 },
    { history: bare },
  );
  try {
    await b.press("6");
    expect(b.frame()).toContain("No sample under the cursor");
  } finally {
    await b.close();
  }
});

test("the Timeline change list is driven from the keyboard, not the mouse alone", async () => {
  const c = defaults();
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const busy = emptySnapshot(5000);
  busy.lanes = [1, 2, 3].map((n) =>
    laneSnapshot({ id: `lane-${n}`, name: `lane-${n}` }),
  );
  h.add(busy);
  // A quiet sample after the changes, so the cursor Enter sets differs from
  // the one the screen takes on its own.
  const latest = { ...busy, time: 9000 };
  h.add(latest);
  const t = await mount(latest, c, { width: 180, height: 44 }, { history: h });
  try {
    await t.press("6");
    const first = selectedRow(t.frame());
    expect(first).toContain("Lane started");
    // Down moves the selection to the next change, and up moves it back.
    await t.press("j");
    const second = selectedRow(t.frame());
    expect(second).toContain("Lane started");
    expect(second).not.toBe(first);
    await t.press("k");
    expect(selectedRow(t.frame())).toBe(first);
    // Enter moves the time cursor onto the selected change.
    expect(t.frame()).toContain(`cursor ${new Date(9000).toLocaleString()}`);
    await t.press("enter");
    expect(t.frame()).toContain(`cursor ${new Date(5000).toLocaleString()}`);
    // The pin key still pins from this screen, so a row can be pinned.
    await t.press("p");
    expect(t.frame()).toMatch(/Agents, Resources, Builds and Storage show/);
  } finally {
    await t.close();
  }
});

test("a change about a cgroup reads as a name, with the unit under the selection", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  const first = everyCauseSnapshot(c);
  first.groups = first.groups.map((g) =>
    g.name === "gnome.scope"
      ? { ...g, name: "app-Hyprland-ghostty-b95bd288.scope" }
      : g,
  );
  h.add(first);
  h.add({ ...first, time: first.time + 1000 });
  const t = await mount(
    { ...first, time: first.time + 1000 },
    c,
    { width: 180, height: 44 },
    { history: h },
  );
  try {
    await t.press("6");
    const frame = t.frame();
    // systemd's own name never reaches the row.
    expect(frame).not.toContain("app-Hyprland-ghostty");
    expect(frame).toContain("ghostty");
    // The raw unit is one keystroke away, under the row that decoded it.
    const at = t
      .frame()
      .split("\n")
      .findIndex((row) => row.includes("the desktop swapped out"));
    expect(at).toBeGreaterThan(-1);
    const heading = t
      .frame()
      .split("\n")
      .findIndex((row) => row.includes("What changed"));
    for (let i = heading + 1; i < at; i++) await t.press("j");
    expect(t.frame()).toContain("app-Hyprland-ghostty-b95bd288.scope");
  } finally {
    await t.close();
  }
});

test("a Timeline with no sample under the cursor budgets the line it draws", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // A history with nothing in it: vsys started a moment ago, so no sample
  // sits under the cursor and the readings are one line, not a tile block.
  const t = await mount(
    s,
    c,
    { width: 100, height: 29 },
    { history: new History(c) },
  );
  try {
    await t.press("6");
    const frame = t.frame();
    expect(frame).toContain("No sample under the cursor.");
    // Budgeting the tile block instead of that line costs four rows, which is
    // enough at this height to drop the sparklines and leave their space
    // empty. Each row is one metric, and they are what the reader loses.
    for (const label of [
      "CPU wait",
      "Memory wait",
      "Disk wait",
      "Builds",
      "Escaped",
      "Corruption",
    ])
      expect({ label, drawn: frame.includes(label) }).toEqual({
        label,
        drawn: true,
      });
  } finally {
    await t.close();
  }
});

test("a shorter window leaves the Timeline selection on a row that exists", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  h.add(emptySnapshot(1000));
  // Twelve changes half an hour ago, and one recent. The five-minute window
  // holds the recent one alone; an hour holds them all.
  const old = emptySnapshot(2000);
  old.lanes = Array.from({ length: 12 }, (_, i) =>
    laneSnapshot({ id: `lane-${i}.scope`, name: `lane-${i}` }),
  );
  h.add(old);
  // One lane stops, forty minutes later. That stop is the only change the
  // five-minute window holds; without it the short window is empty and there
  // is no row to be on either way.
  const now = {
    ...old,
    time: 2000 + 40 * 60000,
    lanes: old.lanes.slice(1),
  };
  h.add(now);
  const t = await mount(now, c, { width: 160, height: 40 }, { history: h });
  try {
    await t.press("6");
    // Widen to an hour, then select a deep row.
    await t.press("w");
    await t.press("w");
    for (let i = 0; i < 8; i++) await t.press("j");
    expect(selectedRow(t.frame())).not.toBe("");
    // Cycle back to a window that holds fewer changes. The row number the
    // reader was on names nothing there.
    await t.press("w");
    await t.press("w");
    await t.press("w");
    const frame = t.frame();
    expect(frame).toContain("Last 5m");
    // A row that exists is marked, and Enter acts on it rather than on a
    // change the list does not have.
    expect(selectedRow(frame)).not.toBe("");
    await t.press("enter");
    expect(t.frame()).toContain("What changed");
  } finally {
    await t.close();
  }
});

test("the Timeline selection stays on a row the reader can see", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const busy = emptySnapshot(2000);
  busy.lanes = Array.from({ length: 12 }, (_, i) =>
    laneSnapshot({ id: `lane-${i}.scope`, name: `lane-${i}` }),
  );
  h.add(busy);
  const t = await mount(busy, c, { width: 160, height: 30 }, { history: h });
  try {
    await t.press("6");
    // Walk the selection past the fold. The list pages around it, so the
    // highlighted row is drawn wherever the selection sits; a fixed slice let
    // it walk off the end of what was drawn.
    for (let i = 0; i < 11; i++) await t.press("j");
    const frame = t.frame();
    expect(selectedRow(frame)).not.toBe("");
    expect(selectedRow(frame)).toContain("lane-11");
    // And Enter acts on the row that is marked, not on one off-screen.
    await t.press("enter");
    expect(t.frame()).toContain("What changed");
    expect(selectedRow(t.frame())).toContain("lane-11");
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
