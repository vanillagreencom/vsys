import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWardenDir } from "./warden";

test("warden resolver uses checkout before installed package", () => {
  const checkout = "/repo/warden";
  const packaged = "/usr/lib/vsys/warden";
  const archive = "/archive/lib/vsys/warden";
  const seen: string[] = [];
  const found = resolveWardenDir([checkout, packaged, archive], (path) => {
    seen.push(path);
    return (
      path === join(checkout, "install") ||
      path === join(packaged, "install") ||
      path === join(archive, "install")
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

test("warden resolver tries extracted archive beside executable", () => {
  const checkout = "/repo/warden";
  const packaged = "/prefix/lib/vsys/warden";
  const archive = "/extract/lib/vsys/warden";
  const seen: string[] = [];
  const found = resolveWardenDir([checkout, packaged, archive], (path) => {
    seen.push(path);
    return path === join(archive, "install");
  });
  expect(found).toBe(archive);
  expect(seen).toEqual([
    join(checkout, "install"),
    join(packaged, "install"),
    join(archive, "install"),
  ]);
});

test("warden resolver reports every path it tried", () => {
  expect(() => resolveWardenDir(["/a", "/b"], () => false)).toThrow(
    "vsys warden installer not found; tried /a, /b",
  );
});

test("warden resolver candidate order mutant exposes reversed lookup", async () => {
  const source = readFileSync(join(import.meta.dir, "warden.ts"), "utf8");
  const old = "return [checkout, installed, archive];";
  expect(source.split(old).length - 1).toBe(1);
  const dir = join(
    process.cwd(),
    "tmp",
    "warden-resolver-mutants",
    randomUUID(),
  );
  mkdirSync(dir, { recursive: true });
  const mutant = join(dir, "warden-mutant.ts");
  writeFileSync(
    mutant,
    source.replace(old, "return [installed, checkout, archive];"),
  );
  try {
    const module = await import(pathToFileURL(mutant).href);
    const candidates = module.defaultWardenCandidates(
      "/repo/src",
      process.execPath,
    );
    expect(candidates[0]).not.toBe(resolve("/repo/src", "../warden"));
    expect(candidates).toContain(
      resolve(dirname(process.execPath), "lib/vsys/warden"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warden dispatch forwards args and exits with installer status", async () => {
  const dir = join(process.cwd(), "tmp", "warden-dispatch", randomUUID());
  mkdirSync(dir, { recursive: true });
  const install = join(dir, "install");
  writeFileSync(
    install,
    '#!/bin/sh\nprintf "count=%s\\n" "$#"\nfor arg do printf "<%s>\\n" "$arg"; done\nexit 7\n',
  );
  chmodSync(install, 0o755);
  try {
    const code = `import { dispatchWarden } from "./src/warden"; await dispatchWarden(["alpha", "two words"], ${JSON.stringify(dir)});`;
    const child = Bun.spawn([process.execPath, "-e", code], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ stdout, stderr, status }).toEqual({
      stdout: "count=2\n<alpha>\n<two words>\n",
      stderr: "",
      status: 7,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
