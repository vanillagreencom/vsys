// Cloud defect review 8, finding: a member that exits between the
// cgroup.procs read and the /proc walk blanks the lane.
// Run from the repository root: bun test review/tests/exited-member.test.ts
import { afterEach, expect, test } from "bun:test";
import { Collector } from "../../src/collect/collector";
import { buildLoad } from "../../src/model/verdict";
import { laneBuilds } from "../../src/model/builds";
import { fixture } from "../../src/test/fixture";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

// cgroup.procs lists 40, 41 and 42. 42 is a short-lived shell command the
// agent ran, which exited before the process walk reached it, so /proc has
// no directory for it. The process read is complete and records no error:
// every process that exists was read.
test("a member that exited before the process walk leaves the lane's totals known", async () => {
  const f = fixture();
  fixtures.push(f);
  const scope = "agents.slice/run-lane.scope";
  f.group(scope, [40, 41, 42]);
  f.proc(40, scope, { ticks: 10 });
  f.proc(41, scope, {
    command: ["rustc", "--crate-name", "x"],
    comm: "rustc",
    parent: 40,
  });
  const s = await new Collector(f.config, 100, 4096).sample(1000);
  expect([s.processRead, s.errors]).toEqual(["complete", []]);
  const lane = s.lanes[0];
  const fleet = buildLoad(s, f.config);
  const row = laneBuilds(s, f.config).find((r) => r.id === scope);
  expect({
    fleetBuilds: fleet.builds,
    laneRowBuilds: row?.builds,
    rustc: lane?.rustc,
    rss: lane?.rss,
    age: lane?.age === null ? null : "known",
    state: lane?.state,
  }).toEqual({
    fleetBuilds: 1,
    laneRowBuilds: 1,
    rustc: 1,
    rss: 2 * 10 * 4096,
    age: "known",
    state: "sleeping",
  });
});
