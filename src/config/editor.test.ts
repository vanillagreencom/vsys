import { expect, test } from "bun:test";
import { parseKeypress } from "@opentui/core";
import { present } from "../test/present";
import { validate } from "./config";
import { settingText, settingValue } from "./editor";
import { keyName, normalizeKey } from "./keys";

test("list editing preserves commas and quoted paths", () => {
  const paths = ["/tmp/a,b", '/tmp/"quoted"'];
  expect(settingValue(paths, settingText(paths))).toEqual(paths);
  expect(settingValue(true, "false")).toBe(false);
  expect(settingValue(5, "0")).toBe(0);
  expect(settingValue("true", "false")).toBe("false");
  expect(() => settingValue([], "[unterminated")).toThrow();
});
test("modifier bindings use canonical names and retain punctuation", () => {
  expect(normalizeKey("shift+ctrl+Q")).toBe("ctrl+shift+q");
  expect(normalizeKey("ctrl++")).toBe("ctrl++");
  expect(keyName({ name: "q", ctrl: true, meta: true, shift: true })).toBe(
    "ctrl+alt+shift+q",
  );
  expect(() => normalizeKey("ctrl+ctrl+q")).toThrow();
  expect(() => normalizeKey("control+q")).toThrow();
});
test("a key name binds only when OpenTUI emits it", () => {
  expect(normalizeKey("enter")).toBe("return");
  expect(normalizeKey("shift+esc")).toBe("shift+escape");
  // Each name a parsed key event carries binds as that name.
  for (const [sequence, kitty] of [
    ["\x1b[6~", false],
    ["\x1b[24~", false],
    ["\n", false],
    ["\x1b[E", false],
    ["\x1b[57376u", true],
    ["\x1b[57414u", true],
  ] as const) {
    const key = parseKeypress(sequence, { useKittyKeyboard: kitty });
    const name = present(
      key?.name,
      `a key name for ${JSON.stringify(sequence)}`,
    );
    expect(normalizeKey(name)).toBe(name);
  }
  for (const name of ["pgdown", "f36", "ctrl+foo"])
    expect(() => normalizeKey(name)).toThrow();
});
test("equivalent bindings and timer overflow are rejected", () => {
  expect(() => validate({ keys: { quit: "Q", down: "shift+q" } })).toThrow();
  expect(() => validate({ refreshMs: 2147483648 })).toThrow();
});
