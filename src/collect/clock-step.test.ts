// A clock step during an interval must not change the rates of the sample
// that spans it.
import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { Collector } from "./collector";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

// A clock stepped back 900 ms during a real 1000 ms interval (timesyncd
// correcting after resume) leaves 100 ms between the two wall-clock readings,
// while the monotonic clock still counts the real second.
test("a backward wall-clock step does not multiply cgroup rates", async () => {
  const f = fixture();
  fixtures.push(f);
  f.group("agents.slice/run-lane.scope", [40]);
  f.proc(40, "agents.slice/run-lane.scope", { ticks: 10 });
  const scope = join(f.config.cgroupRoot, "agents.slice/run-lane.scope");
  let wall = 1_000_000;
  let mono = 50_000;
  const now = spyOn(Date, "now").mockImplementation(() => wall);
  const perf = spyOn(performance, "now").mockImplementation(() => mono);
  try {
    const collector = new Collector(f.config, 100, 4096);
    await collector.sample();
    // One real second passes: one core busy, 100 MB written.
    f.write(join(scope, "cpu.stat"), "usage_usec 1001000");
    f.write(
      join(scope, "io.stat"),
      "259:0 rbytes=1000 wbytes=100002000 rios=1 wios=2\n",
    );
    f.proc(40, "agents.slice/run-lane.scope", { ticks: 110 });
    mono += 1000;
    wall += 100; // stepped back 900 ms during that second
    const s = await collector.sample();
    const lane = s.lanes[0];
    const group = s.groups.find(
      (g) => g.path === "agents.slice/run-lane.scope",
    );
    // One core for one second is 100 %, and 100 MB in one second is 100 MB/s.
    expect({
      groupCpu: group?.cpuPercent,
      laneCpu: lane?.cpu,
      processCpu: s.procs[0]?.cpuPercent,
      writeRate: group?.writeRate,
    }).toEqual({
      groupCpu: 100,
      laneCpu: 100,
      processCpu: 100,
      writeRate: 100_000_000,
    });
  } finally {
    now.mockRestore();
    perf.mockRestore();
  }
});
