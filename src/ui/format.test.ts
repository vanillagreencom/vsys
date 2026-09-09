import { expect, test } from "bun:test";
import { columns, defaults } from "../config/config";
import { exportSnapshot, safe } from "../model/export";
import { emptySnapshot, laneSnapshot } from "../test/fixture";
import { bytes, percent, sortLanes, sparkline, timeBuckets } from "./format";

test("every Fleet column sorts both ways independently of lane identity", () => {
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
  expect(exportSnapshot(s, "markdown")).toContain("# vsys-view snapshot");
  expect(safe("a\u001b[2J\nb")).toBe("a [2J b");
});
