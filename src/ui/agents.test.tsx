import { expect, test } from "bun:test";
import { act } from "react";
import type { Config } from "../config/config";
import { columns, defaults } from "../config/config";
import type { Snapshot } from "../model/types";
import type { Level } from "../model/verdict";
import { History } from "../store/history";
import type { LaneSample } from "../store/lane-series";
import {
  emptySnapshot,
  everyCauseSnapshot,
  groupSnapshot,
  laneSnapshot,
} from "../test/fixture";
import { mount, selectedRow } from "../test/harness";
import {
  columnLabels,
  findLanes,
  laneBadge,
  laneLevel,
  tableColumn,
  trendEnd,
  trendMarks,
  trendWidth,
} from "./agents";
import { attention } from "./attention";
import { cell, columnGap, headerText } from "./columns";
import { laneValue } from "./format";
import { windows } from "./timeline-screen";

test("search matches every naming field, case-insensitively, in the sort order", () => {
  const c = defaults();
  const lanes = [
    laneSnapshot({ id: "a", name: "alpha", cpu: 1 }),
    laneSnapshot({ id: "b", name: "beta", account: "Work", cpu: 2 }),
    laneSnapshot({ id: "c", name: "gamma", pane: "%7", cpu: 3 }),
    laneSnapshot({ id: "d", name: "delta", title: "Kendex", cpu: 4 }),
    laneSnapshot({ id: "e", name: "eps", cwd: "/srv/acme", cpu: 5 }),
    laneSnapshot({ id: "f", name: "zeta", branch: "feat/x", cpu: 6 }),
    laneSnapshot({ id: "g", name: "eta", tool: "codex", cpu: 7 }),
  ];
  const rows: [string, string[]][] = [
    ["ALPHA", ["a"]],
    ["work", ["b"]],
    ["%7", ["c"]],
    ["kendex", ["d"]],
    ["acme", ["e"]],
    ["feat/", ["f"]],
    ["codex", ["g"]],
    ["", ["g", "f", "e", "d", "c", "b", "a"]],
    ["nothing", []],
  ];
  for (const [query, ids] of rows)
    expect(findLanes(lanes, query, c).map((l) => l.id)).toEqual(ids);
});

test("a lane's badge names the worst thing about it, and its level follows the thresholds", () => {
  const c = defaults();
  const plain = laneSnapshot();
  expect(laneBadge(plain)).toBeNull();
  expect(laneLevel(plain, c)).toBe("ok");
  const escaped = laneSnapshot({ unconfined: true, dangerous: true });
  expect(laneBadge(escaped)?.text).toBe("outside agent slice");
  expect(laneLevel(escaped, c)).toBe("danger");
  const capped = laneSnapshot({ dangerous: true });
  expect(laneBadge(capped)?.level).toBe("danger");
  const blocked = laneSnapshot({
    state: "blocked",
    blocked: 1,
    blockedOn: "memory",
  });
  expect(laneBadge(blocked)).toEqual({
    text: "blocked: 1 task waiting on memory",
    level: "warn",
  });
  const rows: [number, Level][] = [
    [c.pressureAmber, "ok"],
    [c.pressureAmber + 0.1, "warn"],
    [c.pressureRed, "warn"],
    [c.pressureRed + 0.1, "danger"],
  ];
  for (const [pressure, level] of rows)
    expect(laneLevel(laneSnapshot({ pressure }), c)).toBe(level);
});

test("the table's heading and its rows are built from one column spec", () => {
  const c = defaults();
  const spec = c.columns.map(tableColumn);
  // Every configurable column has a spec, derived from the settings contract
  // rather than from a second list here.
  expect(spec.length).toBe(c.columns.length);
  for (const name of columns)
    expect({ name, label: tableColumn(name).label }).toEqual({
      name,
      label: columnLabels[name] ?? name,
    });
  // A row occupies exactly the columns the heading does.
  const lane = laneSnapshot({ name: "lane-a" });
  const row = spec
    .map((column, at) => cell(column, laneValue(lane, c.columns[at], c)))
    .join(columnGap);
  expect(row.length).toBe(headerText(spec).length);
  // The numeric columns end where their headings end.
  const cpu = c.columns.indexOf("cpu");
  const before = spec
    .slice(0, cpu)
    .reduce((n, col) => n + col.width + columnGap.length, 0);
  expect(row.slice(before, before + spec[cpu].width).trimStart()).toBe(
    laneValue(lane, "cpu", c),
  );
  expect(spec[cpu].align).toBe("right");
  expect(tableColumn("name").align).toBeUndefined();
});

test("a row with no series yet draws nothing, and a read one draws what it holds", () => {
  const end = 300000;
  const window = 300000;
  // Still loading: a placeholder in a chart column would be read as a flat
  // measurement at zero, which is a different claim from "not read yet".
  const loading = trendMarks(undefined, end, window, "block");
  expect(loading).toBe(" ".repeat(trendWidth));
  expect(loading.trim()).toBe("");
  // Read and empty is its own answer: the window holds no sample, and the
  // gap dots say so.
  const empty = trendMarks([], end, window, "block");
  expect([...new Set(empty)]).toEqual(["·"]);
  expect(empty.length).toBe(trendWidth);
  // Read with samples: the marks rise with the values.
  const rising = trendMarks(
    Array.from({ length: trendWidth }, (_, i) => ({
      time: i * (window / trendWidth) + 1,
      cpu: i * 10,
      rss: 0,
      pressure: null,
      memoryPressure: null,
      ioPressure: null,
    })),
    end,
    window,
    "block",
  );
  expect(rising.length).toBe(trendWidth);
  expect(rising).not.toContain(" ");
  expect(rising.at(-1)).toBe("█");
});

test("Agents finds a worktree and clears the search without losing the list", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ name: "payments", cwd: "/work/acme/payment-service" }),
    laneSnapshot({ id: "other", name: "website", cwd: "/work/site" }),
  ];
  const t = await mount(s, c, { width: 80, height: 24 });
  try {
    await t.press("2");
    await t.press("/");
    await act(async () => {
      await t.ui.mockInput.typeText("ACME");
    });
    await t.press("enter");
    expect(t.frame()).toContain("payments");
    expect(t.frame()).not.toContain("website");
    await t.press("/");
    await act(async () => {
      t.ui.mockInput.pressEscape();
      await Bun.sleep(50);
    });
    await t.ui.renderOnce();
    expect(t.frame()).toContain("website");
  } finally {
    await t.close();
  }
});

test("a numeric column ends where its heading ends, on the rendered screen", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a", cpu: 5, rss: 1024, pressure: 12 })];
  const t = await mount(s, c, { width: 140, height: 24 });
  try {
    await t.press("2");
    const lines = t.frame().split("\n");
    const heading = lines.find(
      (line) => line.includes("Agent") && line.includes("Memory"),
    );
    const row = lines.find((line) => line.includes("lane-a"));
    expect(heading).toBeDefined();
    expect(row).toBeDefined();
    if (!heading || !row) throw new Error("no heading and row to compare");
    // Right-aligned cells and their headings share a last column, which is
    // what one shared column spec buys.
    const rows: [string, string][] = [
      ["CPU", "5.0%"],
      ["Memory", "1.0 KiB"],
      ["Wait", "12.0%"],
    ];
    for (const [label, value] of rows)
      expect({
        label,
        heading: heading.indexOf(label) + label.length,
      }).toEqual({ label, heading: row.indexOf(value) + value.length });
  } finally {
    await t.close();
  }
  // The narrower terminal keeps every column inside the panel: the last one
  // is reached, not cut off the right edge.
  const tight = await mount(s, c, { width: 100, height: 24 });
  try {
    await tight.press("2");
    const line = tight
      .frame()
      .split("\n")
      .find((row) => row.includes("lane-a"));
    expect(line).toContain("sleeping");
    expect(line?.length).toBe(100);
  } finally {
    await tight.close();
  }
});

test("a wide Agents list carries the selected agent beside it", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", cwd: "/repo/one" }),
    laneSnapshot({ id: "b", name: "lane-b", cwd: "/repo/two" }),
  ];
  s.groups = [groupSnapshot()];
  const wide = await mount(s, c, { width: 180, height: 30 });
  try {
    await wide.press("2");
    const frame = wide.frame();
    // The pane names the selected agent beside the list, so a row can be read
    // against what it means without opening it.
    expect(frame).toContain("Selected");
    expect(frame).toContain("/repo/one");
    expect(frame).not.toContain("/repo/two");
    await wide.press("j");
    expect(wide.frame()).toContain("/repo/two");
  } finally {
    await wide.close();
  }
  // Below the width the list keeps the whole panel.
  const narrow = await mount(s, c, { width: 120, height: 30 });
  try {
    await narrow.press("2");
    expect(narrow.frame()).not.toContain("Selected");
  } finally {
    await narrow.close();
  }
});

test("leaving an agent returns to the list with that agent selected", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", cpu: 9 }),
    laneSnapshot({ id: "b", name: "lane-b", cpu: 5 }),
    laneSnapshot({ id: "z", name: "lane-z", cpu: 1 }),
  ];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 120, height: 30 });
  try {
    await t.press("2");
    await t.press("j");
    await t.press("enter");
    expect(t.frame()).toContain("lane-b");
    await t.press("escape");
    expect(selectedRow(t.frame())).toContain("lane-b");
    // A lane opened from Home was never selected in the list, and going back
    // still lands on it rather than on the first row.
    await t.press("1");
    await t.press("j");
    await t.press("j");
    await t.press("enter");
    await t.press("escape");
    expect(selectedRow(t.frame())).toContain("lane-z");
  } finally {
    await t.close();
  }
});

test("the table's cells land under their headings, not beside them", async () => {
  // Sorted by name, so the compared headings carry no sort marker of their own.
  const c = {
    ...defaults(),
    columns: ["name", "cpu", "rss", "state"],
    sort: "name",
  };
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a", cpu: 5, rss: 1024 })];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 160, height: 24 });
  try {
    await t.press("2");
    await t.press("d");
    const lines = t.frame().split("\n");
    const heading = lines.find(
      (line) => line.includes("Agent") && line.includes("Memory"),
    );
    const row = lines.find((line) => line.includes("lane-a"));
    expect(heading).toBeDefined();
    expect(row).toBeDefined();
    if (!heading || !row) throw new Error("no heading and row to compare");
    // The heading and the row read one spec, so a numeric cell ends where its
    // heading ends whatever the widths are.
    for (const [label, value] of [
      ["CPU", "5.0%"],
      ["Memory", "1.0 KiB"],
    ] as const)
      expect({
        label,
        ends: heading.indexOf(label) + label.length,
      }).toEqual({ label, ends: row.indexOf(value) + value.length });
  } finally {
    await t.close();
  }
});

/** A history that records which lane series were asked for. */
function countingHistory(c: Config, s: Snapshot) {
  const h = new History(c);
  h.add(s);
  const asked: string[] = [];
  const real = h.laneWindow.bind(h);
  h.laneWindow = async (id: string, end: number, durationMs: number) => {
    asked.push(id);
    return real(id, end, durationMs);
  };
  return { h, asked };
}

test("a long list reads the history of the rows on screen and no others", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // Forty lanes, descending by CPU, so the order on screen is known.
  s.lanes = Array.from({ length: 40 }, (_, i) =>
    laneSnapshot({ id: `lane-${i}`, name: `lane-${i}`, cpu: 100 - i }),
  );
  s.groups = [groupSnapshot()];
  const { h, asked } = countingHistory(c, s);
  // Wide enough for the trend column: the read exists to draw it.
  const t = await mount(s, c, { width: 200, height: 24 }, { history: h });
  try {
    await t.press("2");
    expect(t.frame()).toContain("Trend");
    // The claim is about reads, not about pixels: a change that widened the
    // read would draw the same rows and pass a test that only looked at them.
    // The expectation is the rows actually on screen, so no layout arithmetic
    // is copied here to drift from the screen's own.
    const onScreen = () => new Set(t.frame().match(/lane-\d+/g) ?? []);
    const shown = onScreen();
    expect(shown.size).toBeGreaterThan(0);
    expect(shown.size).toBeLessThan(s.lanes.length);
    expect([...asked].sort()).toEqual([...shown].sort());
    // No series is read twice, and a sample inside the chart's newest bucket
    // reads none: the loaded set is keyed by lane, window and that bucket, so
    // a refresh within one does not reach the store.
    expect(asked.length).toBe(new Set(asked).size);
    const before = asked.length;
    await t.update({ ...s, time: s.time + 1000 });
    await t.update({ ...s, time: s.time + 2000 });
    expect(asked.length).toBe(before);
    // Scrolling reads what scrolling revealed, and nothing above it.
    for (let i = 0; i < shown.size; i++) await t.press("j");
    const revealed = onScreen();
    expect(new Set(asked).size).toBeGreaterThan(shown.size);
    for (const id of asked)
      expect(shown.has(id) || revealed.has(id)).toBe(true);
    // Scrolling one row into view reads that row, not the whole window again:
    // the rows already read stay read.
    expect(asked.length).toBe(new Set(asked).size);
  } finally {
    await t.close();
  }
});

test("a series that arrives after the next sample still draws", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ id: "lane-0", name: "lane-0", cpu: 100 })];
  s.groups = [groupSnapshot()];
  const h = new History(c);
  h.add(s);
  const real = h.laneWindow.bind(h);
  // A store with real history answers in its own time. This one answers only
  // when the test says so, after further samples have arrived.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.laneWindow = async (id: string, end: number, durationMs: number) => {
    const samples = await real(id, end, durationMs);
    await held;
    return samples;
  };
  const t = await mount(s, c, { width: 200, height: 24 }, { history: h });
  try {
    await t.press("2");
    // Two samples land while the read is still out.
    await t.update({ ...s, time: s.time + 1000 });
    await t.update({ ...s, time: s.time + 2000 });
    // The gap glyph belongs to the trend alone: the bar draws blocks and
    // dashes, so finding it proves the series reached the row.
    expect(selectedRow(t.frame())).not.toContain("···");
    release();
    await t.update({ ...s, time: s.time + 3000 });
    expect(selectedRow(t.frame())).toContain("···");
  } finally {
    await t.close();
  }
});

test("a series that never answers does not blank the other rows", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "lane-0", name: "lane-0", cpu: 100 }),
    laneSnapshot({ id: "lane-1", name: "lane-1", cpu: 50 }),
  ];
  s.groups = [groupSnapshot()];
  const h = new History(c);
  h.add(s);
  const real = h.laneWindow.bind(h);
  h.laneWindow = async (id: string, end: number, durationMs: number) =>
    id === "lane-1"
      ? await new Promise<never>(() => {})
      : await real(id, end, durationMs);
  // Wide enough for the trend, narrow enough to keep the side pane away, so a
  // row is the only place its lane's name appears.
  const t = await mount(s, c, { width: 120, height: 24 }, { history: h });
  try {
    await t.press("2");
    await t.update({ ...s, time: s.time + 1000 });
    const row = (name: string) =>
      t
        .frame()
        .split("\n")
        .find((line) => line.includes(name)) ?? "";
    // The gap glyph belongs to the trend alone: the bar draws blocks and
    // dashes, so finding it proves the series reached the row.
    expect(row("lane-0")).toContain("···");
    expect(row("lane-1")).not.toContain("···");
  } finally {
    await t.close();
  }
});

test("a narrow list keeps the name and drops the trend", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // Names that only differ at their end, so a name cut short would leave the
  // rows indistinguishable.
  s.lanes = Array.from({ length: 6 }, (_, i) =>
    laneSnapshot({
      id: `lane-${i}`,
      name: `.hclaude claude ken-13${10 + i}`,
      cpu: 100 - i,
    }),
  );
  s.groups = [groupSnapshot()];
  const { h, asked } = countingHistory(c, s);
  const t = await mount(s, c, { width: 100, height: 24 }, { history: h });
  try {
    await t.press("2");
    const frame = t.frame();
    expect(frame).not.toContain("Trend");
    // The name arrives whole, so one row can be told from the next.
    expect(frame).toContain(".hclaude claude ken-1310");
    expect(frame).toContain(".hclaude claude ken-1315");
    // A column that is not drawn is not read for either.
    expect(asked).toEqual([]);
  } finally {
    await t.close();
  }
});

test("the wheel moves the selection by one row", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = Array.from({ length: 12 }, (_, i) =>
    laneSnapshot({ id: `lane-${i}`, name: `lane-${i}`, cpu: 100 - i }),
  );
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 160, height: 24 });
  try {
    await t.press("2");
    expect(selectedRow(t.frame())).toContain("lane-0");
    // One notch down is one row down, not a viewport jump.
    await t.wheel(10, 8, "down");
    expect(selectedRow(t.frame())).toContain("lane-1");
    await t.wheel(10, 8, "down");
    expect(selectedRow(t.frame())).toContain("lane-2");
    await t.wheel(10, 8, "up");
    expect(selectedRow(t.frame())).toContain("lane-1");
    // The selection stops at the ends rather than wrapping.
    for (let i = 0; i < 4; i++) await t.wheel(10, 8, "up");
    expect(selectedRow(t.frame())).toContain("lane-0");
  } finally {
    await t.close();
  }
});

test("a lane exiting under the selection keeps one lane under highlight, pane and Enter", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", cpu: 9, cwd: "/repo/a" }),
    laneSnapshot({ id: "b", name: "lane-b", cpu: 5, cwd: "/repo/b" }),
    laneSnapshot({ id: "z", name: "lane-z", cpu: 1, cwd: "/repo/z" }),
  ];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 180, height: 30 });
  try {
    await t.press("2");
    await t.press("j");
    await t.press("j");
    expect(selectedRow(t.frame())).toContain("lane-z");
    expect(t.frame()).toContain("/repo/z");
    // The lane exits. Every row below it moves up, and the row number the
    // reader was on now names nothing.
    await t.update({ ...s, lanes: s.lanes.slice(0, 2) });
    const frame = t.frame();
    // One lane, read three ways: the highlight in the list, the summary
    // beside it, and what Enter opens.
    expect(selectedRow(frame)).toContain("lane-b");
    expect(frame).toContain("/repo/b");
    expect(frame).not.toContain("/repo/z");
    // The list moves a second time: a lane arrives that sorts below the rest,
    // which is what makes the departed lane's row number valid again.
    const arrived = {
      ...s,
      lanes: [
        ...s.lanes.slice(0, 2),
        laneSnapshot({ id: "n", name: "lane-n", cpu: 0, cwd: "/repo/n" }),
      ],
    };
    // What the fixture has to move, read before the selection is: the lane the
    // reader was on is gone, and the newcomer holds the row number it left
    // behind. A newcomer sorting anywhere else would prove nothing.
    expect(findLanes(arrived.lanes, "", c).map((lane) => lane.name)).toEqual([
      "lane-a",
      "lane-b",
      "lane-n",
    ]);
    await t.update(arrived);
    const after = t.frame();
    expect(after).toContain("lane-n");
    // Still the fallback the exit resolved to, not the lane that took the row
    // number the reader's selection used to name.
    expect(selectedRow(after)).toContain("lane-b");
    expect(after).toContain("/repo/b");
    expect(after).not.toContain("/repo/n");
    await t.press("enter");
    const footer = t.frame().split("\n").at(-2) ?? "";
    // The detail's own footer: it opened, rather than Enter finding no lane.
    expect(footer).toContain("back");
    expect(footer).not.toContain("find");
    expect(t.frame()).toContain("lane-b");
  } finally {
    await t.close();
  }
});

test("a lane that exits while open leaves the list on a row that exists", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", cpu: 9 }),
    laneSnapshot({ id: "b", name: "lane-b", cpu: 5 }),
    laneSnapshot({ id: "z", name: "lane-z", cpu: 1 }),
  ];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 160, height: 40 });
  try {
    await t.press("2");
    await t.press("j");
    await t.press("j");
    await t.press("enter");
    expect(t.frame()).toContain("lane-z");
    // The process exits while its detail is open.
    await t.update({ ...s, lanes: s.lanes.slice(0, 2) });
    expect(t.frame()).toContain("no longer in the sample");
    await t.press("escape");
    // Back in the list, the row number the reader left on names nothing. A
    // row that exists takes the highlight, and Enter opens that row rather
    // than finding no lane at all.
    expect(selectedRow(t.frame())).toContain("lane-b");
    await t.press("enter");
    const footer = t.frame().split("\n").at(-2) ?? "";
    expect(footer).toContain("back");
    expect(footer).not.toContain("find");
    expect(t.frame()).toContain("lane-b");
  } finally {
    await t.close();
  }
});

test("an agent that leaves the sample offers only the key its screen acts on", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", cpu: 9 }),
    laneSnapshot({ id: "b", name: "lane-b", cpu: 5 }),
  ];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 140, height: 30 });
  const footer = () => t.frame().split("\n").at(-2) ?? "";
  try {
    await t.press("2");
    await t.press("enter");
    expect(footer()).toContain("copy");
    // The process exits. What stays on screen is one sentence saying so.
    await t.update({ ...s, lanes: [s.lanes[1]] });
    expect(t.frame()).toContain("no longer in the sample");
    // That screen acts on Back and nothing else, so nothing else is offered.
    const gone = footer();
    expect(gone).toContain("back");
    expect(gone).not.toContain("copy");
    expect(gone).not.toContain("select");
    expect(gone).not.toContain("open");
    // The key it does offer works, and the list's own hints come back.
    await t.press("escape");
    expect(t.frame()).not.toContain("no longer in the sample");
    expect(footer()).toContain("find");
  } finally {
    await t.close();
  }
});

test("a card that names no agent opens the list, not the agent left open", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const items = attention(s, c);
  // This card points at Agents and names no lane: several lanes wait for CPU
  // and no one row is the answer.
  const at = items.findIndex((item) => item.id === "system-cpu");
  expect(at).toBeGreaterThan(-1);
  expect(items[at].target).toBeUndefined();
  const t = await mount(s, c, { width: 160, height: 44 });
  const footer = () => t.frame().split("\n").at(-2) ?? "";
  try {
    // Open an agent and leave it by its tab rather than by going back, so the
    // detail is still what Agents would render.
    await t.press("2");
    await t.press("enter");
    expect(footer()).toContain("back");
    expect(footer()).not.toContain("find");
    await t.press("1");
    for (let i = 0; i < at; i++) await t.press("j");
    await t.press("enter");
    // The card named the list. The agent left open would render its own
    // detail here, which is a screen the card never pointed at.
    expect(footer()).toContain("find");
    expect(footer()).toContain("table");
    expect(t.frame()).toContain("Agent");
  } finally {
    await t.close();
  }
});

test("the trend re-reads when its newest bucket rolls over, and not before", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "lane-a", name: "lane-a", cpu: 9 }),
    laneSnapshot({ id: "lane-b", name: "lane-b", cpu: 1 }),
  ];
  s.groups = [groupSnapshot()];
  const { h, asked } = countingHistory(c, s);
  // The chart draws `trendWidth` buckets across the default window, so this is
  // the span the drawn shape cannot change within. Asserted here rather than
  // assumed, because the whole cadence is derived from it.
  const bucketMs = windows[0] / trendWidth;
  expect(bucketMs).toBe(25000);
  const t = await mount(s, c, { width: 200, height: 24 }, { history: h });
  try {
    await t.press("2");
    expect(t.frame()).toContain("Trend");
    const first = new Set(asked).size;
    expect(first).toBe(2);
    // Inside the bucket: samples land, and the store is not asked again. A
    // read per visible row per sample is what this cadence exists to avoid.
    await t.update({ ...s, time: s.time + 1000 });
    await t.update({ ...s, time: s.time + 2000 });
    expect(asked.length).toBe(first);
    // Past it: the newest bucket has rolled over, so the drawn shape can
    // change and every visible row is read again. Keyed on lane and window
    // alone this stayed at `first` for as long as the screen was open, and the
    // trend aged out of its own window.
    await t.update({ ...s, time: s.time + bucketMs + 1000 });
    expect(asked.length).toBe(first * 2);
    expect([...new Set(asked)].sort()).toEqual(["lane-a", "lane-b"]);
    // And the second bucket does not read a third time on its own samples.
    await t.update({ ...s, time: s.time + bucketMs + 2000 });
    expect(asked.length).toBe(first * 2);
  } finally {
    await t.close();
  }
});

test("no trend column means the store is asked for no series at all", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "lane-a", name: "lane-a", cpu: 9 }),
    laneSnapshot({ id: "lane-b", name: "lane-b", cpu: 1 }),
  ];
  s.groups = [groupSnapshot()];
  // Three states that draw something other than the trend column, each with
  // the width that would otherwise draw it. What is counted is what the store
  // was asked for: a check on the drawn frame passes while the disk is read.
  // Each case names the series it may still read. The table view and the
  // chooser may read none. An open agent reads its own, on the snapshot time,
  // which is the detail's own contract and not this list's.
  const cases: [
    string,
    (t: Awaited<ReturnType<typeof mount>>) => Promise<void>,
    string[],
  ][] = [
    ["the table view", async (t) => await t.press(c.keys.details), []],
    ["the column chooser", async (t) => await t.press(c.keys.columns), []],
    ["an open agent", async (t) => await t.press("enter"), ["lane-a"]],
  ];
  for (const [what, reach, allowed] of cases) {
    const { h, asked } = countingHistory(c, s);
    const t = await mount(s, c, { width: 200, height: 24 }, { history: h });
    try {
      await t.press("2");
      // The column is drawn here, so this is the state the case leaves.
      expect({ what, drawn: t.frame().includes("Trend") }).toEqual({
        what,
        drawn: true,
      });
      const before = asked.length;
      expect(before).toBeGreaterThan(0);
      await reach(t);
      expect({ what, drawn: t.frame().includes("Trend") }).toEqual({
        what,
        drawn: false,
      });
      // A sample lands while the column is not drawn. Nothing the list would
      // have read is read for it.
      await t.update({ ...s, time: s.time + windows[0] });
      expect({ what, read: [...new Set(asked.slice(before))] }).toEqual({
        what,
        read: allowed,
      });
    } finally {
      await t.close();
    }
  }
});

test("a read from the previous bucket cannot overwrite the newer one", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ id: "lane-a", name: "lane-a", cpu: 9 })];
  s.groups = [groupSnapshot()];
  const bucketMs = windows[0] / trendWidth;
  const at = s.time + bucketMs + 1000;
  /** A full window of samples at one reading, so the drawn shape is flat. */
  const span = (cpu: number): LaneSample[] =>
    Array.from({ length: trendWidth }, (_, i) => ({
      time: at - windows[0] + (i + 0.5) * bucketMs,
      cpu,
      rss: null,
      pressure: null,
      memoryPressure: null,
      ioPressure: null,
    }));
  const older = span(0);
  const newer = span(100);
  const quiet = trendMarks(older, at, windows[0], c.sparkline);
  const busy = trendMarks(newer, at, windows[0], c.sparkline);
  // The two series have to be told apart on the screen, or the assertion below
  // holds whichever one won.
  expect(quiet).not.toBe(busy);
  const h = new History(c);
  h.add(s);
  // Every read is held, so this test decides which one answers first.
  const held: { end: number; answer: (samples: LaneSample[]) => void }[] = [];
  h.laneWindow = (_id: string, end: number) =>
    new Promise<LaneSample[]>((resolve) => {
      held.push({ end, answer: resolve });
    });
  const t = await mount(s, c, { width: 200, height: 24 }, { history: h });
  try {
    await t.press("2");
    expect(held.length).toBe(1);
    // The bucket rolls while that read is still in flight, so a second read
    // starts for the same row under a newer question.
    await t.update({ ...s, time: at });
    // What the fixture has to interleave, asserted before either answers: two
    // reads outstanding for one row, the second asking for a later end than the
    // first. A fixture with one read, or with the older resolving first, would
    // pass without touching the case.
    expect(held.length).toBe(2);
    expect(held[1].end).toBeGreaterThan(held[0].end);
    // The newer answers first, then the older. Stored on arrival rather than
    // on what it answers, the older would land last and put its window back on
    // the screen.
    await act(async () => {
      held[1].answer(newer);
    });
    await act(async () => {
      held[0].answer(older);
    });
    // Resolving a promise draws nothing on its own; the frame is what the
    // screen would show once it has been drawn again.
    await t.ui.renderOnce();
    const frame = t.frame();
    expect(frame).toContain(busy);
    expect(frame).not.toContain(quiet);
  } finally {
    await t.close();
  }
});

test("a sample inside a bucket does not slide the drawn window", async () => {
  const c = defaults();
  const bucketMs = windows[0] / trendWidth;
  // A sample time sitting on a bucket boundary, so the whole of the next
  // bucket is available to advance into without crossing out of it.
  const base = 10 * windows[0];
  const s = emptySnapshot(base);
  s.lanes = [laneSnapshot({ id: "lane-a", name: "lane-a", cpu: 9 })];
  s.groups = [groupSnapshot()];
  expect(trendEnd(base, windows[0])).toBe(base);
  // One sample in the middle of every drawn column, so a row drawn against
  // the moment this was read for has no gap anywhere in it.
  const series: LaneSample[] = Array.from({ length: trendWidth }, (_, i) => ({
    time: base - windows[0] + (i + 0.5) * bucketMs,
    cpu: 50,
    rss: null,
    pressure: null,
    memoryPressure: null,
    ioPressure: null,
  }));
  const h = new History(c);
  h.add(s);
  // The store answers with the same samples however it is asked, so nothing
  // the row draws can come from the data changing.
  const ends: number[] = [];
  h.laneWindow = async (_id: string, end: number) => {
    ends.push(end);
    return series;
  };
  const t = await mount(s, c, { width: 200, height: 24 }, { history: h });
  try {
    await t.press("2");
    // The list row, not the summary beside it: the marker names the row that
    // carries the trend column.
    const row = () =>
      t
        .frame()
        .split("\n")
        .find((l) => l.includes("▍")) ?? "";
    const before = row();
    expect(before).not.toBe("");
    // The cell this series draws has no gap in it, and the row is drawing that
    // cell. A fixture that already gapped could not show the difference.
    const drawn = trendMarks(series, base, windows[0], c.sparkline);
    expect(drawn).not.toContain("·");
    expect(before).toContain(drawn);
    // A sample lands inside the bucket, close to its far edge, which is where
    // the drawn window would have slid past the newest sample the read holds.
    // What the store holds has not moved: same series, and no second read.
    const reads = ends.length;
    const inside = base + bucketMs - 1000;
    expect(trendEnd(inside, windows[0])).toBe(base);
    await t.update({ ...s, time: inside });
    expect(ends.length).toBe(reads);
    // So the row cannot have changed. Drawn against the sample time its last
    // column would hold no sample and draw as a gap, which in this dashboard
    // is vsys saying it could not read something.
    expect(row()).toBe(before);
    // Crossing the boundary is where the row is allowed to move, and must: it
    // is read again, against the new moment.
    const over = base + bucketMs + 1000;
    await t.update({ ...s, time: over });
    expect(ends.length).toBe(reads + 1);
    expect(ends[ends.length - 1]).toBe(trendEnd(over, windows[0]));
  } finally {
    await t.close();
  }
});
