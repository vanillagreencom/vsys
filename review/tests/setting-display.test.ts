import { expect, test } from "bun:test";
import { defaults } from "../../src/config/config";
import { settingDisplay } from "../../src/ui/settings";

test("an empty Watched Btrfs mounts list does not read as none", () => {
  const c = defaults();
  // src/collect/btrfs.ts:452 `!c.btrfsMounts.length || ...` watches every
  // Btrfs mount when the list is empty, and empty is the shipped default.
  expect(settingDisplay("btrfsMounts", c.btrfsMounts, c)).not.toBe("none");
});

test("a stored interval of a minute or more is not shown shorter than it is", () => {
  const c = defaults();
  // 90 s and 3599 s are valid stored values (validate: 1000..86400000 ms).
  expect(settingDisplay("scratchRefreshMs", 90000, c)).not.toBe("1m");
  expect(settingDisplay("refreshMs", 3599000, c)).not.toBe("59m");
});
