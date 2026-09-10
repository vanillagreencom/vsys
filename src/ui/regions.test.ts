import { expect, test } from "bun:test";
import { regionOf, regionRanges, stepRegion, stepWithin } from "./regions";

test("regions are ranges over the one flat list the screen draws", () => {
  expect(regionRanges([2, 3, 1])).toEqual([
    [0, 2],
    [2, 5],
    [5, 6],
  ]);
  // An empty region takes no rows and leaves the ones after it where they are.
  expect(regionRanges([2, 0, 1])).toEqual([
    [0, 2],
    [2, 2],
    [2, 3],
  ]);
  expect(regionRanges([])).toEqual([]);
});

test("a row belongs to one region, and a row past the end still lands", () => {
  const counts = [2, 3, 1];
  const rows: [number, number][] = [
    [0, 0],
    [1, 0],
    [2, 1],
    [4, 1],
    [5, 2],
  ];
  for (const [index, region] of rows)
    expect({ index, region: regionOf(counts, index) }).toEqual({
      index,
      region,
    });
  // A selection left behind by a list that shrank lands in the last region
  // that has rows rather than nowhere.
  expect(regionOf(counts, 99)).toBe(2);
  expect(regionOf([2, 3, 0], 99)).toBe(1);
  expect(regionOf([0, 0, 0], 0)).toBe(0);
});

test("moving between regions skips the empty ones and stops at the ends", () => {
  // The middle region has nothing in it, so one press crosses it: a reader
  // cannot stand on a row that is not there.
  expect(stepRegion([2, 0, 1], 0, 1)).toBe(2);
  expect(stepRegion([2, 0, 1], 2, -1)).toBe(0);
  // The ends hold rather than wrap, because an arrow that comes back around
  // loses the reader.
  expect(stepRegion([2, 3, 1], 2, 1)).toBe(2);
  expect(stepRegion([2, 3, 1], 0, -1)).toBe(0);
  // Nothing to move to at all.
  expect(stepRegion([2, 0, 0], 0, 1)).toBe(0);
  expect(stepRegion([], 0, 1)).toBe(0);
});

test("moving within a region never leaves it", () => {
  const counts = [2, 3, 1];
  // Down from the last row of a region stays on that row.
  expect(stepWithin(counts, 1, 1)).toBe(1);
  // Up from the first row of a region stays too.
  expect(stepWithin(counts, 2, -1)).toBe(2);
  expect(stepWithin(counts, 2, 1)).toBe(3);
  expect(stepWithin(counts, 4, -1)).toBe(3);
  // A one-row region holds still in both directions.
  expect(stepWithin(counts, 5, 1)).toBe(5);
  expect(stepWithin(counts, 5, -1)).toBe(5);
  // A screen with no rows at all moves nowhere.
  expect(stepWithin([0, 0], 0, 1)).toBe(0);
});
