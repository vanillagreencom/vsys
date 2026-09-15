import { expect, test } from "bun:test";
import { linkSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { restMs, ScanCancelled, scanScratch } from "./scratch-scan";

const full = { sliceMs: 10, dutyPercent: 100 };
const never = () => false;

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
    const result = await scanScratch(c, Date.now(), full, never);
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

test("a stopped traversal reports no reading and no source error", async () => {
  const f = fixture();
  const path = join(f.root, "scratch");
  try {
    for (let i = 0; i < 40; i++) f.write(join(path, `dir-${i}/file`), "1234");
    const c = { ...f.config, scratchDirs: [path] };
    let stop = false;
    const scan = scanScratch(
      c,
      Date.now(),
      { sliceMs: 0, dutyPercent: 50 },
      () => stop,
    );
    stop = true;
    await expect(scan).rejects.toBeInstanceOf(ScanCancelled);
  } finally {
    f.cleanup();
  }
});

test("a paced traversal returns its thread between entries", async () => {
  const f = fixture();
  const path = join(f.root, "scratch");
  try {
    for (let i = 0; i < 40; i++) f.write(join(path, `dir-${i}/file`), "1234");
    const c = { ...f.config, scratchDirs: [path] };
    // Entry reads are synchronous, so nothing but the pace hands the thread
    // back. A traversal that never rests leaves this timer unfired until it
    // has walked the whole tree.
    let turns = 0;
    const ticking = setInterval(() => {
      turns++;
    }, 1);
    try {
      const result = await scanScratch(
        c,
        Date.now(),
        { sliceMs: 0, dutyPercent: 50 },
        never,
      );
      expect(result.scratch[0].error).toBeNull();
    } finally {
      clearInterval(ticking);
    }
    expect(turns).toBeGreaterThan(0);
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
