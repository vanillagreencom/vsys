import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultWardenCandidates, resolveWardenDir } from "./warden";

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
    expect.objectContaining({
      refusal: { kind: "installer-not-found", tried: ["/a", "/b"] },
    }),
  );
});

test("warden candidates put the checkout before the installed and archive copies", () => {
  const execDir = dirname(realpathSync(process.execPath));
  expect(defaultWardenCandidates("/repo/src", process.execPath)).toEqual([
    resolve("/repo/src", "../warden"),
    resolve(execDir, "../lib/vsys/warden"),
    resolve(execDir, "lib/vsys/warden"),
  ]);
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
