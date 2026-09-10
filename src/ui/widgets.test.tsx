import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  bar,
  chartRows,
  gapRuns,
  Line,
  List,
  nextDown,
  Row,
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
