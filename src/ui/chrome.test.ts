import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { keyLabel, tabsFitOneRow, viewKey, views } from "./chrome";

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
    [140, "a-very-long-hostname-indeed-here", false],
  ];
  for (const [width, host, fits] of rows)
    expect({ width, host, fits: tabsFitOneRow(width, host, clock, c) }).toEqual(
      {
        width,
        host,
        fits,
      },
    );
});

test("every view is bound to a key the settings name", () => {
  const c = defaults();
  for (const view of views) expect(c.keys[viewKey(view)]).toBeTruthy();
});
