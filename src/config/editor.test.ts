import { expect, test } from "bun:test";
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
test("equivalent bindings and timer overflow are rejected", () => {
  expect(() => validate({ keys: { quit: "Q", down: "shift+q" } })).toThrow();
  expect(() => validate({ refreshMs: 2147483648 })).toThrow();
});
