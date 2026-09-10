import { expect, test } from "bun:test";
import { columns, defaults } from "../config/config";
import type { Level } from "../model/verdict";
import { laneSnapshot } from "../test/fixture";
import {
  columnLabels,
  findLanes,
  laneBadge,
  laneLevel,
  tableColumn,
  trendMarks,
  trendWidth,
} from "./agents";
import { cell, columnGap, headerText } from "./columns";
import { laneValue } from "./format";

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
