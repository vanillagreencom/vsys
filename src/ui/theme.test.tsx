import { expect, test } from "bun:test";
import { RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { defaults } from "../config/config";
import { History } from "../store/history";
import {
  emptySnapshot,
  everyCauseSnapshot,
  laneSnapshot,
} from "../test/fixture";
import { App } from "./App";
import { levelColor, metric, palette, readingWeight, ui } from "./theme";

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

test("one role per colour: severity, action and metric never share an index", () => {
  const roles: [string, RGBA][] = [
    ["ok", ui.ok],
    ["warn", ui.warn],
    ["danger", ui.danger],
    ["accent", ui.accent],
    ["quiet", ui.quiet],
    ...Object.entries(metric),
  ];
  // Two roles on one index would make a reader decode the same colour twice.
  for (const [name, colour] of roles) {
    const sharing = roles.filter(([, other]) => other.equals(colour));
    expect({ name, sharing: sharing.length }).toEqual({ name, sharing: 1 });
  }
  // The palette is what the screen guard admits, so every role is in it.
  for (const [name, colour] of roles)
    expect({ name, known: palette.some((p) => p.equals(colour)) }).toEqual({
      name,
      known: true,
    });
});

test("a zero reading recedes and a reading of any size keeps its weight", () => {
  const rows: [number | null | undefined, boolean][] = [
    [0, true],
    [null, true],
    [undefined, true],
    [0.1, false],
    [100, false],
    [-1, false],
  ];
  for (const [value, dim] of rows)
    expect({ value, dim: readingWeight(value) === ui.dim }).toEqual({
      value,
      dim,
    });
});

test("every colour a screen paints comes from the role table", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const h = new History(c);
  h.add(s);
  const screen = await testRender(
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
    { width: 160, height: 44 },
  );
  // A span with no colour of its own inherits one, and the capture reports
  // that as a resolved rgb rather than the default intent, so the guard
  // compares what was painted. The test above pins the intents.
  const known = (colour: RGBA) =>
    palette.some(
      (role) =>
        role.r === colour.r &&
        role.g === colour.g &&
        role.b === colour.b &&
        role.a === colour.a,
    );
  try {
    const strangers: string[] = [];
    // Every tab, then the agent detail and the help panel: no screen picks a
    // colour of its own, and none picks one by row order.
    for (const key of ["1", "2", "3", "4", "5", "6", "7", "?"]) {
      await act(async () => {
        screen.mockInput.pressKey(key);
      });
      await screen.renderOnce();
      for (const line of screen.captureSpans().lines)
        for (const span of line.spans) {
          if (!span.text.trim()) continue;
          for (const colour of [span.fg, span.bg])
            if (!known(colour))
              strangers.push(
                `${key}: ${JSON.stringify(span.text.slice(0, 20))}`,
              );
        }
    }
    expect(strangers).toEqual([]);
  } finally {
    await act(async () => {
      screen.renderer.destroy();
    });
    h.close();
  }
});
