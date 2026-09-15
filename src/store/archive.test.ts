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
  }).toThrow("A history checkpoint exceeds the memory budget");
});
test("an append compresses only the lines that append added", () => {
  const archive = new Archive();
  const inputs: number[] = [];
  const expected = new Map<number, ReturnType<typeof emptySnapshot>>();
  let text = 0;
  let longest = 0;
  const spy = spyOn(Bun, "gzipSync");
  try {
    for (let i = 0; i < 400; i++) {
      const s = emptySnapshot(1000 + i * 1000);
      // A fresh long path each sample. At about twelve thousand code units a
      // sample, a three-hundred-sample checkpoint writes about three and a
      // half times the open-run limit, so its run seals three times over and
      // a fourth time as the checkpoint rolls over.
      s.procs = [processSnapshot({ cwd: `/work/${String(i).repeat(4096)}` })];
      const json = JSON.stringify(s);
      text += json.length;
      longest = Math.max(longest, json.length);
      archive.add(s.time, json);
      if ([0, 299, 300, 399].includes(i)) expected.set(s.time, s);
    }
    inputs.push(
      ...spy.mock.calls.map(([data]) =>
        typeof data === "string" ? data.length : data.byteLength,
      ),
    );
  } finally {
    spy.mockRestore();
  }
  const total = inputs.reduce((sum, n) => sum + n, 0);
  // Every appended line is compressed once, so the work over 400 appends is
  // the text those appends wrote rather than that text once per append. A
  // delta line is shorter than the snapshot it came from, which is the only
  // bound on a line this fixture knows.
  expect(total).toBeLessThanOrEqual(text);
  // A seal takes the open run, which is the open-run limit plus the one line
  // that crossed it. Nothing lets it reach the whole checkpoint, so a seal
  // cannot become one long pause at the end of one.
  expect(Math.max(...inputs)).toBeLessThanOrEqual(1024 * 1024 + longest);
  // Four seals in the first checkpoint and one in the hundred-sample second,
  // which is the text those appends wrote divided by the open-run limit.
  expect(inputs).toHaveLength(5);
  for (const [time, snapshot] of expected)
    expect(archive.at(time)).toEqual(snapshot);
});
test("replay and lane charts read a sealed line at the line it is", () => {
  // Both readers convert a checkpoint line number into a position inside one
  // inflated segment. That conversion is exercised only where a whole sealed
  // segment lies before the line asked for, so every case here fills one
  // checkpoint past its open-run limit before it reads anything back.
  type Snapshot = ReturnType<typeof emptySnapshot>;
  const build = (): { archive: Archive; expected: Map<number, Snapshot> } => {
    const archive = new Archive();
    const expected = new Map<number, Snapshot>();
    for (let i = 0; i < 300; i++) {
      const s = emptySnapshot(1000 + i * 1000);
      s.procs = [processSnapshot({ cwd: `/work/${String(i).repeat(4096)}` })];
      s.lanes = [laneSnapshot({ cpu: i, rss: 4096 * i })];
      archive.add(s.time, JSON.stringify(s));
      expected.set(s.time, s);
    }
    return { archive, expected };
  };
  const { archive, expected } = build();
  // Backwards first, which drops the cursor and rebuilds it from the base
  // line, then forwards over every sample, which walks the cursor across
  // each sealed segment in turn.
  for (const [time, snapshot] of [...expected].reverse())
    expect(archive.at(time)).toEqual(snapshot);
  for (const [time, snapshot] of expected)
    expect(archive.at(time)).toEqual(snapshot);

  const id = laneSnapshot().id;
  const warm = build().archive;
  // A first read caches the chart up to the newest sample; later samples seal
  // the run that read left open, so the second read starts inside a segment.
  warm.laneWindow(id, 0, 150000);
  for (let i = 300; i < 380; i++) {
    const s = emptySnapshot(1000 + i * 1000);
    s.procs = [processSnapshot({ cwd: `/work/${String(i).repeat(4096)}` })];
    s.lanes = [laneSnapshot({ cpu: i, rss: 4096 * i })];
    warm.add(s.time, JSON.stringify(s));
  }
  const cold = build().archive;
  for (let i = 300; i < 380; i++) {
    const s = emptySnapshot(1000 + i * 1000);
    s.procs = [processSnapshot({ cwd: `/work/${String(i).repeat(4096)}` })];
    s.lanes = [laneSnapshot({ cpu: i, rss: 4096 * i })];
    cold.add(s.time, JSON.stringify(s));
  }
  const series = warm.laneWindow(id, 0, 380000);
  expect(series).toHaveLength(380);
  expect(series).toEqual(cold.laneWindow(id, 0, 380000));
  expect(series[299].cpu).toBe(299);
});
test("reading every retained sample inflates each sealed segment once", () => {
  // Replay walks forward, so it reaches each line once. Rebuilding the reader
  // per sample instead would inflate the segment it stands in once per
  // sample, and the whole walk runs inside the settings change that turns
  // SQLite on, where the screen stops drawing and stops taking keys until it
  // finishes.
  const archive = new Archive();
  for (let i = 0; i < 400; i++) {
    const s = emptySnapshot(1000 + i * 1000);
    s.procs = [processSnapshot({ cwd: `/work/${String(i).repeat(4096)}` })];
    archive.add(s.time, JSON.stringify(s));
  }
  const spy = spyOn(Bun, "gunzipSync");
  let rows = 0;
  let inflations = 0;
  try {
    for (const _ of archive.rows(0)) rows++;
    inflations = spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
  expect(rows).toBe(400);
  // Five sealed segments, and one more inflation each time the walk crosses
  // from the segment it holds into the next, which it can do once per
  // segment. Ten is that ceiling; four hundred is a reader per sample.
  expect(inflations).toBeLessThanOrEqual(10);
});
test("a checkpoint that rolled over is charged what it compressed to", () => {
  // A sealed run is compressed text, not the open text it was charged as
  // while it was still taking lines. An archive that kept charging the open
  // size would evict inside a budget it never reached, and the screen would
  // report a shortened window on a machine that had room for the whole one.
  // Three megabytes, against an open run that peaks near two and sealed runs
  // of repeated text that compress to almost nothing. Charging each of the
  // four rolled-over checkpoints its open size instead reaches four.
  const archive = new Archive(3 * 1024 * 1024);
  for (let i = 0; i < 1200; i++) {
    const s = emptySnapshot(1000 + i * 1000);
    s.procs = [processSnapshot({ cwd: `/work/${String(i).repeat(4096)}` })];
    archive.add(s.time, JSON.stringify(s));
  }
  expect(archive.shortened).toBe(false);
  expect(archive.at(1000)?.time).toBe(1000);
  // A copy carries the open run of the checkpoint it copied and never appends
  // to that checkpoint, so the copy is the other way a run has to be sealed.
  const copy = archive.copy(0);
  for (let i = 1200; i < 1700; i++) {
    const s = emptySnapshot(1000 + i * 1000);
    s.procs = [processSnapshot({ cwd: `/work/${String(i).repeat(4096)}` })];
    copy.add(s.time, JSON.stringify(s));
  }
  expect(copy.shortened).toBe(false);
  expect(copy.at(1000)?.time).toBe(1000);
});
