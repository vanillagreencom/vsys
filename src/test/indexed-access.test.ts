import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repository = join(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "vsys-indexed-access-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The binding is annotated as possibly undefined. Without
// `noUncheckedIndexedAccess` the compiler reads the initializer instead and
// narrows it to `string`, so the missing guard compiles and throws at runtime.
const unguarded = `export function size(items: string[], at: number): number {
  const item: string | undefined = items[at];
  return item.length;
}
`;
const guarded = `export function size(items: string[], at: number): number | null {
  const item: string | undefined = items[at];
  return item === undefined ? null : item.length;
}
`;

/** Type-checks `source` alone under the repository's own compiler options. */
async function check(name: string, source: string) {
  writeFileSync(join(root, `${name}.ts`), source);
  // The probe extends the repository's settings rather than restating them,
  // so removing the flag from tsconfig.json is what turns this test red. It
  // drops the ambient Bun types and the repository's files, which the probe
  // does not use and which would make each run check the whole tree.
  writeFileSync(
    join(root, `${name}.json`),
    JSON.stringify({
      extends: join(repository, "tsconfig.json"),
      compilerOptions: { types: [] },
      include: [],
      files: [`${name}.ts`],
    }),
  );
  const child = Bun.spawn(
    [
      join(repository, "node_modules/.bin/tsc"),
      "-p",
      join(root, `${name}.json`),
    ],
    {
      cwd: repository,
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
  return { code, output: stdout + stderr };
}

test("the type check reports an indexed read used without a guard", async () => {
  const { code, output } = await check("unguarded", unguarded);
  // tsc's machine-read location and diagnostic code, not its sentence.
  expect(output).toMatch(/unguarded\.ts\(3,10\): error TS18048:/);
  expect(code).not.toBe(0);
});

test("the type check accepts the same read once it is guarded", async () => {
  expect(await check("guarded", guarded)).toEqual({ code: 0, output: "" });
});
