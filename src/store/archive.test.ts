import { expect, spyOn, test } from "bun:test";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import { Archive } from "./archive";

type Sample = ReturnType<typeof emptySnapshot>;

/**
 * One sample carrying a path long enough that a checkpoint's deltas cross the
 * open-run limit several times. That width is what makes the cases below seal
 * at all, so it lives here rather than in each of them.
 */
function sample(i: number): Sample {
  const s = emptySnapshot(1000 + i * 1000);
  s.procs = [processSnapshot({ cwd: `/work/${String(i).repeat(4096)}` })];
  s.lanes = [laneSnapshot({ cpu: i, rss: 4096 * i })];
  return s;
}

/**
 * The archive's checkpoints. Reaching in is the shortest way to read back what
 * the cases below claim: the alternative to counting a checkpoint's lines is a
 * budget wide enough to evict on, and the alternative to counting its segments
 * is a literal that drifts from the archive it was derived on.
 */
function checkpoints(archive: Archive) {
  // Element access rather than a cast, so a rename of the field or a change
  // to what a checkpoint holds is a compile error here and not a throw. The
  // dotted form the lint asks for does not compile: the field is private.
  // biome-ignore lint/complexity/useLiteralKeys: reads a private field
  return archive["chunks"];
}

/**
 * Lines held by any checkpoint but the one still taking them. Only that last
 * checkpoint may hold lines it has not sealed; every earlier one was sealed as
 * the archive moved past it.
 */
function unsealed(archive: Archive): number {
  return checkpoints(archive)
    .slice(0, -1)
    .reduce((n, c) => n + c.open.length, 0);
}

/** Sealed segments across every checkpoint, which is what one walk inflates. */
function segments(archive: Archive): number {
  return checkpoints(archive).reduce((n, c) => n + c.segments.length, 0);
}

/** Append samples `from` up to but not including `to`, and keep each one. */
function extend(
  archive: Archive,
  from: number,
  to: number,
): Map<number, Sample> {
  const added = new Map<number, Sample>();
  for (let i = from; i < to; i++) {
    const s = sample(i);
    archive.add(s.time, JSON.stringify(s));
    added.set(s.time, s);
  }
  return added;
}

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
  const expected = new Map<number, Sample>();
  let text = 0;
  let longest = 0;
  const spy = spyOn(Bun, "gzipSync");
  try {
    for (let i = 0; i < 400; i++) {
      const s = sample(i);
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
  const archive = new Archive();
  const expected = extend(archive, 0, 300);
  // Backwards first, which drops the cursor and rebuilds it from the base
  // line, then forwards over every sample, which walks the cursor across
  // each sealed segment in turn.
  for (const [time, snapshot] of [...expected].reverse())
    expect(archive.at(time)).toEqual(snapshot);
  for (const [time, snapshot] of expected)
    expect(archive.at(time)).toEqual(snapshot);

  const id = laneSnapshot().id;
  const warm = new Archive();
  extend(warm, 0, 300);
  // A first read caches the chart up to the newest sample; later samples seal
  // the run that read left open, so the second read starts inside a segment.
  warm.laneWindow(id, 0, 150000);
  extend(warm, 300, 380);
  const cold = new Archive();
  extend(cold, 0, 300);
  extend(cold, 300, 380);
  const series = warm.laneWindow(id, 0, 380000);
  expect(series).toHaveLength(380);
  expect(series).toEqual(cold.laneWindow(id, 0, 380000));
  expect(series[299].cpu).toBe(299);
});
test("a run sealing under a parked cursor does not corrupt what it reads", () => {
  // A reader pins a sample and leaves it pinned while samples keep arriving.
  // The open run crosses its limit under that parked cursor, which moves
  // where the open run starts, and every later read on that checkpoint reuses
  // the cursor. A cursor that did not notice the seal reads the wrong line
  // and hands the pane a snapshot that is wrong with nothing reddening.
  const archive = new Archive();
  const expected = extend(archive, 0, 60);
  expect(archive.at(60000)).toEqual(expected.get(60000) ?? null);
  for (const [time, snapshot] of extend(archive, 60, 200))
    expected.set(time, snapshot);
  for (const [time, snapshot] of expected)
    if (time >= 60000) expect(archive.at(time)).toEqual(snapshot);
});
test("reading every retained sample inflates each sealed segment once", () => {
  // Replay walks forward, so it reaches each line once. Rebuilding the reader
  // per sample instead would inflate the segment it stands in once per
  // sample, and the whole walk runs inside the settings change that turns
  // SQLite on, where the screen stops drawing and stops taking keys until it
  // finishes.
  const archive = new Archive();
  extend(archive, 0, 400);
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
  // Crossing into a segment is the inflation, so a forward walk pays one per
  // segment and the archive it just built says how many that is. A reader
  // rebuilt per sample pays four hundred.
  expect(inflations).toBe(segments(archive));
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
  extend(archive, 0, 150);
  // A copy carries the open run of the checkpoint it copied and never appends
  // to that checkpoint, so the copy is the other way that run has to be
  // sealed. One append is the whole of what that takes.
  const copy = archive.copy(0);
  extend(archive, 150, 1200);
  expect(archive.shortened).toBe(false);
  expect(archive.at(1000)?.time).toBe(1000);
  expect(unsealed(archive)).toBe(0);
  extend(copy, 150, 151);
  expect(unsealed(copy)).toBe(0);
  expect(copy.at(1000)?.time).toBe(1000);
});
