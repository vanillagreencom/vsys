import { expect, test } from "bun:test";
import { renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { present } from "../test/present";
import { collectGroups } from "./cgroups";
import { Reader } from "./io";

test("a recreated scope starts with unknown CPU and I/O rates", () => {
  const f = fixture();
  const scope = "build.scope";
  const path = join(f.config.cgroupRoot, scope);
  const write = (cpu: number, read: number, written: number) => {
    f.write(join(path, "cpu.stat"), `usage_usec ${cpu}\n`);
    f.write(join(path, "io.stat"), `8:0 rbytes=${read} wbytes=${written}\n`);
  };
  const sample = (before: ReturnType<typeof collectGroups>) => {
    const r = new Reader();
    const groups = collectGroups(r, f.config.cgroupRoot, before, 1000);
    expect(r.errors).toEqual([]);
    const group = present(
      groups.find((g) => g.path === scope),
      "scope",
    );
    return {
      groups,
      rates: [group.cpuPercent, group.readRate, group.writeRate],
    };
  };
  try {
    f.group(scope);
    write(1000, 1000, 2000);
    const first = sample([]);
    expect(first.rates).toEqual([null, null, null]);
    const identity = statSync(path).ino;
    // Keep the old directory allocated so the replacement cannot reuse its inode.
    renameSync(path, join(f.root, "retired"));
    f.group(scope);
    write(1_001_000, 1_001_000, 1_002_000);
    expect(statSync(path).ino).not.toBe(identity);
    const replacement = sample(first.groups);
    expect(replacement.rates).toEqual([null, null, null]);
    write(1_501_000, 1_003_000, 1_005_000);
    expect(sample(replacement.groups).rates).toEqual([50, 2000, 3000]);
  } finally {
    f.cleanup();
  }
});

test("an unread cgroup identity leaves rates unknown without losing counters", () => {
  const f = fixture();
  const path = join(f.config.cgroupRoot, "build.scope");
  class UnreadIdentity extends Reader {
    override identity(source: string): string | null {
      if (source !== path) return super.identity(source);
      return super.identity(join(source, "missing"));
    }
  }
  try {
    f.group("build.scope");
    const before = collectGroups(new Reader(), f.config.cgroupRoot, [], 1000);
    f.write(join(path, "cpu.stat"), "usage_usec 501000");
    f.write(join(path, "io.stat"), "8:0 rbytes=3000 wbytes=5000");
    const r = new UnreadIdentity();
    const groups = collectGroups(r, f.config.cgroupRoot, before, 1000);
    const unread = present(
      groups.find((g) => g.path === "build.scope"),
      "scope",
    );
    expect(r.errors.map((e) => e.source)).toEqual([join(path, "missing")]);
    expect([unread.cpuUsec, unread.ioRead, unread.ioWrite]).toEqual([
      501000, 3000, 5000,
    ]);
    expect([unread.cpuPercent, unread.readRate, unread.writeRate]).toEqual([
      null,
      null,
      null,
    ]);
    const next = collectGroups(new Reader(), f.config.cgroupRoot, groups, 1000);
    const recovered = present(
      next.find((g) => g.path === "build.scope"),
      "scope",
    );
    expect([
      recovered.cpuPercent,
      recovered.readRate,
      recovered.writeRate,
    ]).toEqual([null, null, null]);
  } finally {
    f.cleanup();
  }
});
