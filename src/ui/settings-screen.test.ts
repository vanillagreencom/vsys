import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot } from "../test/fixture";
import { settingGroups } from "./settings";
import { settingItems, sourceCounts } from "./settings-screen";

test("every stored setting sits in exactly one group, and no group names a stranger", () => {
  const known = Object.keys(defaults()).filter((key) => key !== "keys");
  const grouped = settingGroups.flatMap(([, keys]) => keys);
  expect(new Set(grouped).size).toBe(grouped.length);
  expect([...grouped].sort()).toEqual([...known].sort());
});

test("the Settings list opens with the sources row and ends with the keys", () => {
  const items = settingItems(defaults());
  expect(items[0]).toEqual({ kind: "sources" });
  expect(items.at(-1)).toEqual({ kind: "setting", key: "keys.exportMarkdown" });
  expect(items.filter((i) => i.kind === "setting").length).toBe(
    Object.keys(defaults()).length - 1 + Object.keys(defaults().keys).length,
  );
});

test("unreadable sources are counted once each, most failed reads first", () => {
  const s = emptySnapshot();
  s.errors = [
    { source: "/proc/2", message: "denied" },
    { source: "/proc/1", message: "denied" },
    { source: "/proc/2", message: "denied" },
    { source: "/proc/0", message: "denied" },
  ];
  expect(sourceCounts(s)).toEqual([
    ["/proc/2", 2],
    ["/proc/0", 1],
    ["/proc/1", 1],
  ]);
  expect(sourceCounts(emptySnapshot())).toEqual([]);
});
