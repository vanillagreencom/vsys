import { expect, test } from "bun:test";
import {
  regionOf,
  regionRanges,
  stepRegion,
  stepToRegion,
  stepWithin,
} from "./regions";

test("regions are ranges over the one flat list the screen draws", () => {
  // The region sizes, and each region's half-open row range as `start-end`.
  // An empty region takes no rows and leaves the ones after it where they are.
  const rows: [number[], string][] = [
    [[2, 3, 1], "0-2 2-5 5-6"],
    [[2, 0, 1], "0-2 2-2 2-3"],
    [[], ""],
  ];
  for (const row of rows) {
    const ranges = regionRanges(row[0]).map(([from, to]) => `${from}-${to}`);
    expect([row[0], ranges.join(" ")]).toEqual(row);
  }
});

test("a row belongs to one region, and a row outside them to none", () => {
  // The region sizes, a row, and the region it belongs to, or -1 for a row no
  // region holds: past the end, before the start, or with every region empty.
  const rows: [number[], number, number][] = [
    [[2, 3, 1], 0, 0],
    [[2, 3, 1], 1, 0],
    [[2, 3, 1], 2, 1],
    [[2, 3, 1], 4, 1],
    [[2, 3, 1], 5, 2],
    [[2, 3, 1], 99, -1],
    [[2, 3, 0], 99, -1],
    [[2, 3, 1], -1, -1],
    [[0, 0, 0], 0, -1],
  ];
  for (const row of rows) {
    const [counts, index] = row;
    expect([counts, index, regionOf(counts, index)]).toEqual(row);
  }
});

test("moving between regions skips the empty ones and stops at the ends", () => {
  // The region sizes, the row focus leaves, the way it moves, the region it
  // lands in, and the row it selects there. An empty region is crossed in one
  // press, because a reader cannot stand on a row that is not there; at either
  // end the reader stays on the row they are on; from a row no region holds,
  // forward reaches the first row there is.
  const rows: [number[], number, -1 | 1, number, number][] = [
    [[2, 0, 1], 1, 1, 2, 2],
    [[2, 0, 1], 2, -1, 0, 0],
    [[2, 3, 2], 6, 1, 2, 6],
    [[2, 3, 1], 1, -1, 0, 1],
    [[2, 0, 0], 1, 1, 0, 1],
    [[2, 3, 1], 99, 1, 0, 0],
    [[2, 3, 1], 99, -1, -1, 99],
    [[0, 0, 0], 0, 1, -1, 0],
    [[], 0, 1, -1, 0],
  ];
  for (const row of rows) {
    const [counts, index, way] = row;
    const region = stepRegion(counts, regionOf(counts, index), way);
    const to = stepToRegion(counts, index, way);
    expect([counts, index, way, region, to]).toEqual(row);
  }
});

test("moving within a region never leaves it", () => {
  // The region sizes, the row, the way it moves, and where it lands. Each
  // region's first and last rows hold at its edges, a one-row region holds
  // both ways, and a screen with no rows moves nowhere.
  const rows: [number[], number, -1 | 1, number][] = [
    [[2, 3, 1], 1, 1, 1],
    [[2, 3, 1], 2, -1, 2],
    [[2, 3, 1], 2, 1, 3],
    [[2, 3, 1], 4, -1, 3],
    [[2, 3, 1], 5, 1, 5],
    [[2, 3, 1], 5, -1, 5],
    [[2, 3, 1], 99, 1, 99],
    [[0, 0], 0, 1, 0],
  ];
  for (const row of rows) {
    const [counts, index, way] = row;
    expect([counts, index, way, stepWithin(counts, index, way)]).toEqual(row);
  }
});
