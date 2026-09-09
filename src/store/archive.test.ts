import { expect, test } from "bun:test";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import { Archive } from "./archive";

test("checkpoint replay preserves changes, process churn and arbitrary cursor order", () => {
  const archive = new Archive();
  const expected = new Map<number, ReturnType<typeof emptySnapshot>>();
  const s = emptySnapshot();
  s.procs = [processSnapshot(), processSnapshot({ pid: 41 })];
  s.groups = [groupSnapshot()];
  s.lanes = [laneSnapshot()];
  for (let i = 0; i < 605; i++) {
    s.time = 1000 + i * 1000;
    s.system.uptime += 1;
    for (const p of s.procs) {
      p.age += 1;
      p.ticks += 5;
    }
    if (i === 100) {
      s.procs[0].cwd = "/work/中文";
      s.procs[0].command = ["claude", "", "a\nb"];
      s.procs[0].env.TMPDIR = "/tmp/work";
    }
    if (i === 200) s.procs.pop();
    if (i === 301) {
      s.procs.push(
        processSnapshot({ pid: 42, start: 200, cpuPercent: Number.MIN_VALUE }),
      );
      delete s.procs[0].env.TMPDIR;
    }
    if (i === 500) {
      s.lanes = [];
      s.groups[0].max = 0;
      s.procs[0].cpuPercent = 1e300;
    }
    archive.add(s.time, JSON.stringify(s));
    if ([0, 99, 100, 200, 299, 300, 301, 500, 604].includes(i))
      expected.set(s.time, structuredClone(s));
  }
  for (const time of [...expected.keys(), ...[...expected.keys()].reverse()])
    expect(archive.at(time)).toEqual(expected.get(time) ?? null);
  expect(archive.at(999)).toBeNull();
  expect(archive.at(1001)).toEqual(expected.get(1000) ?? null);
});
test("copies and caller mutations cannot change archived evidence", () => {
  const archive = new Archive();
  const s = emptySnapshot(1000);
  archive.add(s.time, JSON.stringify(s));
  const returned = archive.at(1000);
  if (!returned) throw new Error("Missing test snapshot");
  returned.system.host = "changed";
  const copy = archive.copy(1000);
  archive.add(2000, JSON.stringify(emptySnapshot(2000)));
  copy.add(3000, JSON.stringify(emptySnapshot(3000)));
  expect(copy.at(1000)?.system.host).toBe("fixture");
  expect(archive.at(3000)?.time).toBe(2000);
  expect(copy.at(2000)?.time).toBe(1000);
  archive.prune(3000);
  expect(archive.at(2000)).toBeNull();
  expect(copy.at(1000)?.time).toBe(1000);
});
test("duplicate times and a checkpoint past the budget fail visibly", () => {
  const archive = new Archive();
  const s = emptySnapshot(1000);
  archive.add(s.time, JSON.stringify(s));
  expect(() => archive.add(s.time, JSON.stringify(s))).toThrow();
  expect(() => new Archive(1).add(s.time, JSON.stringify(s))).toThrow();
});
