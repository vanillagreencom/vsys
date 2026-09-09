import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { meters } from "../model/verdict";
import { emptySnapshot, laneSnapshot, processSnapshot } from "../test/fixture";
import { buildLines, fleetTotal } from "./builds";
import { meterLine } from "./overview";

const c = defaults();
function busy() {
  const s = emptySnapshot();
  s.system.cores = 32;
  s.lanes = [laneSnapshot({ id: "a", name: "lane-a", pids: [10, 11, 12] })];
  s.procs = [
    processSnapshot({ pid: 10, build: "rustc" }),
    processSnapshot({ pid: 11, build: "rustc" }),
    processSnapshot({ pid: 12, build: "ld.mold" }),
  ];
  return s;
}

test("the fleet total leads the view and repeats the Overview meter exactly", () => {
  const s = busy();
  const lines = buildLines(s, c);
  const meter = meters(s, c).find((m) => m.id === "builds");
  if (!meter) throw new Error("Missing build meter");
  expect(lines[0]).toBe(
    "Build slots: 3 compile and link processes / 32 cores | 1 linker | 1 building cgroup",
  );
  expect(meterLine(meter, s, c).startsWith(lines[0])).toBe(true);
  expect(lines[0]).toBe(fleetTotal(meter.values));
  // The fleet total comes first, the per lane breakdown after it.
  expect(lines.findIndex((l) => l.includes("lane-a"))).toBeGreaterThan(0);
  expect(lines.find((l) => l.includes("lane-a"))).toBe(
    "  lane-a: 3 compile and link processes, 1 linker (ld.mold)",
  );
});

test("an unread cache says so and a hit rate needs served requests", () => {
  const s = busy();
  expect(buildLines(s, c)).toContain("sccache: not available");
  s.sccache = {
    available: true,
    hits: 90,
    misses: 10,
    sinceStart: { hits: 60, misses: 20, windowMs: 600000 },
    recent: { hits: 0, misses: 0, windowMs: 300000 },
  };
  const lines = buildLines(s, c);
  expect(lines).toContain(
    "sccache since vsys started: 60 hits, 20 misses, 75.0% hit rate over 10m",
  );
  expect(lines).toContain(
    "sccache recently: 0 hits, 0 misses, not available hit rate over 5m",
  );
  expect(lines.join("\n")).not.toContain("?");
});

test("an empty wrapper adds the bypass note naming the lane", () => {
  const s = busy();
  s.procs[0].env = { RUSTC_WRAPPER: "" };
  expect(buildLines(s, c).at(-1)).toBe(
    "sccache is bypassed in lane-a: RUSTC_WRAPPER is empty there, so those compilations never reach the cache.",
  );
});

test("jobserver tokens in use are shown against the pool total", () => {
  const s = busy();
  for (const p of s.procs)
    p.env = { MAKEFLAGS: " -j16 --jobserver-auth=fifo:/tmp/GMfifo42" };
  expect(buildLines(s, c)).toContain(
    "make jobserver /tmp/GMfifo42: 3 of 16 tokens in use",
  );
  for (const p of s.procs)
    p.env = { MAKEFLAGS: " --jobserver-auth=fifo:/tmp/GMfifo42" };
  expect(buildLines(s, c)).toContain(
    "make jobserver /tmp/GMfifo42: 3 of not available tokens in use",
  );
});
