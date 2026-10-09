import { expect, test } from "bun:test";
import { defaults } from "../../src/config/config";
import { emptySnapshot, laneSnapshot } from "../../src/test/fixture";
import { mount } from "../../src/test/harness";

// The footer's right side is the machine's standing ("1 concern", "all
// clear", "3 sources unreadable", the retention warning). Footer gives that
// Line flexShrink 0, yet the hints Line beside it keeps its intrinsic width,
// so on Home at 80 columns, the classic terminal width, the standing is cut
// to "1 co" and run into the hints with no blank between them.
test.each([60, 80, 90, 120])(
  "the footer states the machine's standing whole at %i columns",
  async (width) => {
    const c = defaults();
    const s = emptySnapshot();
    s.lanes = [laneSnapshot({ unconfined: true })];
    const t = await mount(s, c, { width, height: 30 });
    try {
      await t.settle();
      const footer = t.frame().split("\n").at(-2) ?? "";
      expect(footer).toMatch(/\s{2}1 concern\s*$/);
    } finally {
      await t.close();
    }
  },
);
