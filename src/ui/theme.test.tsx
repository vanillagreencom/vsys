import { expect, test } from "bun:test";
import {
  type BaseRenderable,
  InputRenderable,
  RGBA,
  TextAttributes,
} from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { defaults } from "../config/config";
import { History } from "../store/history";
import {
  emptySnapshot,
  everyCauseSnapshot,
  laneSnapshot,
} from "../test/fixture";
import { mount, onScreen, shown } from "../test/harness";
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
    // The marker sits on a reversed row, so it is read as the reader sees it.
    expect(marker && onScreen(marker).glyph).toBe(
      shown(RGBA.fromIndex(6), "fg"),
    );
    expect(escaped && onScreen(escaped).glyph).toBe(
      shown(RGBA.fromIndex(1), "fg"),
    );
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

test("every colour a screen paints is a terminal colour from the role table", async () => {
  const c = defaults();
  const screen = await mount(everyCauseSnapshot(c), c, {
    width: 160,
    height: 44,
  });
  // A fixed rgb, the library's white included, carries the rgb intent. Its
  // value can equal a role's, since the default foreground also holds white,
  // so the guard reads the intent and never the value.
  const known = (colour: RGBA) =>
    colour.intent === "default" ||
    (colour.intent === "indexed" && palette.some((p) => p.equals(colour)));
  const strangers: string[] = [];
  const sweep = (state: string) => {
    for (const line of screen.ui.captureSpans().lines)
      for (const span of line.spans) {
        const at = `${state}: ${JSON.stringify(span.text.slice(0, 20))}`;
        // A blank cell still shows its background.
        if (!known(span.bg)) strangers.push(`${at} bg`);
        if (!span.text.trim()) continue;
        if (!known(span.fg)) strangers.push(`${at} fg`);
        // Text in its own background colour is on the screen and unreadable.
        const seen = onScreen(span);
        if (seen.glyph === seen.cell) strangers.push(`${at} fg is bg`);
      }
  };
  try {
    // Every tab and the help panel: no screen picks a colour of its own.
    for (const key of ["1", "2", "3", "4", "5", "6", "7", "?"]) {
      await screen.press(key);
      sweep(key);
    }
    await screen.press("escape");
    // A search box, empty and then typed into, and a setting being edited:
    // the input draws its own text, placeholder and cursor.
    await screen.press("2");
    await screen.press("/");
    expect(screen.frame()).toContain("name, process id");
    sweep("agents search");
    await screen.press("l");
    sweep("agents search typed");
    await screen.press("escape");
    await screen.press("7");
    await screen.press("/");
    expect(screen.frame()).toContain("name or label");
    sweep("settings search");
    await screen.press("escape");
    await screen.press("enter");
    sweep("settings edit");
    await screen.press("escape");
    // Text dragged over with the mouse is painted as a selection.
    await screen.press("1");
    await act(async () => {
      await screen.ui.mockMouse.drag(2, 3, 60, 3);
    });
    await screen.ui.renderOnce();
    sweep("mouse selection");
    expect(strangers).toEqual([]);
  } finally {
    await screen.close();
  }
});

test("a mouse selection shows in the selection grey, in a line and in an input", async () => {
  const c = defaults();
  const screen = await mount(everyCauseSnapshot(c), c, {
    width: 160,
    height: 44,
  });
  // The cell at column x of row y once the mouse has dragged across it.
  const dragged = async (x: number, y: number) => {
    await act(async () => {
      await screen.ui.mockMouse.drag(x, y, x + 1, y);
    });
    await screen.ui.renderOnce();
    let column = 0;
    for (const span of screen.ui.captureSpans().lines[y]?.spans ?? []) {
      column += span.width;
      if (column > x) return span;
    }
    return undefined;
  };
  try {
    await screen.ui.renderOnce();
    const home = screen.frame().split("\n");
    const at = home.findIndex((row) => row.includes(" agents · "));
    expect(at).toBeGreaterThan(-1);
    const text = await dragged((home[at] ?? "").indexOf("agents"), at);
    // The selected cells split off as a span of their own.
    expect(text?.text).toMatch(/^ag/);
    expect(text?.bg.equals(ui.quiet)).toBe(true);
    await screen.press("2");
    await screen.press("/");
    await screen.press("l");
    const rows = screen.frame().split("\n");
    const y = rows.findIndex((row) => row.includes("│l"));
    expect(y).toBeGreaterThan(-1);
    const typed = await dragged((rows[y] ?? "").indexOf("│l") + 1, y);
    expect(typed?.text).toContain("l");
    expect(typed?.bg.equals(ui.quiet)).toBe(true);
  } finally {
    await screen.close();
  }
});

test("an input's cursor keeps the terminal's own cursor colour", async () => {
  const c = defaults();
  const screen = await mount(everyCauseSnapshot(c), c);
  try {
    await screen.press("2");
    await screen.press("/");
    const inputs: InputRenderable[] = [];
    const walk = (node: BaseRenderable) => {
      if (node instanceof InputRenderable) inputs.push(node);
      for (const child of node.getChildren()) walk(child);
    };
    walk(screen.ui.renderer.root);
    expect(inputs.map((input) => input.cursorColor.intent)).toEqual([
      "default",
    ]);
  } finally {
    await screen.close();
  }
});
