import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, laneSnapshot, processSnapshot } from "../test/fixture";
import {
  buildsSummary,
  bypassedLanes,
  hitRate,
  jobservers,
  laneBuilds,
} from "./builds";
import type { Sccache, Snapshot } from "./types";
import { buildLoad, meters } from "./verdict";

const c = defaults();
/** Two lanes compiling, one of them linking, plus a build outside every lane. */
function building(): Snapshot {
  const s = emptySnapshot();
  s.system.cores = 32;
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", pids: [10, 11, 12] }),
    laneSnapshot({ id: "b", name: "lane-b", pids: [20, 21] }),
  ];
  s.procs = [
    processSnapshot({ pid: 10, build: "rustc" }),
    processSnapshot({ pid: 11, build: "rustc" }),
    processSnapshot({ pid: 12, build: "ld.mold" }),
    processSnapshot({ pid: 20, build: "cargo" }),
    processSnapshot({ pid: 21, build: "mold" }),
    // A build outside every watched lane, and a process that is not a build.
    processSnapshot({ pid: 30, build: "cc", group: "/app.slice/make.scope" }),
    processSnapshot({ pid: 31, build: null }),
  ];
  return s;
}

test("the per lane rows sum to the fleet total the Overview meter shows", () => {
  const s = building();
  const summary = buildsSummary(s, c);
  const meter = meters(s, c).find((m) => m.id === "builds");
  expect(summary.builds).toBe(buildLoad(s, c).builds);
  expect(meter?.values.builds).toBe(summary.builds);
  expect(meter?.values.linkers).toBe(summary.linkers);
  expect(summary.cores).toBe(32);
  expect(summary.rows.reduce((n, row) => n + row.builds, 0)).toBe(
    summary.builds,
  );
  expect(summary.rows.reduce((n, row) => n + row.linkers, 0)).toBe(
    summary.linkers,
  );
});

test("linkers are counted and named apart from the compilers in each lane", () => {
  const rows = laneBuilds(building(), c);
  expect(rows.map((row) => [row.name, row.builds, row.linkers])).toEqual([
    ["lane-a", 3, 1],
    ["lane-b", 2, 1],
    ["", 1, 0],
  ]);
  expect(rows[0].linkerNames).toEqual(["ld.mold"]);
  expect(rows[2].linkerNames).toEqual([]);
});

test("an empty compiler wrapper names the lane that bypasses the cache", () => {
  const s = building();
  const find = (pid: number) => {
    const p = s.procs.find((x) => x.pid === pid);
    if (!p) throw new Error("Missing fixture process");
    return p;
  };
  find(10).env = { RUSTC_WRAPPER: "" };
  find(20).env = { RUSTC_WRAPPER: "/usr/bin/sccache" };
  // An unreadable environment is not evidence of a bypass.
  Object.assign(find(30), { env: { RUSTC_WRAPPER: "" }, envAvailable: false });
  expect(bypassedLanes(s)).toEqual(["lane-a"]);
  const reading: Sccache = {
    available: true,
    hits: 90,
    misses: 10,
    sinceStart: { hits: 9, misses: 1, windowMs: 60000 },
    recent: { hits: 3, misses: 1, windowMs: 30000 },
  };
  s.sccache = reading;
  const cache = buildsSummary(s, c).cache;
  expect(cache.available).toBe(true);
  expect(cache.sinceStart?.rate).toBeCloseTo(90);
  expect(cache.recent?.rate).toBeCloseTo(75);
  expect(cache.bypassed).toEqual(["lane-a"]);
});

test("a cache that served nothing has no hit rate and no reading is unavailable", () => {
  expect(hitRate(0, 0)).toBeNull();
  expect(hitRate(1, 3)).toBe(25);
  const cache = buildsSummary(building(), c).cache;
  expect(cache.available).toBe(false);
  expect(cache.sinceStart).toBeNull();
});

test("a make jobserver reports tokens in use against the pool it was given", () => {
  const s = building();
  const flags = " -j16 --jobserver-auth=fifo:/tmp/GMfifo42";
  for (const pid of [10, 11, 12]) {
    const p = s.procs.find((x) => x.pid === pid);
    if (p) p.env = { MAKEFLAGS: flags };
  }
  // A second pool without -j leaves its total unknown rather than zero.
  const other = s.procs.find((x) => x.pid === 20);
  if (other) other.env = { MAKEFLAGS: "w --jobserver-auth=fifo:/tmp/GMfifo7" };
  expect(jobservers(s)).toEqual([
    { fifo: "/tmp/GMfifo42", total: 16, inUse: 3 },
    { fifo: "/tmp/GMfifo7", total: null, inUse: 1 },
  ]);
});

test("only the outermost holder of a token pool is counted", () => {
  const s = building();
  const flags = " -j4 --jobserver-auth=fifo:/tmp/GMfifo42";
  const p = (pid: number, ppid: number, build: string | null, env = flags) =>
    processSnapshot({ pid, ppid, build, env: { MAKEFLAGS: env } });
  // make -> two cc, and under one of them collect2 -> ld. MAKEFLAGS is
  // inherited by all of them and only the unclassified collect2 breaks the
  // chain, so the two compilers hold the pool and the linker does not.
  s.procs = [
    p(5, 1, null),
    p(10, 5, "cc"),
    p(11, 5, "cc"),
    p(12, 10, null),
    p(13, 12, "ld.mold"),
    // A second pool nested under the first is its own holder.
    p(14, 10, "cc", " -j2 --jobserver-auth=fifo:/tmp/GMfifo7"),
  ];
  const pools = jobservers(s);
  expect(pools).toEqual([
    { fifo: "/tmp/GMfifo42", total: 4, inUse: 2 },
    { fifo: "/tmp/GMfifo7", total: 2, inUse: 1 },
  ]);
  for (const pool of pools)
    expect(pool.inUse).toBeLessThanOrEqual(pool.total ?? 0);
});

test("a pipe jobserver and a missing environment produce no token pool", () => {
  const s = building();
  const p = s.procs[0];
  p.env = { MAKEFLAGS: " -j16 --jobserver-auth=3,4" };
  expect(jobservers(s)).toEqual([]);
});
