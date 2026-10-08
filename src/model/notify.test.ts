import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "../test/fixture";

test("notification settings select rules and pass messages as literal arguments", async () => {
  const f = fixture();
  try {
    const executable = join(f.root, "bin/notify-send");
    const capture = join(f.root, "calls.jsonl");
    f.write(
      executable,
      '#!/usr/bin/python3\nimport json, os, sys\nwith open(os.environ["VSYS_NOTIFY_CAPTURE"], "a") as out:\n    out.write(json.dumps(sys.argv[1:]) + "\\n")\n',
    );
    chmodSync(executable, 0o755);
    const script = `import {notifiable, notify} from ${JSON.stringify(resolve("src/model/alerts.ts"))}; import {defaults} from ${JSON.stringify(resolve("src/config/config.ts"))}; const c=defaults(); const alerts=[{time:1,rule:"btrfs-ro",subject:"/",message:"literal; $(touch must-not-exist)"},{time:1,rule:"memory-cap",subject:"scope",message:"cap"}]; await notify(notifiable(alerts,c)); c.notifications=["btrfs-ro"]; await notify(notifiable(alerts,c));`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: f.root,
      env: { PATH: join(f.root, "bin"), VSYS_NOTIFY_CAPTURE: capture },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const calls = readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      [
        "--app-name=vsys",
        "--",
        "vsys: btrfs-ro",
        "literal; $(touch must-not-exist)",
      ],
    ]);
    expect(existsSync(join(f.root, "must-not-exist"))).toBe(false);
  } finally {
    f.cleanup();
  }
});
test("a failed notification executable rejects the delivery", async () => {
  const f = fixture();
  try {
    const executable = join(f.root, "bin/notify-send");
    f.write(executable, "#!/usr/bin/python3\nimport sys\nsys.exit(19)\n");
    chmodSync(executable, 0o755);
    const script = `import {notify} from ${JSON.stringify(resolve("src/model/alerts.ts"))}; try { await notify([{time:1,rule:"scrub",subject:"/",message:"failed"}]); } catch { process.exitCode=7; }`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: f.root,
      env: { PATH: join(f.root, "bin") },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(7);
  } finally {
    f.cleanup();
  }
});
test("one failed delivery does not cancel the remaining alerts", async () => {
  const f = fixture();
  try {
    const executable = join(f.root, "bin/notify-send");
    const capture = join(f.root, "calls.jsonl");
    f.write(
      executable,
      '#!/usr/bin/python3\nimport json, os, sys\nargv = sys.argv[1:]\nwith open(os.environ["VSYS_NOTIFY_CAPTURE"], "a") as out:\n    out.write(json.dumps(argv) + "\\n")\nsys.exit(19 if "first" in argv else 0)\n',
    );
    chmodSync(executable, 0o755);
    const script = `import {notify} from ${JSON.stringify(resolve("src/model/alerts.ts"))}; try { await notify([{time:1,rule:"scrub",subject:"a",message:"first"},{time:1,rule:"scrub",subject:"b",message:"second"}]); } catch (e) { if (e instanceof AggregateError && e.errors.length === 1) process.exitCode=7; }`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: f.root,
      env: { PATH: join(f.root, "bin"), VSYS_NOTIFY_CAPTURE: capture },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(7);
    const calls = readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => call[3])).toEqual(["first", "second"]);
  } finally {
    f.cleanup();
  }
});
test("a notification executable that outlives the time limit is killed and rejects the delivery", async () => {
  const f = fixture();
  try {
    const executable = join(f.root, "bin/notify-send");
    f.write(executable, "#!/bin/sh\nexec /bin/sleep 30\n");
    chmodSync(executable, 0o755);
    const script = `import {notify} from ${JSON.stringify(resolve("src/model/alerts.ts"))}; try { await notify([{time:1,rule:"scrub",subject:"/",message:"failed"}],200); } catch { process.exitCode=7; }`;
    const started = performance.now();
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: f.root,
      env: { PATH: join(f.root, "bin") },
      stdout: "ignore",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      expect(await child.exited).toBe(7);
    } finally {
      clearTimeout(timer);
    }
    expect(performance.now() - started).toBeLessThan(10000);
  } finally {
    f.cleanup();
  }
}, 15000);
