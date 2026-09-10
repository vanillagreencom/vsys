import { expect, test } from "bun:test";
import { RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { defaults } from "../config/config";
import { History } from "../store/history";
import { emptySnapshot, laneSnapshot } from "../test/fixture";
import { App } from "./App";
import { levelColor, ui } from "./theme";

test("the screen uses the terminal's own colours and marks selection in the accent", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ name: "lane-a" }),
    laneSnapshot({ id: "b", name: "lane-b", unconfined: true }),
  ];
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
      onAction={async () => {}}
      output={{ write: () => {} }}
    />,
    { width: 140, height: 35 },
  );
  try {
    await act(async () => {
      ui.mockInput.pressKey("2");
    });
    await ui.renderOnce();
    const spans = ui.captureSpans().lines.flatMap((line) => line.spans);
    const host = spans.find((span) => span.text.includes("fixture"));
    const marker = spans.find((span) => span.text === "▍");
    const escaped = spans.find((span) => span.text.includes("lane-b"));
    const heading = spans.find((span) => span.text.includes("2 agents"));
    expect(host?.fg.intent).toBe("default");
    expect(host?.bg.intent).toBe("default");
    expect(marker?.fg.equals(RGBA.fromIndex(6))).toBe(true);
    expect(escaped?.fg.equals(RGBA.fromIndex(1))).toBe(true);
    expect((heading?.attributes ?? 0) & TextAttributes.BOLD).not.toBe(0);
    // No visible span carries a colour outside the sixteen the terminal owns.
    for (const span of spans.filter((span) => span.text.trim())) {
      for (const colour of [span.fg, span.bg])
        expect(["default", "indexed"]).toContain(colour.intent);
    }
  } finally {
    await act(async () => {
      ui.renderer.destroy();
    });
    h.close();
  }
});

test("each severity has one colour and an untroubled reading keeps the default", () => {
  expect(levelColor("ok")).toBe(ui.fg);
  expect(levelColor("warn").equals(RGBA.fromIndex(3))).toBe(true);
  expect(levelColor("danger").equals(RGBA.fromIndex(1))).toBe(true);
});
