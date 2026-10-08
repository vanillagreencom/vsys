// Finding 1: desktop notifications run on the sampling path, one at a time,
// with no timeout. Run from the repository root:
//   bun test ./review/tests/notify-stall.test.ts
// Real elapsed time is the claim here: the session's sample cadence. The test
// asserts the cadence the settings ask for and fails on main, where a
// notify-send that takes one second per call holds every sample behind it.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const driver = join(import.meta.dir, "notify-stall.driver.ts");

async function drive(stubBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "vsys-review-notify-"));
  try {
    const stub = join(dir, "notify-send");
    writeFileSync(stub, stubBody);
    chmodSync(stub, 0o755);
    const child = Bun.spawn([process.execPath, driver, dir], {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
      stdout: "pipe",
      stderr: "inherit",
    });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    // The stub calls the driver started may still be sleeping.
    await Bun.sleep(1500);
    return JSON.parse(out) as { frames: number; errorSources: string[] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("control: a notify-send that answers at once keeps the cadence", async () => {
  const run = await drive("#!/bin/sh\nexit 0\n");
  expect(run.errorSources).toEqual([]);
  expect(run.frames).toBeGreaterThanOrEqual(20);
}, 20000);

test("a slow notify-send does not stop the dashboard sampling", async () => {
  // A notification daemon that answers in one second, as a busy or wedged
  // one does before D-Bus gives up (its default call timeout is 25 s).
  const run = await drive("#!/bin/sh\nsleep 1\nexit 0\n");
  console.log(`frames drawn in 4 s at refreshMs 100: ${run.frames}`);
  expect(run.errorSources).toEqual([]);
  // Four seconds at refreshMs 100 hold about forty samples.
  expect(run.frames).toBeGreaterThanOrEqual(20);
}, 20000);
