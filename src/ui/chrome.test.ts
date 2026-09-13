import { expect, test } from "bun:test";
import { defaults, validate } from "../config/config";
import {
  detailWidth,
  headerMarker,
  headerRowWidth,
  keyLabel,
  panelWidth,
  screenPad,
  screenWidth,
  tabsFitOneRow,
  viewKey,
  views,
} from "./chrome";
import { detailIndent } from "./widgets";

test("a key reads as it is printed on the keyboard", () => {
  const rows: [string, string][] = [
    ["return", "Enter"],
    ["escape", "Esc"],
    ["up", "\u2191"],
    ["space", "Space"],
    ["y", "y"],
    ["shift+tab", "shift+tab"],
  ];
  for (const [key, label] of rows)
    expect({ key, label: keyLabel(key) }).toEqual({ key, label });
});

test("the tabs share the header row only when the host and the clock leave room", () => {
  const c = defaults();
  const clock = "5:50:23 PM";
  // The capture at a hundred columns read `cachyHome` and `7 Settin5:50:23 PM`
  // because the tabs took the columns the host and the clock were using.
  const rows: [number, string, boolean][] = [
    [180, "cachy", true],
    [140, "cachy", true],
    [100, "cachy", false],
    [80, "cachy", false],
    // A longer host takes the row away sooner; a shorter one keeps it longer.
    [140, "a-very-long-hostname-that-does-not-leave-room", false],
  ];
  for (const [width, host, fits] of rows)
    expect({
      width,
      host,
      fits: tabsFitOneRow(width, host, clock, null, c),
    }).toEqual({
      width,
      host,
      fits,
    });
});

test("the fit predicate measures the row the header draws", () => {
  const clock = "5:50:23 PM";
  const host = "cachy";
  const c = defaults();
  const exact = headerRowWidth(host, clock, null, c);
  expect(tabsFitOneRow(exact, host, clock, null, c)).toBe(true);
  expect(tabsFitOneRow(exact - 1, host, clock, null, c)).toBe(false);
  // Every tab is paid for, not the widest one seven times: a key bound one
  // character longer costs one column even on a tab that is not the widest.
  const longerKey = validate({ ...c, keys: { ...c.keys, home: "f1" } });
  const widths = (config: typeof c) =>
    views.map((v) => config.keys[viewKey(v)].length + 1 + v.length);
  expect(Math.max(...widths(longerKey))).toBe(Math.max(...widths(c)));
  expect(headerRowWidth(host, clock, null, longerKey)).toBe(exact + 1);
  // A longer host and a longer clock each cost their own columns.
  expect(headerRowWidth(`${host}xx`, clock, null, c)).toBe(exact + 2);
  expect(headerRowWidth(host, `${clock}x`, null, c)).toBe(exact + 1);
  // A pinned marker carries a timestamp where the live one carries `live`, so
  // it is wider and the row it needs is wider with it.
  const pinnedAt = Date.parse("2024-01-01T17:50:23");
  expect(headerRowWidth(host, clock, pinnedAt, c)).toBe(
    exact + [...headerMarker(pinnedAt)].length - [...headerMarker(null)].length,
  );
  expect(tabsFitOneRow(exact, host, clock, pinnedAt, c)).toBe(false);
});

test("every view is bound to a key the settings name", () => {
  const c = defaults();
  for (const view of views) expect(c.keys[viewKey(view)]).toBeTruthy();
});

test("a card's detail is measured through every column it is drawn behind", () => {
  // The terminal row, less the padding a screen draws inside, less the rule
  // and indent of the block the detail sits in. Each term is the constant the
  // renderer itself uses, so the measurement cannot drift from the drawing.
  expect(screenWidth(80)).toBe(80 - screenPad * 2);
  expect(detailWidth(80)).toBe(panelWidth(screenWidth(80)) - detailIndent);
  expect(detailWidth(80)).toBe(72);
  // Two panels share a wide row, so a wider terminal is not a wider card.
  expect(detailWidth(160)).toBe(72);
  expect(detailWidth(200)).toBe(92);
  // A terminal too narrow to measure still leaves a column to write into.
  expect(detailWidth(10)).toBe(20);
});
