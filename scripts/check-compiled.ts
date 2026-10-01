import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The standalone binary, run the way a script runs it: `--once` against a
 * scratch root of its own. Given a binary it checks that one, which is how
 * the release checks what it ships. Given none it compiles one through
 * `bun run compile` first, which is how the check contract sees the layout
 * the compiled binary embeds its scan thread in. Neither the source tree nor
 * `bun run build` can show that layout, and a binary that cannot find its
 * scan thread still prints a snapshot.
 */
const root = mkdtempSync(join(tmpdir(), "vsys-compiled-"));
try {
  let binary = process.argv[2];
  if (binary === undefined) {
    binary = join(root, "vsys");
    const compiled = Bun.spawnSync({
      cmd: [process.execPath, "run", "compile", "--outfile", binary],
      stdout: "inherit",
      stderr: "inherit",
    });
    if (compiled.exitCode !== 0)
      throw new Error(`bun run compile exited ${compiled.exitCode}`);
  }
  binary = resolve(binary);
  const scratch = join(root, "scratch");
  const session = join(scratch, "session");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "file"), "1234");
  const expected =
    lstatSync(scratch).size +
    lstatSync(session).size +
    lstatSync(join(session, "file")).size;
  const config = join(root, "config.toml");
  writeFileSync(config, `scratchDirs = [${JSON.stringify(scratch)}]\n`);
  const home = join(root, "home");
  mkdirSync(home);
  const run = Bun.spawnSync({
    cmd: [binary, "--once", "--config", config],
    env: { PATH: process.env.PATH ?? "", HOME: home },
  });
  // Status 2 is a snapshot with source errors, which a runner that cannot
  // read every process produces whatever the scratch reading.
  if (run.exitCode !== 0 && run.exitCode !== 2)
    throw new Error(
      `${binary} --once exited ${run.exitCode ?? run.signalCode}: ${run.stderr.toString()}`,
    );
  const snapshot = JSON.parse(run.stdout.toString()) as {
    storage: { scratch: { path: string; bytes: number | null }[] };
    errors: { source: string; message: string }[];
  };
  const failed = snapshot.errors.filter(
    (e) => e.source === "scratch scan" || e.source === scratch,
  );
  if (failed.length)
    throw new Error(
      `${binary} reported a scratch source error: ${JSON.stringify(failed)}`,
    );
  const bytes =
    snapshot.storage.scratch.find((s) => s.path === scratch)?.bytes ?? null;
  if (bytes !== expected)
    throw new Error(
      `${binary} measured ${bytes} bytes of scratch where ${expected} are on disk`,
    );
  console.log(JSON.stringify({ binary, scratchBytes: bytes }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
