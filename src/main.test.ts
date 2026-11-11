import { expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Collector } from "./collect/collector";
import { ConfigError, saveConfig } from "./config/config";
import { main, sampleSummary } from "./main";
import { fixture, hermeticBin } from "./test/fixture";
import { summarySnapshot } from "./ui/export";
import { errorText } from "./ui/refusals";

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
    // A typed refusal reaches the terminal written out, never as its kind.
    const pressure = join(f.root, "pressure.toml");
    writeFileSync(pressure, "pressureAmber = 90\npressureRed = 50\n");
    const refused = await run(["--config", pressure]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      errorText(new ConfigError({ kind: "pressure-order" })),
    );
    expect(refused.stderr).not.toContain("pressure-order");
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
    const { meters, ...parsed } = JSON.parse(summary.stdout);
    // The meter list is open: a meter added later is held to the same shape
    // without a new entry here.
    expect(meters.length).toBeGreaterThan(0);
    for (const meter of meters)
      expect(meter).toEqual({
        id: expect.any(String),
        level: "ok",
        max: expect.any(Number),
        value: expect.any(Number),
      });
    expect({
      ...parsed,
      time: typeof parsed.time,
    }).toMatchInlineSnapshot(`
      {
        "errors": [],
        "schema": "vsys.summary.v2",
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
    await expect(main(["--summary", "--config", path])).rejects.toMatchObject({
      refusal: { kind: "needs-once" },
    });
  } finally {
    f.cleanup();
  }
});
/** The action arguments every warden status fixture names, and the fixtures with no items list. */
function wardenActionArgs(): { missing: string[]; args: string[][] } {
  const dir = join("warden", "fixtures");
  const missing: string[] = [];
  const args: string[][] = [];
  for (const name of readdirSync(dir)) {
    if (!/^status-.*\.json$/.test(name)) continue;
    const doc: { items?: { actions: { args: string[] }[] }[] } = JSON.parse(
      readFileSync(join(dir, name), "utf8"),
    );
    if (!Array.isArray(doc.items)) missing.push(name);
    for (const item of doc.items ?? [])
      for (const action of item.actions) args.push(action.args);
  }
  return { missing, args };
}
const warden = wardenActionArgs();
test("the warden's status fixtures name a lane and a lane's Stop", () => {
  expect(warden.missing).toEqual([]);
  const shapes = warden.args.map((args) =>
    args.map((arg, i) => (i === 1 ? "SCOPE" : arg)).join(" "),
  );
  expect(shapes).toEqual(
    expect.arrayContaining(["--lane SCOPE", "--lane SCOPE --stop"]),
  );
});
// The lane flags set the dashboard's first view, so no run without it takes
// them. Each row is refused before any settings or system read. The lane rows
// are the warden's status actions, which the widget runs as vsys arguments:
// the parser is strict, so an argument vsys does not take throws before this
// refusal, and reaching lane-needs-terminal proves vsys parsed the action and
// that its --stop came with --lane. An empty action is vsys with no arguments.
const laneRows = new Map<string, string[]>();
for (const args of warden.args)
  if (args.length > 0) laneRows.set(args.join("\0"), [...args, "--once"]);
test.each<[string[], string]>([
  [["--stop"], "stop-needs-lane"],
  ...[...laneRows.values()].map((args): [string[], string] => [
    args,
    "lane-needs-terminal",
  ]),
])("%p is refused as %s", async (args, kind) => {
  await expect(main(args)).rejects.toMatchObject({ refusal: { kind } });
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
test("quit, hangup and terminate all take the quit key's shutdown", async () => {
  const f = fixture();
  try {
    const path = join(f.root, "config.toml");
    // History persists so the refresh row can count the samples the child has
    // stored, each one a refresh it ran.
    await saveConfig(
      { ...f.config, refreshMs: 100, persistence: true },
      path,
      f.agentToolsPath,
    );
    // The child owns the terminal as its controlling terminal, so closing the
    // master side is the hangup a closed window or a killed tmux pane sends.
    // A hangup leaves no terminal whose settings could be restored. The
    // shutdown report goes to a file, which outlives the terminal.
    const script = `import fcntl, os, pty, select, signal, sqlite3, subprocess, sys, termios, time
binary, config, trigger, home, fault, history = sys.argv[1:7]
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
argv = [binary, "src/main.ts", "--config", config]
if fault == "fault":
    code = 'import { History } from "./src/store/history"; import { main } from "./src/main"; const close = History.prototype.close; History.prototype.close = function() { close.call(this); throw new Error("injected shutdown failure"); }; await main(["--config", process.argv.at(-1)]);'
    argv = [binary, "-e", code, config]
def attach():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
report_path = os.path.join(home, f"stderr-{trigger}-{fault}")
with open(report_path, "wb") as report_file:
    child = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=report_file, preexec_fn=attach, env={**os.environ, "TERM": "xterm-256color", "HOME": home})
output = b""
sent = False
ready_at = None
launched = time.time() * 1000
# The runtime warns at the eleventh listener on one event, so a refresh that
# leaks one warns by the eleventh refresh. Each refresh stores its sample
# before it draws, so a twelfth stored sample means eleven refreshes drew.
def refreshes():
    try:
        db = sqlite3.connect(f"file:{history}?mode=ro", uri=True)
        try:
            return db.execute("SELECT count(*) FROM samples WHERE time >= ?", (launched,)).fetchone()[0]
        finally:
            db.close()
    except sqlite3.OperationalError:
        return 0
try:
    deadline = time.monotonic() + (float(sys.argv[7]) - time.time())
    while child.poll() is None and time.monotonic() < deadline:
        if trigger == "hangup" and sent:
            try:
                child.wait(timeout=deadline - time.monotonic())
            except subprocess.TimeoutExpired:
                pass
            break
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            output += os.read(master, 65536)
        if ready_at is None and b"Agents" in output:
            ready_at = time.monotonic()
        if not sent and ready_at is not None and (trigger != "refresh" or refreshes() >= 12):
            if trigger == "hangup":
                os.close(master)
                master = None
            elif trigger == "term":
                child.send_signal(signal.SIGTERM)
            else:
                os.write(master, bytes([3]) if trigger == "ctrl+c" else b"q")
            sent = True
    assert b"Agents" in output, "Application did not render its tabs"
    expected = 1 if fault == "fault" else 0
    assert child.poll() == expected, f"Unexpected exit: {child.poll()}, {output!r}"
    with open(report_path, "rb") as report_file:
        report = report_file.read()
    failure = b"vsys shutdown: Error: injected shutdown failure"
    assert (failure in report) == (fault == "fault"), f"Unexpected shutdown report: {report!r}"
    if trigger != "hangup":
        assert termios.tcgetattr(slave) == before, "Application changed terminal settings after quit"
    assert b"MaxListenersExceededWarning" not in output + report, "Refresh leaked event listeners"
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
    if master is not None:
        os.close(master)
    os.close(slave)
`;
    // Only the quit key's shutdown reports a failure injected into the
    // history close, so the signal rows with it prove each signal reaches that
    // shutdown rather than one of its own.
    for (const [trigger, fault] of [
      ["q", "clean"],
      ["ctrl+c", "clean"],
      ["refresh", "clean"],
      ["hangup", "clean"],
      ["q", "fault"],
      ["hangup", "fault"],
      ["term", "fault"],
    ] as const) {
      // Leave time for both termination waits before Bun ends the test.
      const deadline = (Date.now() + 13000) / 1000;
      const child = Bun.spawn(
        [
          "python3",
          "-c",
          script,
          process.execPath,
          path,
          trigger,
          f.root,
          fault,
          f.config.sqlitePath,
          String(deadline),
        ],
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
      expect({ trigger, fault, code, stderr }).toEqual({
        trigger,
        fault,
        code: 0,
        stderr: "",
      });
    }
  } finally {
    f.cleanup();
  }
}, 100000);

test("once carries the warden's leftover counts, and null where none were read", async () => {
  const f = fixture();
  try {
    const bin = hermeticBin(f.root);
    const path = join(f.root, "config.toml");
    await saveConfig(f.config, path, f.agentToolsPath);
    const runtime = join(f.root, "run");
    const run = async () => {
      const child = Bun.spawn(
        [process.execPath, "src/main.ts", "--once", "--config", path],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { HOME: f.root, PATH: bin, XDG_RUNTIME_DIR: runtime },
        },
      );
      const [stdout, code] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      return { code, leftovers: JSON.parse(stdout).leftovers };
    };
    const none = { testWorlds: null, failedUnits: null, testProcesses: null };
    expect(await run()).toEqual({
      code: 0,
      leftovers: { state: "absent", time: null, ...none },
    });
    // The warden's own fixture, written as of now so it is fresh.
    const status = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../warden/fixtures/status-leftovers.json"),
        "utf8",
      ),
    );
    status.time = Math.floor(Date.now() / 1000);
    f.write(join(runtime, "agent-warden/status.json"), JSON.stringify(status));
    expect(await run()).toEqual({
      code: 0,
      leftovers: {
        state: "read",
        time: status.time * 1000,
        testWorlds: 3,
        failedUnits: 1,
        testProcesses: 3,
      },
    });
  } finally {
    f.cleanup();
  }
});
