import { expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Collector } from "./collect/collector";
import { saveConfig } from "./config/config";
import { sampleSummary } from "./main";
import { summarySnapshot } from "./model/export";
import { fixture, hermeticBin } from "./test/fixture";

test("once exports structured evidence and fails visibly on source errors", async () => {
  const f = fixture();
  try {
    const bin = hermeticBin(f.root);
    const path = join(f.root, "config.toml");
    await saveConfig(f.config, path, f.agentToolsPath);
    await saveConfig(
      f.config,
      join(f.root, ".config/vsys/config.toml"),
      f.agentToolsPath,
    );
    const run = async (extra: string[] = []) => {
      const child = Bun.spawn(
        [process.execPath, "src/main.ts", "--once", "--config", path, ...extra],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { HOME: f.root, PATH: bin },
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    };
    const healthy = await run();
    expect(healthy.code).toBe(0);
    expect(JSON.parse(healthy.stdout).errors).toEqual([]);
    const markdown = await run(["--markdown"]);
    expect(markdown.code).toBe(0);
    expect(markdown.stdout).toContain("# vsys snapshot");
    f.write(join(f.config.cgroupRoot, "cpu.stat"), "usage_usec invalid");
    const failed = await run();
    expect(failed.code).toBe(2);
    expect(JSON.parse(failed.stdout).errors.length).toBeGreaterThan(0);
    const invalid = await run(["--unknown"]);
    expect(invalid.code).toBe(1);
    const empty = await run(["--config", ""]);
    expect(empty.code).toBe(1);
  } finally {
    f.cleanup();
  }
});

test("once summary exports verdict schema and skips scratch collection", async () => {
  const f = fixture();
  try {
    const bin = hermeticBin(f.root);
    f.config.scratchDirs = [join(f.root, "missing-scratch")];
    const path = join(f.root, "config.toml");
    await saveConfig(f.config, path, f.agentToolsPath);
    const run = async (extra: string[] = []) => {
      const child = Bun.spawn(
        [process.execPath, "src/main.ts", "--once", "--config", path, ...extra],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { HOME: f.root, PATH: bin },
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    };
    const summary = await run(["--summary"]);
    expect(summary.code).toBe(0);
    const parsed = JSON.parse(summary.stdout);
    expect({
      ...parsed,
      time: typeof parsed.time,
      meters: parsed.meters.map((meter: { value: unknown; max: unknown }) => ({
        ...meter,
        value: meter.value === null ? null : typeof meter.value,
        max: meter.max === null ? null : typeof meter.max,
      })),
    }).toMatchInlineSnapshot(`
      {
        "errors": [],
        "meters": [
          {
            "id": "cpu",
            "level": "ok",
            "max": "number",
            "value": "number",
          },
          {
            "id": "memory",
            "level": "ok",
            "max": "number",
            "value": "number",
          },
          {
            "id": "disk",
            "level": "ok",
            "max": "number",
            "value": "number",
          },
          {
            "id": "builds",
            "level": "ok",
            "max": "number",
            "value": "number",
          },
        ],
        "schema": "vsys.summary.v1",
        "time": "number",
        "verdict": [
          {
            "cause": "scratch",
            "level": null,
            "subject": null,
          },
        ],
      }
    `);
    const sccache = join(bin, "sccache");
    writeFileSync(sccache, '#!/bin/sh\necho "server down" >&2\nexit 1\n');
    chmodSync(sccache, 0o755);
    const failedSummary = await run(["--summary"]);
    expect(failedSummary.code).toBe(2);
    expect(JSON.parse(failedSummary.stdout).errors).toContainEqual({
      source: "sccache --show-stats",
      message: expect.stringContaining("server down"),
    });
    const full = await run();
    expect(full.code).toBe(2);
    expect(JSON.parse(full.stdout).errors).toContainEqual({
      source: f.config.scratchDirs[0],
      message: expect.stringContaining("ENOENT"),
    });
    const invalid = await run(["--summary", "--markdown"]);
    expect(invalid.code).toBe(1);
    const missingOnce = Bun.spawn(
      [process.execPath, "src/main.ts", "--summary", "--config", path],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { HOME: f.root, PATH: bin },
      },
    );
    const [missingOnceStderr, missingOnceCode] = await Promise.all([
      new Response(missingOnce.stderr).text(),
      missingOnce.exited,
    ]);
    expect(missingOnceCode).toBe(1);
    expect(missingOnceStderr).toContain("vsys: --summary requires --once");
  } finally {
    f.cleanup();
  }
});
test("summary sampling gives rate-backed activity a baseline", async () => {
  const f = fixture();
  try {
    let time = 1000;
    f.group("agents.slice/rate.scope", [40]);
    f.proc(40, "agents.slice/rate.scope");
    f.write(
      join(f.config.procRoot, "pressure/io"),
      "some avg10=70.00 avg60=0.00 avg300=0.00 total=100\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    );
    const firstOnly = await new Collector(f.config, 100, 4096).sample(
      time,
      undefined,
      { skipScratch: true },
    );
    expect(
      summarySnapshot(firstOnly, f.config).verdict.find(
        (cause) => cause.cause === "disk",
      ),
    ).toBeUndefined();
    const { snapshot } = await sampleSummary(
      new Collector(f.config, 100, 4096),
      async () => {
        time = 2000;
        f.write(
          join(f.config.cgroupRoot, "agents.slice/rate.scope/io.stat"),
          "259:0 rbytes=1000 wbytes=2102000 rios=1 wios=2\n",
        );
      },
      () => time,
    );
    expect(
      summarySnapshot(snapshot, f.config).verdict.find(
        (cause) => cause.cause === "disk",
      ),
    ).toMatchObject({
      cause: "disk",
      subject: "agents.slice/rate.scope",
    });
  } finally {
    f.cleanup();
  }
});
test("quit and failed shutdown restore their own terminal settings", async () => {
  const f = fixture();
  try {
    const path = join(f.root, "config.toml");
    await saveConfig({ ...f.config, refreshMs: 100 }, path, f.agentToolsPath);
    const script = `import os, pty, select, subprocess, sys, termios, time
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
argv = [sys.argv[1], "src/main.ts", "--config", sys.argv[2]]
if sys.argv[3] == "fault":
    code = 'import { History } from "./src/store/history"; import { main } from "./src/main"; const close = History.prototype.close; History.prototype.close = function() { close.call(this); throw new Error("injected shutdown failure"); }; await main(["--config", process.argv.at(-1)]);'
    argv = [sys.argv[1], "-e", code, sys.argv[2]]
child = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, start_new_session=True, env={**os.environ, "TERM": "xterm-256color", "HOME": sys.argv[4]})
output = b""
sent = False
ready_at = None
try:
    deadline = time.monotonic() + 6
    while child.poll() is None and time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            output += os.read(master, 65536)
        if ready_at is None and b"Agents" in output:
            ready_at = time.monotonic()
        if not sent and ready_at is not None and (sys.argv[3] != "refresh" or time.monotonic() - ready_at > 2):
            os.write(master, bytes([3]) if sys.argv[3] == "ctrl+c" else b"q")
            sent = True
    assert b"Agents" in output, "Application did not render its tabs"
    expected = 1 if sys.argv[3] == "fault" else 0
    assert child.poll() == expected, f"Unexpected exit: {child.poll()}, {output!r}"
    assert termios.tcgetattr(slave) == before, "Application changed terminal settings after quit"
    assert b"MaxListenersExceededWarning" not in output, "Refresh leaked event listeners"
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
    os.close(master)
    os.close(slave)
`;
    for (const mode of ["q", "ctrl+c", "fault", "refresh"]) {
      const child = Bun.spawn(
        ["python3", "-c", script, process.execPath, path, mode, f.root],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: f.root },
        },
      );
      const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    }
  } finally {
    f.cleanup();
  }
}, 10000);
