import { expect, test } from "bun:test";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { WorkerScan } from "./scratch";
import type { ScanRoot } from "./scratch-scan";

const full = { sliceMs: 10, dutyPercent: 100 };
const loose = () => new AbortController().signal;

test("the scan thread answers with a complete reading and closes", async () => {
  const f = fixture();
  const path = join(f.root, "scratch");
  try {
    f.write(join(path, "session/file"), "1234");
    const roots: ScanRoot[] = [{ path, origin: "configured" }];
    const runner = new WorkerScan();
    try {
      const { scan } = await runner.run(roots, 5000, full, loose());
      expect(scan.time).toBe(5000);
      expect(scan.errors).toEqual([]);
      expect(scan.scratch[0]?.bytes).toBe(
        lstatSync(path).size + lstatSync(join(path, "session")).size + 4,
      );
      expect(scan.sessions.map((s) => s.path)).toEqual([join(path, "session")]);
    } finally {
      runner.close();
    }
    expect(() => runner.run(roots, 7000, full, loose())).toThrow(
      "Scratch scan thread has closed",
    );
  } finally {
    f.cleanup();
  }
});

test("the scan thread rests under the duty it is sent and not at 100", async () => {
  const f = fixture();
  const path = join(f.root, "scratch");
  try {
    for (let i = 0; i < 4; i++) f.write(join(path, `dir-${i}/file`), "1234");
    const roots: ScanRoot[] = [{ path, origin: "configured" }];
    const runner = new WorkerScan();
    try {
      // A slice of zero ends at every entry, so every entry under 100 rests
      // for what it earned. No wait is timed, only whether one was taken.
      const rows: [number, boolean][] = [
        [50, true],
        [100, false],
      ];
      for (const [dutyPercent, rested] of rows) {
        const { scan, rests } = await runner.run(
          roots,
          5000,
          { sliceMs: 0, dutyPercent },
          loose(),
        );
        expect({ dutyPercent, errors: scan.errors, rested: rests > 0 }).toEqual(
          { dutyPercent, errors: [], rested },
        );
      }
    } finally {
      runner.close();
    }
  } finally {
    f.cleanup();
  }
});

test("quitting while the scan thread is blocked in the kernel exits rather than waiting on the read", async () => {
  const f = fixture();
  try {
    // A pipe nobody writes is a read the kernel holds, as a stalled mount
    // holds a traversal, and ending the thread cannot interrupt it.
    const pipe = join(f.root, "stalled");
    const made = Bun.spawnSync(["mkfifo", pipe], {
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    expect(made.exitCode, made.stderr.toString()).toBe(0);
    const blocked = join(f.root, "blocked.ts");
    f.write(
      blocked,
      `import { readFileSync } from "node:fs";\nreadFileSync(${JSON.stringify(pipe)});\n`,
    );
    // The program's quit path: a scan in flight on a thread started as the
    // program starts its own, then the runner closed.
    const quit = join(f.root, "quit.ts");
    f.write(
      quit,
      `import { constants, openSync } from "node:fs";
import { WorkerScan } from ${JSON.stringify(join(import.meta.dir, "scratch"))};
const runner = new WorkerScan(() => new Worker(${JSON.stringify(blocked)}) as Bun.Worker);
void runner
  .run([{ path: "/scratch", origin: "configured" }], 0, { sliceMs: 10, dutyPercent: 100 }, new AbortController().signal)
  .catch(() => {});
// A writer opens a pipe without waiting only once a reader holds it, so this
// returns once the thread is inside the read. Each pause waits on its start.
for (;;) {
  try {
    openSync(${JSON.stringify(pipe)}, constants.O_WRONLY | constants.O_NONBLOCK);
    break;
  } catch {
    await Bun.sleep(5);
  }
}
runner.close();
`,
    );
    // Teardown that races the thread's start passes by luck once, so the
    // quit is repeated. A program that waits on the read is killed at the
    // bound and reports the signal instead of an exit code.
    for (let run = 0; run < 3; run++) {
      const child = Bun.spawn([process.execPath, quit], {
        env: { HOME: f.root },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 4000,
      });
      const [stderr, code] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ run, code, signal: child.signalCode, stderr }).toEqual({
        run,
        code: 0,
        signal: null,
        stderr: "",
      });
    }
  } finally {
    f.cleanup();
  }
}, 20000);
