import { expect, test } from "bun:test";
import { defaults } from "../../src/config/config";
import { emptySnapshot, groupSnapshot } from "../../src/test/fixture";
import { mount } from "../../src/test/harness";
import { groupCause } from "../../src/ui/resources";

// A group whose stall files and memory.current could not be read (collectGroups
// stores null for each) has no threshold input at all. groupCause skips every
// null and answers null, which causeText words as "nothing over a threshold"
// and groupLevel draws as "ok": a check that never ran reads as one passed.
test("a group with no readable threshold input is not called clear of every threshold", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const g = groupSnapshot({
    cpuPercent: 5,
    memory: null,
    high: 100,
    pressure: { cpu: null, memory: null, io: null },
  });
  s.groups = [g];
  expect(groupCause(g, s, c)).toBeNull();
  const t = await mount(s, c, { width: 100, height: 40 });
  try {
    await t.press("3");
    const status =
      t
        .frame()
        .split("\n")
        .find((line) => line.includes("Status")) ?? "";
    expect(status).not.toContain("nothing over a threshold");
  } finally {
    await t.close();
  }
});
