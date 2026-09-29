import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWardenDir } from "./warden";

test("warden resolver uses checkout before installed package", () => {
  const checkout = "/repo/warden";
  const packaged = "/usr/lib/vsys/warden";
  const seen: string[] = [];
  const found = resolveWardenDir([checkout, packaged], (path) => {
    seen.push(path);
    return (
      path === join(checkout, "install") || path === join(packaged, "install")
    );
  });
  expect(found).toBe(checkout);
  expect(seen).toEqual([join(checkout, "install")]);
});

test("warden resolver falls back to packaged install path", () => {
  const checkout = "/repo/warden";
  const packaged = "/usr/lib/vsys/warden";
  const found = resolveWardenDir(
    [checkout, packaged],
    (path) => path === join(packaged, "install"),
  );
  expect(found).toBe(packaged);
});

test("warden resolver reports every path it tried", () => {
  expect(() => resolveWardenDir(["/a", "/b"], () => false)).toThrow(
    "vsys warden installer not found; tried /a, /b",
  );
});

test("warden resolver candidate order mutant exposes reversed lookup", async () => {
  const source = readFileSync(join(import.meta.dir, "warden.ts"), "utf8");
  const old = "return [checkout, installed];";
  expect(source.split(old).length - 1).toBe(1);
  const dir = join(
    process.cwd(),
    "tmp",
    "warden-resolver-mutants",
    randomUUID(),
  );
  mkdirSync(dir, { recursive: true });
  const mutant = join(dir, "warden-mutant.ts");
  writeFileSync(mutant, source.replace(old, "return [installed, checkout];"));
  try {
    const module = await import(pathToFileURL(mutant).href);
    const candidates = module.defaultWardenCandidates(
      "/repo/src",
      process.execPath,
    );
    expect(candidates[0]).not.toBe(resolve("/repo/src", "../warden"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
