import { expect, test } from "bun:test";
import { keyLabel } from "./chrome";

test("a key reads as it is printed on the keyboard", () => {
  const rows: [string, string][] = [
    ["return", "Enter"],
    ["escape", "Esc"],
    ["shift+tab", "shift+tab"],
    ["q", "q"],
    ["?", "?"],
  ];
  for (const [key, label] of rows) expect(keyLabel(key)).toBe(label);
});
