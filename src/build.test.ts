import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBinary } from "../scripts/build";

// React's development build draws a retained day in more than half the
// default refresh interval; the production build stays under it. The binary
// embeds React's modules by path, so the build it chose shows in its bytes.
test("the compiled binary embeds production React", async () => {
  const root = mkdtempSync(join(tmpdir(), "vsys-build-"));
  try {
    const outfile = join(root, "vsys");
    await buildBinary(outfile);
    const binary = await Bun.file(outfile).text();
    expect({
      react: binary.includes("react.production"),
      reactDevelopment: binary.includes("react.development"),
      reconcilerDevelopment: binary.includes("react-reconciler.development"),
    }).toEqual({
      react: true,
      reactDevelopment: false,
      reconcilerDevelopment: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
