import { expect, test } from "bun:test";
import { linkSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { type PaceClock, restMs, scanScratch } from "./scratch-scan";

const full = { sliceMs: 10, dutyPercent: 100 };

test("one traversal counts hard links once per root and once per session", async () => {
  const f = fixture();
  const path = join(f.root, "scratch");
  try {
    f.write(join(path, "a/file"), "1234");
    f.write(join(path, "b/empty"), "");
    linkSync(join(path, "a/file"), join(path, "b/shared"));
    symlinkSync(f.root, join(path, "loop"));
    const missing = join(f.root, "missing");
    const c = { ...f.config, scratchDirs: [path, missing] };
    const result = await scanScratch(c, Date.now(), full);
    expect(result.scratch[0].bytes).toBe(
      lstatSync(path).size +
        lstatSync(join(path, "a")).size +
        lstatSync(join(path, "b")).size +
        4,
    );
    expect(result.sessions.find((s) => s.path === join(path, "a"))?.bytes).toBe(
      lstatSync(join(path, "a")).size + 4,
    );
    expect(result.sessions.find((s) => s.path === join(path, "b"))?.bytes).toBe(
      lstatSync(join(path, "b")).size + 4,
    );
    // A root that could not be read reports no size at all, and its own
    // failure, rather than a zero beside the roots that were read.
    expect(result.scratch[1].bytes).toBeNull();
    expect(result.errors.map((e) => e.source)).toEqual([missing]);
    expect(result.scratch[0].error).toBeNull();
  } finally {
    f.cleanup();
  }
});

test("a traversal rests for what each spent slice earned", async () => {
  const f = fixture();
  const path = join(f.root, "scratch");
  try {
    for (let i = 0; i < 4; i++) f.write(join(path, `dir-${i}/file`), "1234");
    const c = { ...f.config, scratchDirs: [path] };
    // The clock advances a fixed step per reading, so every entry measures
    // the same busy time however loaded the machine running this is. A slice
    // of zero makes every entry end one.
    const step = 5;
    const busy = step * 2;
    const rows: [number, number][] = [
      [100, 0],
      [50, busy],
      [25, busy * 3],
      [20, busy * 4],
    ];
    for (const [dutyPercent, expected] of rows) {
      let reading = 0;
      const sleeps: number[] = [];
      const clock: PaceClock = {
        now: () => {
          reading += step;
          return reading;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      };
      const result = await scanScratch(
        c,
        Date.now(),
        { sliceMs: 0, dutyPercent },
        clock,
      );
      expect({ dutyPercent, error: result.scratch[0].error }).toEqual({
        dutyPercent,
        error: null,
      });
      // Every entry rests, including at a duty of 100 where what it earned is
      // nothing. A traversal that skips the rest records none at all.
      expect({ dutyPercent, rested: sleeps.length > 0 }).toEqual({
        dutyPercent,
        rested: true,
      });
      expect({ dutyPercent, waited: [...new Set(sleeps)] }).toEqual({
        dutyPercent,
        waited: [expected],
      });
    }
  } finally {
    f.cleanup();
  }
});

test("the rest a slice earns holds the traversal to its share of a thread", () => {
  // busy / (busy + rest) is the share the traversal keeps.
  const rows: [number, number, number][] = [
    [10, 100, 0],
    [10, 50, 10],
    [10, 25, 30],
    [10, 20, 40],
    [8, 1, 792],
  ];
  for (const [busy, duty, rest] of rows)
    expect({ busy, duty, rest: restMs(busy, duty) }).toEqual({
      busy,
      duty,
      rest,
    });
  expect(restMs(0, 25)).toBe(0);
});
