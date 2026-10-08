import { expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "../config/config";
import { buildLoad } from "../model/verdict";
import { emptySnapshot } from "../test/fixture";
import { Reader } from "./io";
import { ProcessCollector } from "./procs";

test("A1-1: hidden compilers leave the machine build count unknown", async () => {
  const made = Bun.spawnSync(["/usr/bin/mktemp", "-d"], { env: {} });
  expect(made.exitCode).toBe(0);
  const root = made.stdout.toString().trim();
  const c = defaults();
  c.procRoot = join(root, "proc");
  const pid = join(c.procRoot, "900");
  const list = Reader.prototype.dirs;
  const hidden = spyOn(Reader.prototype, "dirs");
  // hidepid exempts a process that may trace every other, so the test runs
  // as an ordinary user in no exempt group whoever runs the suite.
  const euid = spyOn(process, "geteuid").mockReturnValue(2000);
  const groups = spyOn(process, "getgroups").mockReturnValue([2000]);
  try {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
    mkdirSync(pid, { recursive: true });
    mkdirSync(join(c.procRoot, "self"));
    const mountinfo = join(c.procRoot, "self/mountinfo");
    writeFileSync(
      mountinfo,
      `1 0 0:1 / ${c.procRoot} rw - proc proc rw,hidepid=2\n`,
    );
    const fields = Array.from({ length: 22 }, () => "0");
    fields[0] = "R";
    fields[1] = "1";
    fields[17] = "1";
    fields[19] = "100";
    writeFileSync(join(pid, "stat"), `900 (rustc) ${fields.join(" ")}`);
    writeFileSync(join(pid, "cmdline"), "/usr/bin/rustc\0main.rs\0");
    writeFileSync(
      join(pid, "cgroup"),
      "0::/user.slice/user-2000.slice/build.scope\n",
    );
    writeFileSync(join(pid, "status"), "Uid:\t2000\t2000\t2000\t2000\n");
    writeFileSync(join(pid, "environ"), "");
    symlinkSync(root, join(pid, "cwd"));
    const collector = new ProcessCollector(c, 100, 4096);
    const request = { time: 1000, uptime: 10, groups: [] };
    const signal = new AbortController().signal;
    // A member of the mount's exempt group sees every process.
    writeFileSync(
      mountinfo,
      `1 0 0:1 / ${c.procRoot} rw - proc proc rw,hidepid=2,gid=2000\n`,
    );
    const exempt = await collector.collect(request, signal);
    expect(exempt.errors).toEqual([]);
    expect(exempt.processRead).toBe("complete");
    expect(buildLoad({ ...emptySnapshot(), ...exempt }, c).builds).toBe(1);
    writeFileSync(
      mountinfo,
      `1 0 0:1 / ${c.procRoot} rw - proc proc rw,hidepid=2\n`,
    );
    // hidepid=2 omits another user's directory without a read error.
    hidden.mockImplementation(function (this: Reader, path, optional) {
      const names = list.call(this, path, optional);
      return path === c.procRoot
        ? names.filter((name) => name !== "900")
        : names;
    });
    const reading = await collector.collect({ ...request, time: 2000 }, signal);
    expect(reading.errors).toEqual([]);
    expect(reading.procs).toEqual([]);
    expect(reading.processRead).toBe("incomplete");
    expect(buildLoad({ ...emptySnapshot(), ...reading }, c).builds).toBeNull();
  } finally {
    hidden.mockRestore();
    euid.mockRestore();
    groups.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
