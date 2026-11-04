import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each([
  { args: ["test"] },
  { args: ["test", "src/"] },
  { args: ["run", "test"] },
])("%j discovers only the repository source tests", ({ args }) => {
  const repository = join(import.meta.dir, "../..");
  const root = mkdtempSync(join(tmpdir(), "vsys-test-discovery-"));
  try {
    for (const name of ["bunfig.toml", "package.json"]) {
      copyFileSync(join(repository, name), join(root, name));
    }
    mkdirSync(join(root, "src/test"), { recursive: true });
    copyFileSync(
      join(repository, "src/test/warnings.ts"),
      join(root, "src/test/warnings.ts"),
    );
    // Before-image captures produce this nested src path in real worktrees.
    const source = join(root, "src/discovery.test.ts");
    const capture = join(root, "tmp/ui-shots/base/src/discovery.test.ts");
    mkdirSync(join(root, "tmp/ui-shots/base/src"), { recursive: true });
    const fixture = `
import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
appendFileSync("discovered", import.meta.path + "\\n");
test("the discovered source retains the warning preload", () => {
  expect(globalThis[Symbol.for("vsys.warning-gate")]).toBe(true);
});
`;
    writeFileSync(source, fixture);
    writeFileSync(capture, fixture);
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(
      readFileSync(join(root, "discovered"), "utf8").trim().split("\n"),
    ).toEqual([source]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
