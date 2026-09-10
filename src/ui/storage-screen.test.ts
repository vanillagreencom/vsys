import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import type { Level } from "../model/verdict";
import { emptySnapshot, volumeSnapshot } from "../test/fixture";
import {
  itemPath,
  storageItems,
  volumeLevel,
  volumesByDevice,
} from "./storage-screen";

test("Storage lists filesystems, then scrubs, then scratch directories, then sessions", () => {
  const s = emptySnapshot();
  s.storage.volumes = [volumeSnapshot("/a")];
  s.storage.scrubs = [{ path: "/a", text: "ok", problem: false }];
  s.storage.scratch = [{ path: "/tmp/x", bytes: 1, age: 0, error: null }];
  s.storage.sessions = [{ path: "/tmp/s", bytes: 1, age: 0, error: null }];
  expect(storageItems(s).map((item) => item.kind)).toEqual([
    "volume",
    "scrub",
    "scratch",
    "scratch",
  ]);
  expect(storageItems(emptySnapshot())).toEqual([]);
});

test("a filesystem is serious when read-only, when errors grow, or when space is under the floor", () => {
  const c = defaults();
  const rows: [Parameters<typeof volumeSnapshot>[1], Level][] = [
    [{}, "ok"],
    [{ readOnly: true }, "danger"],
    [{ delta: { "x/corruption_errs": 1 } }, "danger"],
    [{ free: c.freeFloor - 1 }, "danger"],
    [{ free: c.freeFloor }, "ok"],
    [{ free: null }, "ok"],
  ];
  for (const [overrides, level] of rows)
    expect(volumeLevel(volumeSnapshot("/m", overrides), c.freeFloor)).toBe(
      level,
    );
});

test("a device's mounts are listed together even when they arrive interleaved", () => {
  const s = emptySnapshot();
  // Two devices alternating in the sample. The rows are drawn grouped by
  // device and the selection counts them as it draws them, so this list has
  // to be grouped too. Snapshot order would put /b second, where the drawn
  // second row is /c: the highlight would name one mount and the row under
  // it would be another.
  // Both the device and the filesystem id are named, so the grouping this
  // asserts is the same one whichever of the two identifies a filesystem.
  s.storage.volumes = [
    volumeSnapshot("/a", { device: "/dev/one", fsid: "one" }),
    volumeSnapshot("/b", { device: "/dev/two", fsid: "two" }),
    volumeSnapshot("/c", { device: "/dev/one", fsid: "one" }),
  ];
  expect(storageItems(s).map(itemPath)).toEqual(["/a", "/c", "/b"]);
  // And the rows are drawn in that same order, which is what makes the two
  // agree rather than agreeing by coincidence.
  expect(
    volumesByDevice(s.storage.volumes).flatMap((group) =>
      group.volumes.map((volume) => volume.mount),
    ),
  ).toEqual(["/a", "/c", "/b"]);
});
