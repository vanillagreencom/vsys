import { expect, test } from "bun:test";
import { defaults } from "../../src/config/config";
import { emptySnapshot } from "../../src/test/fixture";
import { mount } from "../../src/test/harness";

// The collector publishes processRead "unknown" with no processes when the
// process read misses its deadline (collector.ts readProcesses). Only a
// process names an escaped agent's lane, so those lanes are gone from the
// sample, and the model treats every process-derived count as unknown
// (buildLoad, processesUnread). Home's count line still states s.lanes.length
// as a fact.
test("Home does not count agents as a fact when no process was read", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.processRead = "unknown";
  s.procs = [];
  s.lanes = [];
  s.errors = [
    {
      source: "/proc",
      message: "the process read did not finish within 5000 ms",
    },
  ];
  const t = await mount(s, c, { width: 120, height: 40 });
  try {
    await t.settle();
    const frame = t.frame();
    expect(frame).not.toMatch(/\b0 agents\b/);
  } finally {
    await t.close();
  }
});
