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

test("one filesystem is one heading, however its mounts name their device", () => {
  // The collector resolves a filesystem id per mount and the mount source it
  // resolved it from. A mapper alias, the canonical path it points at and a
  // second member device are three source strings for one filesystem.
  const groups = volumesByDevice([
    volumeSnapshot("/data", { device: "/dev/mapper/pool", fsid: "abc" }),
    volumeSnapshot("/data/home", { device: "/dev/dm-0", fsid: "abc" }),
    volumeSnapshot("/data/log", { device: "/dev/sda2", fsid: "abc" }),
    volumeSnapshot("/other", { device: "/dev/sdb1", fsid: "def" }),
  ]);
  expect(groups.map((group) => group.id)).toEqual(["abc", "def"]);
  expect(groups[0].volumes.map((v) => v.mount)).toEqual([
    "/data",
    "/data/home",
    "/data/log",
  ]);
  // The heading still names a device a reader would type.
  expect(groups[0].device).toBe("/dev/mapper/pool");
  expect(groups[1].volumes.map((v) => v.mount)).toEqual(["/other"]);
  // Where the id could not be resolved the source string is the fallback, so
  // those mounts still group rather than each standing alone.
  const unresolved = volumesByDevice([
    volumeSnapshot("/x", { device: "/dev/sdc1", fsid: null }),
    volumeSnapshot("/y", { device: "/dev/sdc1", fsid: null }),
    volumeSnapshot("/z", { device: "/dev/sdd1", fsid: null }),
  ]);
  expect(unresolved.map((group) => group.id)).toEqual([
    "/dev/sdc1",
    "/dev/sdd1",
  ]);
  // Two filesystems can report one device string, and only the id parts them.
  const shared = volumesByDevice([
    volumeSnapshot("/p", { device: "/dev/sde1", fsid: "one" }),
    volumeSnapshot("/q", { device: "/dev/sde1", fsid: "two" }),
  ]);
  expect(shared.map((group) => group.id)).toEqual(["one", "two"]);
  expect(shared.map((group) => group.device)).toEqual([
    "/dev/sde1",
    "/dev/sde1",
  ]);
});
