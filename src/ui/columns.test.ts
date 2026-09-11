import { expect, test } from "bun:test";
import {
  type Column,
  cell,
  columnGap,
  columnsWidth,
  fit,
  fitAddress,
  headerText,
  sortedLabel,
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
    // A session name holding a character outside the basic plane is cut
    // between characters, never through one.
    ["🙂🙂🙂🙂:1.1", 7, "🙂🙂…:1.1"],
  ];
  for (const [address, width, expected] of rows) {
    const got = fitAddress(address, width);
    expect({ address, width, got }).toEqual({ address, width, got: expected });
    expect([...got].length).toBe(width);
  }
});

test("a cut falls between characters, never through one", () => {
  // A window title reaches a lane name, and an emoji in one is two UTF-16
  // units: cutting by unit would leave half a character on screen.
  const cut = fit("🙂🙂🙂🙂", 3);
  expect(cut).toBe("🙂🙂…");
  expect([...cut].length).toBe(3);
});

test("padding counts code points, so a cell is never one column short", () => {
  // `padEnd` and `padStart` count UTF-16 units, and an emoji is two of them:
  // padding by unit leaves the cell a column narrow and moves the cell beside
  // it, which is the drift one shared column spec exists to prevent.
  expect(fit("\u{1F642}", 6)).toBe("\u{1F642}     ");
  expect(fit("\u{1F642}", 6, "right")).toBe("     \u{1F642}");
  for (const align of [undefined, "right"] as const)
    expect({ align, points: [...fit("\u{1F642}", 6, align)].length }).toEqual({
      align,
      points: 6,
    });
  const columns: Column[] = [
    { label: "Agent", width: 6 },
    { label: "CPU", width: 6, align: "right" },
  ];
  const row = [cell(columns[0], "\u{1F642}"), cell(columns[1], "5.0%")].join(
    columnGap,
  );
  expect([...row].length).toBe(columnsWidth(columns));
  expect([...row].length).toBe([...headerText(columns)].length);
});

test("the heading is built from the same spec its rows read", () => {
  const columns: Column[] = [
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
