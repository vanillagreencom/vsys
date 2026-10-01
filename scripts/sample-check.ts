import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { saveConfig } from "../src/config/config";
import { fixture, hermeticBin } from "../src/test/fixture";
import { buildBinary } from "./build";

/**
 * Takes one `--once` sample with a built program, the way src/main.test.ts
 * runs the source: against a fixture, with a PATH holding only a getconf
 * stand-in, so nothing outside the fixture is read and no tmux server is
 * asked. The fixture holds one process and one scratch root, so the sample
 * starts both worker threads the program has: a build that left either out
 * fails here, where `--help` would still pass, and a scratch reading that
 * comes back wrong fails here too.
 *
 * Usage: bun scripts/sample-check.ts PROGRAM [ARGS...]
 *        bun scripts/sample-check.ts --compile
 * PROGRAM is looked up on the caller's PATH unless it names a path; any
 * argument naming an existing file is passed as an absolute path.
 * `--compile` builds the standalone binary into the fixture, the way the
 * `compile` script builds it, and samples that.
 */
const args = process.argv.slice(2);
if (!args.length) {
  console.error("sample-check: usage=missing-program");
  process.exit(2);
}

const f = fixture();
try {
  let argv: string[];
  if (args[0] === "--compile") {
    const binary = join(f.root, "vsys");
    await buildBinary(binary);
    argv = [binary];
  } else {
    const [program, ...rest] = args;
    const executable = program.includes("/")
      ? resolve(program)
      : Bun.which(program);
    if (!executable || !existsSync(executable))
      throw new Error(`sample-check: program=not-found value=${program}`);
    argv = [
      executable,
      ...rest.map((arg) => (existsSync(arg) ? resolve(arg) : arg)),
    ];
  }
  f.group("agents.slice/a.scope", [40]);
  f.proc(40, "agents.slice/a.scope", {
    env: "CLAUDE_CONFIG_DIR=/accounts/work\0",
  });
  // A plain `--once` waits for a complete scratch scan.
  const scratch = join(f.root, "scratch");
  const session = join(scratch, "session");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "file"), "1234");
  const scratchBytes =
    lstatSync(scratch).size +
    lstatSync(session).size +
    lstatSync(join(session, "file")).size;
  f.config.scratchDirs = [scratch];
  const bin = hermeticBin(f.root);
  const config = join(f.root, "config.toml");
  await saveConfig(f.config, config, f.agentToolsPath);
  const child = Bun.spawn([...argv, "--once", "--config", config], {
    cwd: f.root,
    stdout: "pipe",
    stderr: "pipe",
    env: { HOME: f.root, PATH: bin },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const failure = (key: string, detail: string) => {
    console.error(`sample-check: ${key} command=${argv.join(" ")}`);
    console.error(detail);
    process.exitCode = 1;
  };
  // Status 2 is a snapshot with source errors, which only stdout names.
  const named = () => {
    try {
      return JSON.stringify((JSON.parse(stdout) as { errors: unknown }).errors);
    } catch {
      return stdout.slice(0, 2000);
    }
  };
  if (code !== 0) failure(`exit=${code}`, stderr.trim() || named());
  else {
    const snapshot = JSON.parse(stdout) as {
      errors: unknown[];
      procs: { pid: number }[];
      lanes: { account: string | null }[];
      storage: { scratch: { path: string; bytes: number | null }[] };
    };
    const measured =
      snapshot.storage.scratch.find((s) => s.path === scratch)?.bytes ?? null;
    if (snapshot.errors.length)
      failure("source-errors", JSON.stringify(snapshot.errors));
    else if (
      snapshot.procs.map((p) => p.pid).join() !== "40" ||
      snapshot.lanes[0]?.account !== "work"
    )
      failure("incomplete-sample", stdout.slice(0, 2000));
    else if (measured !== scratchBytes)
      failure(
        `scratch-bytes=${measured}`,
        `${scratchBytes} bytes of scratch are on disk`,
      );
    else console.log(`sample-check: ok command=${argv.join(" ")}`);
  }
} finally {
  f.cleanup();
}
