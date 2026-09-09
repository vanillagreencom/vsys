import { expect, test } from "bun:test";
import { RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { defaults } from "../config/config";
import { History } from "../store/history";
import { emptySnapshot, laneSnapshot } from "../test/fixture";
import { App } from "./App";

test("rendered presets and terminal colours preserve readable text and selection", async () => {
  for (const theme of ["terminal", "light", "dark"] as const) {
    const c = { ...defaults(), theme };
    const s = emptySnapshot();
    s.lanes = [laneSnapshot()];
    const h = new History(c);
    h.add(s);
    const ui = await testRender(
      <App
        snapshot={s}
        history={h}
        config={c}
        onSave={async () => {}}
        onQuit={() => {}}
        onExport={async () => "snapshot.json"}
      />,
      { width: 140, height: 35 },
    );
    try {
      await act(async () => {
        ui.mockInput.pressKey("1");
      });
      await ui.renderOnce();
      const spans = ui.captureSpans().lines.flatMap((line) => line.spans);
      const title = spans.find((span) => span.text.includes("fixture"));
      const selected = spans.find((span) => span.text.includes("lane-a"));
      expect(title).toBeDefined();
      expect(selected).toBeDefined();
      if (theme === "terminal") {
        expect(title?.fg.intent).toBe("default");
        expect(title?.bg.intent).toBe("default");
        expect((selected?.attributes ?? 0) & TextAttributes.INVERSE).not.toBe(
          0,
        );
      } else {
        expect(
          title?.fg.equals(
            RGBA.fromHex(theme === "light" ? "#202020" : "#dce2eb"),
          ),
        ).toBe(true);
        expect(
          title?.bg.equals(
            RGBA.fromHex(theme === "light" ? "#f5f5f5" : "#171b22"),
          ),
        ).toBe(true);
      }
    } finally {
      await act(async () => {
        ui.renderer.destroy();
      });
      h.close();
    }
  }
});
