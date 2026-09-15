import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { type ScanRunner, ScratchCollector } from "./scratch";
import type { ScanBudget, ScratchScan } from "./scratch-scan";

const empty = (time: number): ScratchScan => ({
  scratch: [],
  sessions: [],
  time,
  errors: [],
});

/** A scan the test finishes by hand, so nothing reads a real directory. */
function held() {
  const budgets: ScanBudget[] = [];
  const signals: AbortSignal[] = [];
  const waiting: PromiseWithResolvers<ScratchScan>[] = [];
  let closed = 0;
  const runner: ScanRunner = {
    run(_c, _time, budget, signal) {
      budgets.push(budget);
      signals.push(signal);
      const next = Promise.withResolvers<ScratchScan>();
      waiting.push(next);
      return next.promise;
    },
    close() {
      closed++;
    },
  };
  return {
    runner,
    budgets,
    signals,
    waiting,
    get closed() {
      return closed;
    },
  };
}

test("live reads reuse a single pending scan and keep its measurement time", async () => {
  const c = { ...defaults(), scratchDirs: ["/scratch"] };
  const scans = held();
  const collector = new ScratchCollector(scans.runner);
  try {
    expect((await collector.collect(c, 1000, false)).time).toBeNull();
    expect((await collector.collect(c, 2000, false)).time).toBeNull();
    expect(scans.waiting.length).toBe(1);
    expect(collector.pending).toBe(true);
    scans.waiting[0].resolve(empty(1000));
    expect((await collector.collect(c, 2000, true)).time).toBe(1000);
    expect(collector.pending).toBe(false);
    expect((await collector.collect(c, 2001, false)).time).toBe(1000);
    expect(scans.waiting.length).toBe(1);
    collector.close();
    expect(scans.signals[0].aborted).toBe(true);
    expect(scans.closed).toBe(1);
    await expect(collector.collect(c, 3000, false)).rejects.toThrow();
  } finally {
    collector.close();
  }
});

test("a background scan holds the configured share; a waiting caller waits on none", async () => {
  const c = {
    ...defaults(),
    scratchDirs: ["/scratch"],
    scratchDutyPercent: 20,
  };
  const scans = held();
  const collector = new ScratchCollector(scans.runner);
  try {
    await collector.collect(c, 1000, false);
    scans.waiting[0].resolve(empty(1000));
    await scans.waiting[0].promise;
    expect(scans.budgets[0].dutyPercent).toBe(20);
  } finally {
    collector.close();
  }
  // A script waiting on the reading has no screen to protect, so its scan
  // never rests: throttling it would only make the caller wait longer.
  const scripted: ScanBudget[] = [];
  const once = new ScratchCollector({
    run: (_c, time, budget) => {
      scripted.push(budget);
      return Promise.resolve(empty(time));
    },
    close: () => {},
  });
  try {
    await once.collect(c, 1000, true);
    expect(scripted[0].dutyPercent).toBe(100);
  } finally {
    once.close();
  }
});

test("a scan that outlasts the interval waits the interval out from its completion", async () => {
  const c = {
    ...defaults(),
    scratchDirs: ["/scratch"],
    scratchRefreshMs: 30000,
  };
  const scans = held();
  let now = 0;
  const collector = new ScratchCollector(scans.runner, () => now);
  try {
    await collector.collect(c, 1000, false);
    expect(scans.waiting.length).toBe(1);
    // The traversal runs far longer than the rescan interval.
    now = 100000;
    scans.waiting[0].resolve(empty(1000));
    expect((await collector.collect(c, 2000, true)).time).toBe(1000);
    expect(scans.waiting.length).toBe(1);
    // Measured from the attempt, the completed scan would be eligible again
    // at once and the traversal would never pause.
    now = 129999;
    await collector.collect(c, 3000, false);
    expect(scans.waiting.length).toBe(1);
    now = 130000;
    await collector.collect(c, 4000, false);
    expect(scans.waiting.length).toBe(2);
  } finally {
    collector.close();
  }
});

test("a failed scan keeps the last complete reading and names what failed", async () => {
  const c = { ...defaults(), scratchDirs: ["/scratch"] };
  const scans = held();
  let now = 0;
  const collector = new ScratchCollector(scans.runner, () => now);
  try {
    await collector.collect(c, 1000, false);
    scans.waiting[0].resolve({
      scratch: [
        { path: "/scratch", bytes: 4096, age: 0, modifiedAt: 1, error: null },
      ],
      sessions: [],
      time: 1000,
      errors: [],
    });
    await collector.collect(c, 1000, true);
    now = 60000;
    await collector.collect(c, 2000, false);
    scans.waiting[1].reject(new Error("Scratch scan thread exited"));
    const after = await collector.collect(c, 2000, true);
    expect(after.time).toBe(1000);
    expect(after.scratch[0].bytes).toBe(4096);
    expect(after.errors).toEqual([
      { source: "scratch scan", message: "Scratch scan thread exited" },
    ]);
  } finally {
    collector.close();
  }
});

test("empty scratch settings need no background work", async () => {
  const scans = held();
  const collector = new ScratchCollector(scans.runner);
  try {
    const value = await collector.collect(
      { ...defaults(), scratchDirs: [] },
      1000,
      false,
    );
    expect(value.errors).toEqual([]);
    expect(scans.waiting.length).toBe(0);
    expect(collector.pending).toBe(false);
  } finally {
    collector.close();
  }
});
