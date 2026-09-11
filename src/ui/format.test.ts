import { expect, test } from "bun:test";
import { columns, defaults } from "../config/config";
import { exportSnapshot, safe } from "../model/export";
import { emptySnapshot, laneSnapshot } from "../test/fixture";
import {
  age,
  amount,
  blockedText,
  bytes,
  capText,
  collectedSpan,
  laneValue,
  percent,
  rate,
  sortLanes,
  spanLabel,
  sparkline,
  timeBuckets,
} from "./format";

test("every Agents column sorts both ways independently of lane identity", () => {
  for (const column of columns) {
    const numeric =
      typeof laneSnapshot()[column] === "number" ||
      ["cpu", "pressure", "swap"].includes(column);
    const low = laneSnapshot({ id: "z", [column]: numeric ? 1 : "a" });
    const high = laneSnapshot({ id: "a", [column]: numeric ? 9 : "z" });
    expect(sortLanes([high, low], column, false).map((l) => l.id)).toEqual([
      "z",
      "a",
    ]);
    expect(sortLanes([low, high], column, true).map((l) => l.id)).toEqual([
      "a",
      "z",
    ]);
  }
});

test("units distinguish missing counters from zero", () => {
  expect(bytes(1024, defaults())).toBe("1.0 KiB");
  expect(bytes(1000, { ...defaults(), units: "decimal" })).toBe("1.0 kB");
  expect(bytes(null, defaults())).toBe("?");
  expect(percent(0)).toBe("0.0%");
  expect(percent(null)).toBe("?");
});
test("unreadable lane quantities say so instead of showing a question mark", () => {
  const c = defaults();
  expect(amount(null, c)).toBe("not available");
  expect(rate(2097152, c)).toBe("2.0 MiB/s");
  expect(rate(null, c)).toBe("not available");
  expect(laneValue(laneSnapshot({ cache: null }), "cache", c)).toBe(
    "not available",
  );
  expect(laneValue(laneSnapshot({ writeRate: 1024 }), "writeRate", c)).toBe(
    "1.0 KiB/s",
  );
  expect(laneValue(laneSnapshot({ account: null }), "account", c)).toBe(
    "not available",
  );
});
test("an unread memory cap says so instead of claiming the lane is unlimited", () => {
  const c = defaults();
  expect(capText(laneSnapshot({ memoryMax: 2147483648 }), c)).toBe("2.0 GiB");
  expect(capText(laneSnapshot({ memoryMax: null }), c)).toBe("unlimited");
  expect(
    capText(laneSnapshot({ memoryMax: null, memoryMaxKnown: false }), c),
  ).toBe("not available");
});
test("a blocked lane says how many tasks wait and on which resource", () => {
  const blocked = { state: "blocked", blocked: 2 } as const;
  expect(blockedText(laneSnapshot({ ...blocked, blockedOn: "io" }))).toBe(
    "blocked: 2 tasks waiting on storage",
  );
  expect(
    blockedText(laneSnapshot({ ...blocked, blocked: 1, blockedOn: "memory" })),
  ).toBe("blocked: 1 task waiting on memory");
  expect(blockedText(laneSnapshot({ ...blocked, blockedOn: null }))).toBe(
    "blocked: 2 tasks waiting on not available",
  );
  expect(blockedText(laneSnapshot())).toBe("sleeping");
});
test("chart buckets retain spikes and unknown samples", () => {
  expect(sparkline([0, 100, 0, 0], 2, "block")).toBe("█▁");
  expect(sparkline([null, 0], 2, "block")).toBe("·▁");
});
test("time buckets preserve gaps and align alert positions with charts", () => {
  const points = [
    { time: 0, value: 0, alert: false },
    { time: 100, value: 100, alert: true },
    { time: 1000, value: 20, alert: false },
  ];
  const buckets = timeBuckets(points, 0, 1000, 5);
  expect(buckets.map((b) => b.map((p) => p.time))).toEqual([
    [0, 100],
    [],
    [],
    [],
    [1000],
  ]);
  expect(
    buckets.map((b) => (b.some((p) => p.alert) ? "!" : "·")).join(""),
  ).toBe("!····");
  expect(
    sparkline(
      buckets.map((b) =>
        b.length ? Math.max(...b.map((p) => p.value)) : null,
      ),
      5,
      "block",
    ),
  ).toBe("█···▂");
  expect(() => timeBuckets(points, 0, 1000, 0)).toThrow();
});
test("exports preserve evidence and neutralize terminal control characters", () => {
  const s = emptySnapshot();
  expect(JSON.parse(exportSnapshot(s, "json"))).toEqual(s);
  expect(exportSnapshot(s, "markdown")).toContain("# vsys snapshot");
  expect(safe("a\u001b[2J\nb")).toBe("a [2J b");
});

test("a span reads in the largest unit that still says something", () => {
  const rows: [number, string][] = [
    [0, "0s"],
    [59, "59s"],
    [60, "1m"],
    [3599, "59m"],
    [3600, "1.0h"],
    // Storage prints the age of a scratch directory, and 54.9h is arithmetic
    // the reader has to do.
    [172799, "48.0h"],
    [172800, "2.0d"],
    [197640, "2.3d"],
    [864000, "10.0d"],
  ];
  for (const [seconds, expected] of rows)
    expect({ seconds, shown: age(seconds) }).toEqual({
      seconds,
      shown: expected,
    });
});

test("a chart names the span it holds, not the span it was asked for", () => {
  const window = 300000;
  const full = Array.from({ length: 10 }, (_, i) => i);
  expect(collectedSpan(full, window)).toEqual({ ms: window, partial: false });
  expect(spanLabel(full, window)).toBe("last 5m");
  // vsys started a moment ago: nine of ten columns hold nothing, and naming
  // the requested window there says nothing about what is on screen.
  const fresh = [...Array(9).fill(null), 1];
  expect(collectedSpan(fresh, window)).toEqual({ ms: 30000, partial: true });
  expect(spanLabel(fresh, window)).toBe("30s collected of 5m");
  // A gap inside a filled window is a collection gap, not a short history.
  const gapped = [1, null, null, 4];
  expect(collectedSpan(gapped, window)).toEqual({
    ms: window,
    partial: false,
  });
  // Nothing collected at all is nothing collected. `findIndex` answers -1
  // there, and the branch that read it as a full window told a reader who had
  // just started vsys that five minutes of history were on screen.
  expect(collectedSpan([null, null], window)).toEqual({ ms: 0, partial: true });
  expect(spanLabel([null, null], window)).toBe("0s collected of 5m");
  // An empty chart of any length says the same, and one sample in the first
  // column is still the whole window.
  const none = Array.from({ length: 60 }, () => null);
  expect(collectedSpan(none, window)).toEqual({ ms: 0, partial: true });
  expect(collectedSpan([], window)).toEqual({ ms: 0, partial: true });
  expect(spanLabel([1, ...Array(59).fill(null)], window)).toBe("last 5m");
});
