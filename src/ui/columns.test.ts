import { expect, test } from "bun:test";
import {
  type Column,
  cell,
  columnGap,
  columnsWidth,
  fit,
  headerText,
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
