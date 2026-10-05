import { expect, test } from "bun:test";
import {
  type Column,
  capLines,
  cell,
  columnGap,
  columnsWidth,
  fit,
  fitAddress,
  headerText,
  sortedLabel,
  textWidth,
  wrapLines,
} from "./columns";

test("a value is padded or cut to its width, and a cut is marked", () => {
  const rows: [string, number, string][] = [
    ["short", 8, "short   "],
    ["exactly8", 8, "exactly8"],
    ["far too long to fit", 8, "far too…"],
    ["a", 1, "a"],
    ["ab", 1, "…"],
    ["anything", 0, ""],
  ];
  for (const [text, width, expected] of rows) {
    expect({ text, got: fit(text, width) }).toEqual({ text, got: expected });
    expect([...fit(text, width)].length).toBe(Math.max(0, width));
  }
  expect(fit("42", 6, "right")).toBe("    42");
});

test("an address is cut in its session, and keeps the window and pane whole", () => {
  const rows: [string, number, string][] = [
    // Room for the whole address: padded like any other cell.
    ["development:1.1", 16, "development:1.1 "],
    ["development:1.1", 15, "development:1.1"],
    // Two agents in one session differ only after the colon, so that is the
    // part kept.
    ["development:1.1", 12, "develop…:1.1"],
    ["development:2.1", 12, "develop…:2.1"],
    ["development:10.12", 12, "devel…:10.12"],
    // Only the session given up, and the ellipsis still marks it.
    ["development:1.1", 5, "…:1.1"],
    // Too narrow for the suffix and its mark, or no suffix to keep: a plain
    // cut, as any other text gets.
    ["development:1.1", 4, "dev…"],
    ["work-session", 6, "work-…"],
    // A session name of wide characters is cut between characters, never
    // through one, and a cell a wide character cannot fill is a blank.
    ["🙂🙂🙂🙂:1.1", 7, "🙂…:1.1"],
    ["开发环境:1.1", 8, "开…:1.1 "],
  ];
  for (const [address, width, expected] of rows) {
    const got = fitAddress(address, width);
    expect({ address, width, got }).toEqual({ address, width, got: expected });
    expect(textWidth(got)).toBe(width);
  }
});

test("a cell is measured in the terminal cells its text draws", () => {
  // A wide character draws two cells, a joined emoji is one character, and a
  // control byte draws as the blank that replaces it.
  const rows: [string, number, "right" | undefined, string][] = [
    ["\u{1F642}", 6, undefined, "\u{1F642}    "],
    ["\u{1F642}", 6, "right", "    \u{1F642}"],
    ["🙂🙂🙂🙂", 3, undefined, "🙂…"],
    // The mark leaves one cell before it, which a wide character cannot fill.
    ["🙂🙂🙂🙂", 4, undefined, "🙂… "],
    ["智能体工作区", 7, undefined, "智能体…"],
    ["智能体工作区", 7, "right", "智能体…"],
    ["👨‍👩‍👧👨‍👩‍👧", 3, undefined, "👨‍👩‍👧…"],
    ["a\u0007b", 4, undefined, "a b "],
  ];
  for (const [text, width, align, expected] of rows) {
    const got = fit(text, width, align);
    expect({ text, width, align, got }).toEqual({
      text,
      width,
      align,
      got: expected,
    });
    expect(textWidth(got)).toBe(width);
  }
  const columns: [Column, Column] = [
    { label: "Agent", width: 6 },
    { label: "CPU", width: 6, align: "right" },
  ];
  for (const name of ["\u{1F642}", "智能体工作区智能体"]) {
    const row = [cell(columns[0], name), cell(columns[1], "5.0%")].join(
      columnGap,
    );
    expect(textWidth(row)).toBe(columnsWidth(columns));
    expect(textWidth(row)).toBe(textWidth(headerText(columns)));
  }
});

test("the heading is built from the same spec its rows read", () => {
  const columns: [Column, Column] = [
    { label: "Agent", width: 10 },
    { label: "CPU", width: 6, align: "right" },
  ];
  expect(headerText(columns)).toBe(`Agent     ${columnGap}   CPU`);
  const row = [cell(columns[0], "lane-a"), cell(columns[1], "5.0%")].join(
    columnGap,
  );
  expect(row).toBe(`lane-a    ${columnGap}  5.0%`);
  // Heading and row occupy the same columns, so a width change moves both.
  expect(row.length).toBe(headerText(columns).length);
  expect(row.length).toBe(columnsWidth(columns));
  // Both cells are right-aligned, so they end on the same column.
  expect(row.indexOf("5.0%") + "5.0%".length).toBe(
    headerText(columns).indexOf("CPU") + "CPU".length,
  );
});

test("a spec of one column has no gap to count", () => {
  expect(columnsWidth([{ label: "One", width: 4 }])).toBe(4);
  expect(columnsWidth([])).toBe(0);
});

test("a sorted heading puts its arrow where the column's own values end", () => {
  const wait: Column = { label: "Wait", width: 11, align: "right" };
  const agent: Column = { label: "Agent", width: 20 };
  // A right-aligned column's digits end at its right edge, so its arrow leads
  // and the heading still ends there. A text column's values start at its left
  // edge, so its arrow follows the word. A heading nobody sorts by has none.
  const rows: [Column, boolean, boolean, string][] = [
    [wait, true, true, "↓ Wait"],
    [wait, true, false, "↑ Wait"],
    [agent, true, true, "Agent ↓"],
    [agent, true, false, "Agent ↑"],
    [wait, false, true, "Wait"],
    [agent, false, false, "Agent"],
  ];
  for (const row of rows) {
    const [column, sorted, descending] = row;
    expect([
      column,
      sorted,
      descending,
      sortedLabel(column, sorted, descending),
    ]).toEqual(row);
  }
});

test("text wraps between words, and a word wider than the column is broken", () => {
  expect(wrapLines("one two three four", 9)).toEqual([
    "one two",
    "three",
    "four",
  ]);
  expect(wrapLines("", 10)).toEqual([]);
  // A word with nowhere to break is broken at the column, not left to overrun.
  expect(wrapLines("abcdefghij k", 4)).toEqual(["abcd", "efgh", "ij k"]);
  // Cells, not code points: an emoji or a CJK character draws two.
  expect(wrapLines("😀😀😀 x", 3)).toEqual(["😀", "😀", "😀", "x"]);
  expect(wrapLines("😀😀😀 x", 6)).toEqual(["😀😀😀", "x"]);
  expect(wrapLines("工作区 名字", 4)).toEqual(["工作", "区", "名字"]);
  // A character wider than the column still takes a row, rather than none.
  expect(wrapLines("工作", 1)).toEqual(["工", "作"]);
  // A control byte is measured as the blank it draws as, which is a break.
  expect(wrapLines("ab\u0007cd", 2)).toEqual(["ab", "cd"]);
  // A column narrower than one character is a caller's mistake, not a wrap.
  expect(() => wrapLines("x", 0)).toThrow(RangeError);
  expect(wrapLines("x", 1)).toEqual(["x"]);
});

test("a capped text ends in the mark and fits the rows it was given", () => {
  const text = "one two three four five six seven eight nine ten";
  expect(capLines(text, 9, 6)).toBe(text);
  const cut = capLines(text, 9, 2);
  expect(cut).toBe("one two three…");
  expect(wrapLines(cut, 9).length).toBe(2);
  // The mark replaces the punctuation that ended the kept text, so a cut
  // sentence never reads as one that stopped on its own.
  expect(capLines("alpha, beta, gamma", 7, 1)).toBe("alpha…");
  // A last row filling its width gives a column up to the mark rather than
  // spilling one row further than it was given.
  const full = capLines("alpha beta gamma delta", 10, 1);
  expect(full).toBe("alpha bet…");
  expect(wrapLines(full, 10).length).toBe(1);
  // A cut text is the text, cut: a unit name too wide for the column is not
  // rebuilt with the blank its wrapped rows were divided by.
  const unit = "app-org.gnome.Terminal-9f2c4a1b.service holds it";
  expect(capLines(unit, 20, 2)).toBe(
    "app-org.gnome.Terminal-9f2c4a1b.service…",
  );
  expect(capLines(`x ${unit}`, 20, 3)).toBe(
    "x app-org.gnome.Terminal-9f2c4a1b.service…",
  );
  expect(wrapLines(capLines(`x ${unit}`, 20, 3), 20)).toHaveLength(3);
  // A cut ends between wide characters, with the mark inside the width.
  expect(capLines("工作区工作区", 5, 1)).toBe("工作…");
  expect(capLines("工作区工作区", 4, 1)).toBe("工…");
  // What comes back is what was measured: sanitized, whole or cut.
  expect(capLines("ab\u0007cd", 5, 1)).toBe("ab cd");
  // No rows is no text. A screen with nothing left to draw into is answered,
  // not raised at.
  expect(capLines(text, 9, 0)).toBe("");
});
