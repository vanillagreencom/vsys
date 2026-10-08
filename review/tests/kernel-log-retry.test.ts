// Finding 3: a kernel-log search that outlasts kernelLogTimeoutMs is killed,
// keeps no cursor, and the next sample runs the same search from the start of
// the journal again, waiting the full timeout each time. Run from the
// repository root:
//   bun test ./review/tests/kernel-log-retry.test.ts
// A stand-in journalctl records the arguments it was started with and then
// takes longer than the timeout, as a search over a large multi-boot journal
// on a cold disk does. The test asserts that the second read makes progress
// (starts after a cursor, or is not attempted at the same cost) and fails on
// main.
import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KernelLog,
  kernelLogArgv,
  kernelLogTimeoutMs,
  readKernelLog,
} from "../../src/collect/kernel-log";

test("a timed-out first search is not repeated from the start on every sample", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vsys-review-journal-"));
  try {
    const calls = join(dir, "calls");
    const stub = join(dir, "journalctl");
    // One matching entry is written at once, as journalctl streams them; the
    // cursor line comes only at the end, which the stand-in never reaches.
    writeFileSync(
      stub,
      `#!/bin/sh\necho "$*" >> '${calls}'\n` +
        `echo '{"MESSAGE":"BTRFS info (device nvme0n1p2): first mount of filesystem 0123abcd-0000-0000-0000-000000000000","_BOOT_ID":"b","__REALTIME_TIMESTAMP":"1"}'\n` +
        "exec sleep 30\n",
    );
    chmodSync(stub, 0o755);
    const log = new KernelLog((cursor) =>
      readKernelLog(cursor, [stub, ...kernelLogArgv(cursor).slice(1)]),
    );
    const durations: number[] = [];
    for (let sample = 0; sample < 2; sample++) {
      const started = performance.now();
      await expect(log.read(new Map(), "b")).rejects.toThrow();
      durations.push(performance.now() - started);
    }
    const argv = readFileSync(calls, "utf8").trim().split("\n");
    console.log(
      `two samples waited ${durations.map((d) => Math.round(d)).join(" ms, ")} ms; ` +
        `searches: ${argv.map((a) => (a.includes("--after-cursor") ? "after cursor" : "whole journal")).join(", ")}`,
    );
    // Each sample waited the whole timeout.
    for (const d of durations)
      expect(d).toBeGreaterThanOrEqual(kernelLogTimeoutMs);
    // The second search should not start over from the beginning.
    expect(argv[1]).toContain("--after-cursor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 40000);
