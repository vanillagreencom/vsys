import { expect, test } from "bun:test";
import { join } from "node:path";

test("a render warning fails the test that wrote it, and only that test", async () => {
  // Set by `src/test/warnings.ts`. Bun reads `bunfig.toml` from the directory
  // it starts in, so a run started anywhere but the repository root runs every
  // suite with no gate.
  expect(
    (globalThis as Record<symbol, unknown>)[Symbol.for("vsys.warning-gate")],
    "the warning gate did not load: run bun test from the repository root, where bunfig.toml preloads src/test/warnings.ts",
  ).toBe(true);
  // The child runs from the repository root, so it reads the preload from
  // `bunfig.toml` as `bun test src/` does; a path in a flag would prove the
  // module and leave the wiring unproven. Bun leaves passing tests out of its
  // report under an agent's environment, so the child gets PATH alone.
  const child = Bun.spawn(
    [process.execPath, "test", "./src/test/duplicate-key.fixture.tsx"],
    {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = stdout + stderr;
  expect(code).toBe(1);
  expect(output).toContain("(fail) two rows sharing a key");
  expect(output).toContain("(pass) rows with their own keys");
  expect(output).toMatch(
    /console-warning: .*\nconsole\.error: Encountered two children with the same key, `\/dev\/x`/,
  );
  expect(output).toContain("(fail) a warning written through console.warn");
  expect(output).toMatch(
    /console-warning: .*\nconsole\.warn: a stand-in for a React warning/,
  );
  expect(output).toMatch(
    /console-warning: written after the last test ended\nconsole\.error: a warning from the file's afterAll/,
  );
});
