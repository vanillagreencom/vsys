import { expect, spyOn, test } from "bun:test";
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
  // The uncompressed lines a checkpoint has not sealed yet are live memory and
  // are charged to the budget, so they cannot grow unwatched between seals.
  const open = new Archive(96 * 1024);
  expect(() => {
    for (let i = 0; i < 40; i++) {
      const next = emptySnapshot(1000 + i * 1000);
      next.procs = [processSnapshot({ cwd: `/work/${"x".repeat(8192)}/${i}` })];
      open.add(next.time, JSON.stringify(next));
    }
  }).toThrow();
});
test("an append compresses only the lines that append added", () => {
  const archive = new Archive();
  const inputs: number[] = [];
  const compressing: number[] = [];
  const expected = new Map<number, ReturnType<typeof emptySnapshot>>();
  const spy = spyOn(Bun, "gzipSync");
  try {
    for (let i = 0; i < 400; i++) {
      const s = emptySnapshot(1000 + i * 1000);
      // A fresh long path each sample, so the deltas alone pass the open-run
      // limit several times and the checkpoint has to seal more than once.
      s.procs = [processSnapshot({ cwd: `/work/${String(i).repeat(2048)}` })];
      spy.mockClear();
      archive.add(s.time, JSON.stringify(s));
      const added = spy.mock.calls.map(([data]) =>
        typeof data === "string" ? data.length : data.byteLength,
      );
      if (added.length) compressing.push(i);
      inputs.push(...added);
      if ([0, 299, 300, 399].includes(i)) expected.set(s.time, s);
    }
  } finally {
    spy.mockRestore();
  }
  const total = inputs.reduce((sum, n) => sum + n, 0);
  // Every appended line is compressed once, so the work over 400 appends is
  // the text those appends wrote rather than that text once per append.
  expect(total).toBeLessThan(4 * 1024 * 1024);
  // No append compresses a run larger than the open limit plus its own line,
  // so a seal cannot become one long pause at the end of a checkpoint.
  expect(Math.max(...inputs)).toBeLessThan(2 * 1024 * 1024);
  expect(compressing.length).toBeLessThan(10);
  for (const [time, snapshot] of expected)
    expect(archive.at(time)).toEqual(snapshot);
});
