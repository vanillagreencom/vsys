import { expect, test } from "bun:test";
import { join } from "node:path";
import { saveConfig } from "./config/config";
import { fixture } from "./test/fixture";

test("once exports structured evidence and fails visibly on source errors", async () => {
  const f = fixture();
  try {
    const path = join(f.root, "config.toml");
    await saveConfig(f.config, path);
    await saveConfig(f.config, join(f.root, ".config/vsys/config.toml"));
    const run = async (extra: string[] = []) => {
      const child = Bun.spawn(
        [process.execPath, "src/main.ts", "--once", "--config", path, ...extra],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: f.root },
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
test("quit and failed shutdown restore their own terminal settings", async () => {
  const f = fixture();
  try {
    const path = join(f.root, "config.toml");
    await saveConfig({ ...f.config, refreshMs: 100 }, path);
    const script = `import os, pty, select, subprocess, sys, termios, time
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
argv = [sys.argv[1], "src/main.ts", "--config", sys.argv[2]]
if sys.argv[3] == "fault":
    code = 'import { History } from "./src/store/history"; import { main } from "./src/main"; const close = History.prototype.close; History.prototype.close = function() { close.call(this); throw new Error("injected shutdown failure"); }; await main(["--config", process.argv.at(-1)]);'
    argv = [sys.argv[1], "-e", code, sys.argv[2]]
child = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, start_new_session=True, env={**os.environ, "TERM": "xterm-256color"})
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
        ["python3", "-c", script, process.execPath, path, mode],
        {
          stdout: "pipe",
          stderr: "pipe",
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
