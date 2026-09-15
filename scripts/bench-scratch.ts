import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerScan } from "../src/collect/scratch";
import type { ScratchScan } from "../src/collect/scratch-scan";
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
  const totals = [full, bounded].map((r) => r.scan.scratch[0]?.bytes ?? null);
  if (totals[0] === null || totals[0] !== totals[1])
    throw new Error(
      `A bounded scan read a different total than a full one: ${JSON.stringify(totals)}`,
    );
  if (full.scan.errors.length || bounded.scan.errors.length)
    throw new Error(JSON.stringify([full.scan.errors, bounded.scan.errors]));
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
      rested: bounded.elapsedMs > full.elapsedMs,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
