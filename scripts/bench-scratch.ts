import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerScan } from "../src/collect/scratch";
import {
  type PaceClock,
  type ScratchScan,
  scanScratch,
  timerPace,
} from "../src/collect/scratch-scan";
import { defaults } from "../src/config/config";

const sessions = 200;
const filesPerSession = 30;
const root = mkdtempSync(join(tmpdir(), "vsys-scratch-bench-"));

/** The whole process, so a scan's cost includes its thread and its transfer. */
function cpuMs(): number {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
}

async function measure(dutyPercent: number): Promise<{
  dutyPercent: number;
  elapsedMs: number;
  processCpuMs: number;
  scan: ScratchScan;
}> {
  const c = { ...defaults(), scratchDirs: [root] };
  const runner = new WorkerScan();
  const budget = { sliceMs: 10, dutyPercent };
  try {
    const signal = new AbortController().signal;
    // The first scan starts the thread and warms the page cache, so its cost
    // is startup rather than traversal.
    await runner.run(c, Date.now(), budget, signal);
    const cpu = cpuMs();
    const started = performance.now();
    const scan = await runner.run(c, Date.now(), budget, signal);
    const elapsedMs = performance.now() - started;
    return { dutyPercent, elapsedMs, processCpuMs: cpuMs() - cpu, scan };
  } finally {
    runner.close();
  }
}

/**
 * The bound itself, measured where the rests can be counted. The pace runs on
 * this thread through the shipped clock, and every rest it asks for is
 * recorded before that clock takes it. A scan cannot finish in less time than
 * the rests it asked for, so a pace that asks and does not wait, and a timer
 * that ignores the duration it was given, both show up here as an elapsed
 * time far under the rest asked for.
 */
async function bound(
  dutyPercent: number,
  sliceMs: number,
): Promise<{
  dutyPercent: number;
  sliceMs: number;
  elapsedMs: number;
  restedMs: number;
  rests: number;
  scan: ScratchScan;
}> {
  const c = { ...defaults(), scratchDirs: [root] };
  const asked: number[] = [];
  const clock: PaceClock = {
    now: timerPace.now,
    sleep: async (ms) => {
      asked.push(ms);
      await timerPace.sleep(ms);
    },
  };
  const started = performance.now();
  const scan = await scanScratch(
    c,
    Date.now(),
    { sliceMs, dutyPercent },
    clock,
  );
  return {
    dutyPercent,
    sliceMs,
    elapsedMs: performance.now() - started,
    restedMs: asked.reduce((sum, ms) => sum + ms, 0),
    rests: asked.length,
    scan,
  };
}

try {
  for (let s = 0; s < sessions; s++) {
    const dir = join(root, `session-${s}`);
    mkdirSync(join(dir, "nested"), { recursive: true });
    for (let f = 0; f < filesPerSession; f++)
      writeFileSync(
        join(f % 2 ? dir : join(dir, "nested"), `f${f}`),
        "x".repeat(f),
      );
  }
  const full = await measure(100);
  const bounded = await measure(defaults().scratchDutyPercent);
  // A slice this tree cannot fit inside, on any machine that runs the check:
  // the full-thread scan just measured how long the same traversal takes, so
  // an eighth of it is a slice the traversal has to cross. The one-millisecond
  // floor keeps each rest well above what a timer can resolve, which is what
  // separates a scan that rested from one that did not.
  const held = await bound(
    defaults().scratchDutyPercent,
    Math.max(1, full.elapsedMs / 8),
  );
  // A tree this benchmark could not read makes every figure below it
  // meaningless, so one rule covers all three scans.
  const unread = [full, bounded, held].flatMap((r) => r.scan.errors);
  if (unread.length)
    throw new Error(
      `A scan of the benchmark tree reported a source error: ${JSON.stringify(unread)}`,
    );
  const totals = [full, bounded].map((r) => r.scan.scratch[0]?.bytes ?? null);
  if (totals[0] === null || totals[0] !== totals[1])
    throw new Error(
      `A bounded scan read a different total than a full one: ${JSON.stringify(totals)}`,
    );
  // A bounded scan asks for rest, and it takes the rest it asked for. Nothing
  // else in the check contract can see either. Working time sits on top of
  // the rests, so the measured elapsed time runs well clear of this floor; a
  // scan that skipped its rests lands at a fraction of it.
  if (held.restedMs <= 0)
    throw new Error(
      `A scan at ${held.dutyPercent} percent over ${held.sliceMs} ms slices asked for no rest across ${held.rests} of them`,
    );
  if (held.elapsedMs < held.restedMs * 0.95)
    throw new Error(
      `A scan asked for ${held.restedMs} ms of rest and finished in ${held.elapsedMs} ms`,
    );
  console.log(
    JSON.stringify({
      sessions,
      files: sessions * filesPerSession,
      bytes: totals[0],
      full: { elapsedMs: full.elapsedMs, processCpuMs: full.processCpuMs },
      bounded: {
        dutyPercent: bounded.dutyPercent,
        elapsedMs: bounded.elapsedMs,
        processCpuMs: bounded.processCpuMs,
      },
      // A scan that rests takes longer for the same reading. The stretch a
      // duty of d percent aims for is 100/d. The measured one runs past it,
      // because a slice ends only after the entry that spent it and a timer
      // never fires early, so the traversal keeps less than its share rather
      // than more.
      stretch: bounded.elapsedMs / full.elapsedMs,
      aimedStretch: 100 / bounded.dutyPercent,
      rested: {
        sliceMs: held.sliceMs,
        rests: held.rests,
        restedMs: held.restedMs,
        elapsedMs: held.elapsedMs,
      },
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
