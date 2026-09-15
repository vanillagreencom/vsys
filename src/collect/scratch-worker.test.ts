import { expect, test } from "bun:test";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { WorkerScan } from "./scratch";
import { ScanCancelled } from "./scratch-scan";

const full = { sliceMs: 10, dutyPercent: 100 };

test("the scan thread answers with a complete reading and closes", async () => {
  const f = fixture();
  const path = join(f.root, "scratch");
  try {
    f.write(join(path, "session/file"), "1234");
    const c = { ...f.config, scratchDirs: [path] };
    const runner = new WorkerScan();
    try {
      const scan = await runner.run(
        c,
        5000,
        full,
        new AbortController().signal,
      );
      expect(scan.time).toBe(5000);
      expect(scan.errors).toEqual([]);
      expect(scan.scratch[0].bytes).toBe(
        lstatSync(path).size + lstatSync(join(path, "session")).size + 4,
      );
      expect(scan.sessions.map((s) => s.path)).toEqual([join(path, "session")]);
      // The thread is kept, so a second scan pays no startup.
      const again = await runner.run(
        c,
        6000,
        full,
        new AbortController().signal,
      );
      expect(again.scratch[0].bytes).toBe(scan.scratch[0].bytes);
    } finally {
      runner.close();
    }
    // A closed runner takes no further work rather than starting a thread
    // nothing will ever close.
    expect(() =>
      runner.run(c, 7000, full, new AbortController().signal),
    ).toThrow();
  } finally {
    f.cleanup();
  }
});

test("an abandoned scan is cancelled and its reading never arrives", async () => {
  const f = fixture();
  const path = join(f.root, "scratch");
  try {
    for (let i = 0; i < 200; i++) f.write(join(path, `dir-${i}/file`), "1234");
    const c = { ...f.config, scratchDirs: [path] };
    const runner = new WorkerScan();
    const controller = new AbortController();
    try {
      const scan = runner.run(
        c,
        5000,
        { sliceMs: 0, dutyPercent: 1 },
        controller.signal,
      );
      controller.abort();
      await expect(scan).rejects.toBeInstanceOf(ScanCancelled);
    } finally {
      runner.close();
    }
  } finally {
    f.cleanup();
  }
});
