import { expect, test } from "bun:test";
import type { Point } from "../store/point";
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
