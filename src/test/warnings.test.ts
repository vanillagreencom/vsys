import { expect, test } from "bun:test";

test("a render warning fails the test that wrote it, and only that test", async () => {
  // The child runs from the repository root, so it reads the preload from
  // `bunfig.toml` as `bun test src/` does; a path in a flag would prove the
  // module and leave the wiring unproven. Bun leaves passing tests out of its
  // report under an agent's environment, so the child gets PATH alone.
  const child = Bun.spawn(
    [process.execPath, "test", "./src/test/duplicate-key.fixture.tsx"],
    {
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
});
