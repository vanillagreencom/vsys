import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { Footer } from "./chrome";

// The status is the machine's standing on every screen. A hint list longer
// than the row once kept its width and pushed the status past the edge, cut
// and run into the last hint with no blank between them.
test.each([60, 80, 90, 120])(
  "the footer keeps the standing whole after a gap at %i columns",
  async (width) => {
    const hints: [string, string][] = Array.from({ length: 8 }, (_, i) => [
      `k${i}`,
      `action ${i}`,
    ]);
    const status = "standing";
    const screen = await testRender(<Footer hints={hints} status={status} />, {
      width,
      height: 1,
    });
    try {
      await screen.renderOnce();
      const row = screen.captureCharFrame().split("\n")[0] ?? "";
      expect(row.trimEnd().endsWith(`  ${status}`)).toBe(true);
    } finally {
      await act(async () => {
        screen.renderer.destroy();
      });
    }
  },
);
