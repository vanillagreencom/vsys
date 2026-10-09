import { expect, test } from "bun:test";
import { defaults } from "../../src/config/config";
import { emptySnapshot, laneSnapshot } from "../../src/test/fixture";
import { mount } from "../../src/test/harness";

// The process read was incomplete, so the build processes outside every lane
// are unknown: the "outside the watched lanes" row draws "not available".
// Opening it lists the processes of that row with a count in its heading.
test("an unknown build count opened on Builds does not draw a zero", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.processRead = "incomplete";
  s.lanes = [laneSnapshot({ builds: null })];
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press(c.keys.builds);
    const before = t.frame();
    if (process.env.SHOW) console.log(before);
    expect(before).toContain("not available");
    await t.press("enter");
    const frame = t.frame();
    if (process.env.SHOW) console.log(frame);
    const heading = frame
      .split("\n")
      .find((line) => line.includes("Processes in"));
    expect(heading).toBeDefined();
    expect(heading).not.toMatch(/Processes in [^─]*\s0\s/);
  } finally {
    await t.close();
  }
});
