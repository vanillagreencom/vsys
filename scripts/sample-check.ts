import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { saveConfig } from "../src/config/config";
import { fixture } from "../src/test/fixture";

/**
 * Takes one `--once` sample with a built program, the way src/main.test.ts
 * runs the source: against a fixture, with a PATH holding only a getconf
 * stand-in, so nothing outside the fixture is read and no tmux server is
 * asked. A build that left out a thread the program starts fails here, where
 * `--help` would still pass.
 *
 * Usage: bun scripts/sample-check.ts PROGRAM [ARGS...]
 * PROGRAM is looked up on the caller's PATH unless it names a path; any
 * argument naming an existing file is passed as an absolute path.
 */
const [program, ...rest] = process.argv.slice(2);
if (!program) {
  console.error("sample-check: usage=missing-program");
  process.exit(2);
}
const executable = program.includes("/")
  ? resolve(program)
  : Bun.which(program);
if (!executable || !existsSync(executable)) {
  console.error(`sample-check: program=not-found value=${program}`);
  process.exit(1);
}
const argv = [
  executable,
  ...rest.map((arg) => (existsSync(arg) ? resolve(arg) : arg)),
];

const f = fixture();
try {
  f.group("agents.slice/a.scope", [40]);
  f.proc(40, "agents.slice/a.scope", {
    env: "CLAUDE_CONFIG_DIR=/accounts/work\0",
  });
  const bin = join(f.root, "bin");
  mkdirSync(bin, { recursive: true });
  const getconf = join(bin, "getconf");
  writeFileSync(
    getconf,
    '#!/bin/sh\ncase "$1" in\n  CLK_TCK) echo 100 ;;\n  PAGESIZE) echo 4096 ;;\n  *) exit 1 ;;\nesac\n',
  );
  chmodSync(getconf, 0o755);
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
  if (code !== 0) failure(`exit=${code}`, stderr.trim());
  else {
    const snapshot = JSON.parse(stdout) as {
      errors: unknown[];
      procs: { pid: number }[];
      lanes: { account: string | null }[];
    };
    if (snapshot.errors.length)
      failure("source-errors", JSON.stringify(snapshot.errors));
    else if (
      snapshot.procs.map((p) => p.pid).join() !== "40" ||
      snapshot.lanes[0]?.account !== "work"
    )
      failure("incomplete-sample", stdout.slice(0, 2000));
    else console.log(`sample-check: ok command=${argv.join(" ")}`);
  }
} finally {
  f.cleanup();
}
