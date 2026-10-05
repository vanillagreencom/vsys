import { expect, test } from "bun:test";
import { Reader } from "./io";
import { parseSccacheStats, SccacheCollector, SccacheError } from "./sccache";

/** A reader that keeps each error's kind, which a source error's message does not carry. */
class Kinds extends Reader {
  kinds: { source: string; kind: unknown }[] = [];
  override error(source: string, error: unknown): void {
    this.kinds.push({
      source,
      kind: error instanceof SccacheError && error.kind,
    });
    super.error(source, error);
  }
}

/** The shape `sccache --show-stats` prints, including the qualified subsets. */
const stats = (hits: number, misses: number) =>
  `Compile requests                    200
Compile requests executed           190
Cache hits                          ${hits}
Cache hits (Rust)                   ${hits}
Cache misses                        ${misses}
Cache misses (Rust)                 ${misses}
Cache errors                          0
`;

test("qualified cache lines are subsets and never add to the totals", () => {
  expect(parseSccacheStats(stats(80, 40))).toEqual({ hits: 80, misses: 40 });
  expect(parseSccacheStats("Compile requests 3\n")).toBeNull();
  // Qualified lines alone are not totals; a partial reading is not a zero.
  expect(
    parseSccacheStats("Cache hits (Rust)  80\nCache misses (Rust)  40\n"),
  ).toBeNull();
});

test("counters become a delta since start and a five minute delta", async () => {
  let hits = 100;
  let misses = 20;
  const r = new Reader();
  const c = new SccacheCollector(async () => stats(hits, misses), 0, 300000);
  const first = await c.collect(r, 0);
  expect(first.state).toBe("read");
  expect(first.sinceStart).toEqual({ hits: 0, misses: 0, windowMs: 0 });
  hits = 130;
  misses = 30;
  await c.collect(r, 120000);
  hits = 160;
  misses = 60;
  // Ten minutes on: the start delta keeps every request, the window drops the
  // samples older than five minutes.
  const last = await c.collect(r, 600000);
  expect(last.sinceStart).toEqual({ hits: 60, misses: 40, windowMs: 600000 });
  expect(last.recent).toEqual({ hits: 0, misses: 0, windowMs: 0 });
  expect(r.errors).toEqual([]);
});

test("a restarted cache server rebases instead of reporting a negative delta", async () => {
  let text = stats(500, 100);
  const r = new Reader();
  const c = new SccacheCollector(async () => text, 0, 300000);
  await c.collect(r, 0);
  // A restart after the counters have already grown past the startup
  // baseline: comparing with the baseline alone would miss it.
  text = stats(900, 200);
  await c.collect(r, 1000);
  text = stats(600, 150);
  const after = await c.collect(r, 2000);
  expect(after.sinceStart).toEqual({ hits: 0, misses: 0, windowMs: 0 });
  expect(after.recent).toEqual({ hits: 0, misses: 0, windowMs: 0 });
  expect(after.hits).toBe(600);
  // The lifetimes are not mixed: counting continues from the restart.
  text = stats(640, 160);
  const later = await c.collect(r, 3000);
  expect(later.sinceStart).toEqual({ hits: 40, misses: 10, windowMs: 1000 });
});

test("a missing binary is absent, other failures are reported once", async () => {
  const r = new Kinds();
  const absent = Object.assign(new Error("no sccache"), { code: "ENOENT" });
  const missing = new SccacheCollector(async () => {
    throw absent;
  }, 0);
  expect(await missing.collect(r, 0)).toEqual({
    state: "absent",
    hits: null,
    misses: null,
    sinceStart: null,
    recent: null,
  });
  expect(r.errors).toEqual([]);
  const broken = new SccacheCollector(async () => {
    throw new Error("server unreachable");
  }, 0);
  expect((await broken.collect(r, 0)).state).toBe("failed");
  expect(r.kinds).toEqual([{ source: "sccache --show-stats", kind: "failed" }]);
});

test("a wedged cache server times out rather than holding the sample", async () => {
  const r = new Kinds();
  // A query that never answers, standing in for a wedged sccache server. The
  // deadline also reaches it, which is how the real query kills its child.
  const given: number[] = [];
  const wedged = new SccacheCollector(
    (ms) => {
      given.push(ms);
      return new Promise<string>(() => {});
    },
    0,
    300000,
    5,
  );
  const started = Date.now();
  expect((await wedged.collect(r, 0)).state).toBe("failed");
  expect(Date.now() - started).toBeLessThan(2000);
  expect(given).toEqual([5]);
  expect(r.kinds).toEqual([
    { source: "sccache --show-stats", kind: "timeout" },
  ]);
});

test("the stats query is not repeated on every sample", async () => {
  let calls = 0;
  const r = new Reader();
  const c = new SccacheCollector(async () => {
    calls++;
    return stats(1, 1);
  }, 5000);
  await c.collect(r, 0);
  await c.collect(r, 1000);
  await c.collect(r, 4999);
  expect(calls).toBe(1);
  await c.collect(r, 5000);
  expect(calls).toBe(2);
});

test("a failed query keeps its source error on the samples the throttle skips", async () => {
  let calls = 0;
  let answer: string | Error = new Error("server unreachable");
  const c = new SccacheCollector(async () => {
    calls++;
    if (answer instanceof Error) throw answer;
    return answer;
  }, 5000);
  // A fresh reader per sample, as the collector builds one. Each row is the
  // sample time and the kind of error that sample must report.
  const rows: [number, SccacheError["kind"]][] = [
    [0, "failed"],
    [1000, "failed"],
    [4999, "failed"],
    [5000, "malformed"],
    [9999, "malformed"],
  ];
  for (const [time, kind] of rows) {
    if (time === 1000) answer = "Compile requests 3\n";
    const r = new Kinds();
    expect((await c.collect(r, time)).state).toBe("failed");
    expect(r.kinds).toEqual([{ source: "sccache --show-stats", kind }]);
  }
  expect(calls).toBe(2);
  // A query that reads the counters clears the error on its sample and the
  // skipped ones.
  answer = stats(1, 1);
  for (const time of [10000, 14999]) {
    const r = new Reader();
    expect((await c.collect(r, time)).state).toBe("read");
    expect(r.errors).toEqual([]);
  }
  expect(calls).toBe(3);
  // So does a query that finds no sccache after a failure: the program is
  // absent, and the old error is not kept.
  answer = new Error("server unreachable");
  expect((await c.collect(new Reader(), 15000)).state).toBe("failed");
  answer = Object.assign(new Error("no sccache"), { code: "ENOENT" });
  for (const time of [20000, 24999]) {
    const r = new Reader();
    expect((await c.collect(r, time)).state).toBe("absent");
    expect(r.errors).toEqual([]);
  }
  expect(calls).toBe(5);
});
