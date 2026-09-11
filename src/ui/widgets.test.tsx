import { expect, test } from "bun:test";
import { type RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { onScreen, shown } from "../test/harness";
import { metric, ui } from "./theme";
import {
  Bar,
  bar,
  chartRows,
  gapRuns,
  Ink,
  Line,
  List,
  listWindow,
  nextDown,
  Row,
  Sparkline,
  tilesPerRow,
} from "./widgets";

test("a bar fills in proportion, clamps at its width, and stays empty when unread", () => {
  const rows: [number | null, number, number, string][] = [
    [50, 100, 10, "█████"],
    [150, 100, 10, "██████████"],
    [0, 100, 10, ""],
    [null, 100, 10, ""],
    [5, 0, 10, ""],
    [5, 10, 0, ""],
  ];
  for (const [value, max, width, expected] of rows)
    expect(bar(value, max, width)).toBe(expected);
});

test("a selected row is a band of the text colour, and a bar or a chart on it keeps its colour", async () => {
  // As the reader sees each part: its glyph colour, then its cell colour. A
  // row in one colour becomes a band of that colour.
  const text = shown(ui.fg, "fg");
  const ground = shown(ui.bg, "bg");
  const cpu = shown(metric.cpu, "fg");
  const danger = shown(ui.danger, "fg");
  const rows: [string, boolean, RGBA | undefined, string, string, string][] = [
    ["selected, plain", true, undefined, "name", ground, text],
    ["selected, bar", true, undefined, "██", cpu, text],
    ["selected, chart", true, undefined, "▁█", cpu, text],
    ["selected, danger word", true, undefined, "ink", danger, text],
    ["selected, danger row", true, ui.danger, "name", ground, danger],
    // A danger word on a danger band takes the band's text colour, or it
    // would be drawn in the band's own colour and vanish.
    [
      "selected, danger row, danger word",
      true,
      ui.danger,
      "ink",
      ground,
      danger,
    ],
    ["plain", false, undefined, "name", text, ground],
    ["bar", false, undefined, "██", cpu, ground],
    ["danger word", false, undefined, "ink", danger, ground],
    ["danger row", false, ui.danger, "name", danger, ground],
  ];
  for (const [row, selected, colour, part, glyph, cell] of rows) {
    // The screen's own background sits behind every row, as it does in App.
    const screen = await testRender(
      <box backgroundColor={ui.bg}>
        <Row selected={selected} color={colour}>
          {"name "}
          <Bar value={50} max={100} width={4} color={metric.cpu} />{" "}
          <Sparkline marks="▁█" color={metric.cpu} />{" "}
          <Ink color={ui.danger}>ink</Ink>
        </Row>
      </box>,
      { width: 24, height: 1 },
    );
    try {
      await screen.renderOnce();
      const spans = screen.captureSpans().lines[0]?.spans ?? [];
      const span = spans.find((s) => s.text.includes(part));
      expect({ row, part, ...(span && onScreen(span)) }).toEqual({
        row,
        part,
        glyph,
        cell,
      });
    } finally {
      await act(async () => {
        screen.renderer.destroy();
      });
    }
  }
});

test("chart rows stack eighths from the base line and mark gaps only there", () => {
  // Three columns: a full-height value, a half value, and no sample.
  expect(chartRows([100, 50, null], 2, 100)).toEqual(["█  ", "██·"]);
  // A value below one eighth still leaves a mark on the base line.
  expect(chartRows([1, 0], 1, 100)).toEqual(["▁ "]);
  // A spike above the top fills the column rather than overflowing.
  expect(chartRows([250], 2, 100)).toEqual(["█", "█"]);
});

test("a list windows around the selection and says what it left out", async () => {
  const items = Array.from({ length: 20 }, (_, i) => `row-${i}`);
  const render = (selected: number, height: number) =>
    testRender(
      <List
        items={items}
        selected={selected}
        height={height}
        empty="nothing"
        render={(item, _i, isSelected) => (
          <Row key={item} selected={isSelected}>
            {item}
          </Row>
        )}
      />,
      { width: 40, height: 12 },
    );
  const ui = await render(15, 6);
  try {
    await ui.renderOnce();
    const frame = ui.captureCharFrame();
    expect(frame).toContain("▍row-15");
    expect(frame).not.toContain("row-0\n");
    expect(frame).toContain("of 20");
  } finally {
    await act(async () => {
      ui.renderer.destroy();
    });
  }
  const short = await testRender(
    <List
      items={items.slice(0, 3)}
      selected={0}
      height={10}
      empty="nothing"
      render={(item, _i, isSelected) => (
        <Row key={item} selected={isSelected}>
          {item}
        </Row>
      )}
    />,
    { width: 40, height: 12 },
  );
  try {
    await short.renderOnce();
    expect(short.captureCharFrame()).not.toContain(" of ");
  } finally {
    await act(async () => {
      short.renderer.destroy();
    });
  }
  const none = await testRender(
    <List
      items={[]}
      selected={0}
      height={10}
      empty="nothing here"
      render={() => null}
    />,
    { width: 40, height: 4 },
  );
  try {
    await none.renderOnce();
    expect(none.captureCharFrame()).toContain("nothing here");
  } finally {
    await act(async () => {
      none.renderer.destroy();
    });
  }
});

test("a down move stops at the last row and holds an empty list at the first", () => {
  // count, index before the move, index after it.
  const rows: [number, number, number][] = [
    [0, 0, 0],
    [0, 4, 0],
    [1, 0, 0],
    [3, 0, 1],
    [3, 1, 2],
    [3, 2, 2],
  ];
  for (const [count, index, expected] of rows)
    expect(nextDown(count, index)).toBe(expected);
});

test("a line takes the terminal's foreground unless a colour is given", async () => {
  const ui = await testRender(
    <box flexDirection="column">
      <Line>plain</Line>
      <text>raw</text>
    </box>,
    { width: 20, height: 3 },
  );
  try {
    await ui.renderOnce();
    const spans = ui.captureSpans().lines.flatMap((line) => line.spans);
    expect(spans.find((s) => s.text.includes("plain"))?.fg.intent).toBe(
      "default",
    );
    // The control: a bare text element is what OpenTUI paints white.
    expect(spans.find((s) => s.text.includes("raw"))?.fg.intent).toBe("rgb");
  } finally {
    await act(async () => {
      ui.renderer.destroy();
    });
  }
});

test("a chart row splits into runs, so a gap is painted quietly in one span", () => {
  // A fresh start: gaps, then the samples that have arrived.
  expect(gapRuns("···▁▂").map((run) => [run.sampled, run.text])).toEqual([
    [false, "···"],
    [true, "▁▂"],
  ]);
  expect(gapRuns("▁·▂").map((run) => [run.sampled, run.text])).toEqual([
    [true, "▁"],
    [false, "·"],
    [true, "▂"],
  ]);
  expect(gapRuns("")).toEqual([]);
  // Every column of the row is accounted for exactly once.
  const row = "··▁█·· ▂";
  expect(
    gapRuns(row)
      .map((run) => run.text)
      .join(""),
  ).toBe(row);
});

test("tiles wrap rather than squeeze their captions together", () => {
  const rows: [number, number | undefined, number][] = [
    // Four tiles need 26 columns each plus the gaps between them, and the
    // rows share them evenly rather than leaving a lone tile below three.
    [4, 160, 4],
    [4, 110, 4],
    [4, 100, 2],
    [4, 96, 2],
    [4, 80, 2],
    [4, 40, 1],
    [4, 1, 1],
    // Three tiles do fit in a hundred columns, so they stay on one row.
    [3, 100, 3],
    [3, 60, 2],
    // No width stated keeps them on one row, whatever the count.
    [4, undefined, 4],
    [1, 40, 1],
  ];
  for (const [count, width, expected] of rows)
    expect({ count, width, perRow: tilesPerRow(count, width) }).toEqual({
      count,
      width,
      perRow: expected,
    });
});

test("a windowed list shows the rows it has room for, around the selection", () => {
  const rows: [number, number, number, [number, number]][] = [
    // count, selected, height, [start, end)
    [40, 0, 24, [0, 23]],
    [40, 39, 24, [17, 40]],
    [40, 20, 24, [9, 32]],
    // Fewer rows than the height: every one, and no window to slide.
    [5, 0, 24, [0, 5]],
    [5, 4, 24, [0, 5]],
    // A terminal with no room still shows one row rather than none.
    [40, 10, 1, [10, 11]],
    [0, 0, 24, [0, 0]],
  ];
  for (const [count, selected, height, [start, end]] of rows)
    expect({
      count,
      selected,
      height,
      at: listWindow(count, selected, height),
    }).toEqual({ count, selected, height, at: { start, end } });
});

test("a chart's gaps are painted quietly and its samples in the metric's colour", async () => {
  // Spans need a text element to sit in, the way every screen draws them.
  const ui2 = await testRender(
    <Line>
      <Sparkline marks="··▁█" color={metric.cpu} />
    </Line>,
    { width: 8, height: 1 },
  );
  try {
    await ui2.renderOnce();
    const spans = ui2.captureSpans().lines.flatMap((line) => line.spans);
    const gap = spans.find((span) => span.text.includes("·"));
    const sampled = spans.find((span) => span.text.includes("█"));
    expect(gap?.text).toBe("··");
    // A column with no sample recedes; one with a sample carries the metric.
    // The gap is the dimmed default foreground, never bright black, which
    // vanishes behind a selected row and in schemes that make it the
    // background.
    expect(gap?.fg.equals(ui.fg)).toBe(true);
    expect((gap?.attributes ?? 0) & TextAttributes.DIM).not.toBe(0);
    expect(sampled?.fg.equals(metric.cpu)).toBe(true);
    expect((sampled?.attributes ?? 0) & TextAttributes.DIM).toBe(0);
  } finally {
    await act(async () => {
      ui2.renderer.destroy();
    });
  }
});
