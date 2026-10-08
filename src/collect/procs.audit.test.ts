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
  // The test runs as an ordinary user whoever runs the suite; the status file
  // the fixture writes says which capabilities that user holds.
  const euid = spyOn(process, "geteuid").mockReturnValue(2000);
  const groups = spyOn(process, "getgroups").mockReturnValue([2000]);
  try {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
    mkdirSync(pid, { recursive: true });
    mkdirSync(join(c.procRoot, "self"));
    const mountinfo = join(c.procRoot, "self/mountinfo");
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
    let time = 1000;
    const sample = async (options: string, capEff = "0000000000000000") => {
      writeFileSync(
        mountinfo,
        `1 0 0:1 / ${c.procRoot} rw - proc proc rw,${options}\n`,
      );
      writeFileSync(join(c.procRoot, "self/status"), `CapEff:\t${capEff}\n`);
      time += 1000;
      return collector.collect({ ...request, time }, signal);
    };
    // A member of the mount's exempt group sees every process.
    const exempt = await sample("hidepid=2,gid=2000");
    expect(exempt.errors).toEqual([]);
    expect(exempt.processRead).toBe("complete");
    expect(buildLoad({ ...emptySnapshot(), ...exempt }, c).builds).toBe(1);
    // The ptraceable mode checks trace permission before the exempt group.
    for (const mode of ["hidepid=4", "hidepid=ptraceable"])
      expect((await sample(`${mode},gid=2000`)).processRead).toBe("incomplete");
    // Root credentials without CAP_SYS_PTRACE do not see every process.
    euid.mockReturnValue(0);
    groups.mockReturnValue([0]);
    expect((await sample("hidepid=2")).processRead).toBe("incomplete");
    expect((await sample("hidepid=4")).processRead).toBe("incomplete");
    // A process that may trace every other sees every process in both modes.
    const tracer = "00000000a80c25fb";
    expect((await sample("hidepid=2", tracer)).processRead).toBe("complete");
    expect((await sample("hidepid=4", tracer)).processRead).toBe("complete");
    euid.mockReturnValue(2000);
    groups.mockReturnValue([2000]);
    // hidepid=2 omits another user's directory without a read error.
    hidden.mockImplementation(function (this: Reader, path, optional) {
      const names = list.call(this, path, optional);
      return path === c.procRoot
        ? names.filter((name) => name !== "900")
        : names;
    });
    const reading = await sample("hidepid=2");
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

test("A1-1: a mount table vsys could not read leaves the build count unknown", async () => {
  const made = Bun.spawnSync(["/usr/bin/mktemp", "-d"], { env: {} });
  expect(made.exitCode).toBe(0);
  const root = made.stdout.toString().trim();
  const c = defaults();
  c.procRoot = join(root, "proc");
  const mountinfo = join(c.procRoot, "self/mountinfo");
  const read = Reader.prototype.exact;
  const denied = spyOn(Reader.prototype, "exact");
  try {
    mkdirSync(join(c.procRoot, "self"), { recursive: true });
    writeFileSync(mountinfo, `1 0 0:1 / ${c.procRoot} rw - proc proc rw\n`);
    const collector = new ProcessCollector(c, 100, 4096);
    const request = { time: 1000, uptime: 10, groups: [] };
    const signal = new AbortController().signal;
    const readable = await collector.collect(request, signal);
    expect(readable.processRead).toBe("complete");
    expect(buildLoad({ ...emptySnapshot(), ...readable }, c).builds).toBe(0);
    denied.mockImplementation(function (this: Reader, path, optional) {
      if (path !== mountinfo) return read.call(this, path, optional);
      this.error(path, Object.assign(new Error("EACCES"), { code: "EACCES" }));
      return null;
    });
    const reading = await collector.collect({ ...request, time: 2000 }, signal);
    expect(reading.errors.map((e) => e.source)).toEqual([mountinfo]);
    expect(reading.processRead).toBe("incomplete");
    expect(buildLoad({ ...emptySnapshot(), ...reading }, c).builds).toBeNull();
  } finally {
    denied.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
