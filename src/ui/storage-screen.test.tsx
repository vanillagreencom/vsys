import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { defaults } from "../config/config";
import type { Level } from "../model/verdict";
import { emptySnapshot, groupSnapshot, volumeSnapshot } from "../test/fixture";
import { cellStyle, isChildLine, mount, selectedRow } from "../test/harness";
import { type KeyHandler, KeyProvider } from "./keys";
import {
  itemPath,
  Storage,
  storageItems,
  volumeLevel,
  volumesByDevice,
} from "./storage-screen";
import { ui } from "./theme";

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

test("Storage opens with write totals and keeps filesystem state below them", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.groups = [
    groupSnapshot({
      path: ".",
      parent: ".",
      name: "user@1000.service",
      ioWrite: 2199023255552,
    }),
    groupSnapshot({
      path: "agents.slice",
      parent: ".",
      name: "agents.slice",
      ioWrite: 2199023255552,
    }),
  ];
  s.storage.devices = [
    { name: "nvme0n1", number: "259:0", model: null, lifetimeWritten: 1e13 },
  ];
  s.storage.deviceWrites = { "259:0": 2199023255552 };
  s.storage.volumes = [volumeSnapshot("/mnt/data", { readOnly: true })];
  const t = await mount(s, c, { width: 140, height: 45 });
  try {
    await t.press("5");
    const frame = t.frame();
    expect(frame).toMatch(/agents\.slice\s+█+\s+2\.0 TiB/);
    expect(frame).toMatch(/nvme0n1\s+█+\s+2\.0 TiB/);
    expect(frame).toContain("Drive lifetime writes");
    expect(frame).toContain("9.1 TiB");
    // Free space and read-only state stay, below what the drive has taken.
    expect(frame.indexOf("Written since boot")).toBeLessThan(
      frame.indexOf("Filesystems"),
    );
    expect(frame.indexOf("Filesystems")).toBeLessThan(
      frame.indexOf("read-only"),
    );
  } finally {
    await t.close();
  }
});

test("Storage draws two filesystems that report one device", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // One filesystem reached through a mapper alias and another through the
  // same source string: two identities, one device between them. The heading
  // is drawn once per group, so the device cannot identify a group.
  s.storage.volumes = [
    volumeSnapshot("/one", { device: "/dev/mapper/pool", fsid: "abc" }),
    volumeSnapshot("/two", { device: "/dev/mapper/pool", fsid: "def" }),
  ];
  // What the fixture has to hold, asserted before anything is drawn. Two ids
  // that do not share a device would draw two distinct keys whatever the key
  // is, and prove nothing about which one was used.
  expect(
    volumesByDevice(s.storage.volumes).map((g) => `${g.id} ${g.device}`),
  ).toEqual(["abc /dev/mapper/pool", "def /dev/mapper/pool"]);
  const logged: string[] = [];
  const wasError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  let frame = "";
  try {
    const t = await mount(s, c, { width: 140, height: 30 });
    try {
      await t.press("5");
      frame = t.frame();
    } finally {
      await t.close();
    }
  } finally {
    console.error = wasError;
  }
  // Both filesystems reached the screen, so the diagnostic below is about two
  // drawn groups rather than a fixture that quietly drew one.
  expect([frame.includes("/one"), frame.includes("/two")]).toEqual([
    true,
    true,
  ]);
  // Keyed by the device these two groups share one key, which React reports as
  // unsupported: it may duplicate or omit a child, and which it does is not
  // ours to choose. This render still draws both, so the diagnostic is the only
  // place the collision is stated, and the test reads it rather than the frame.
  expect(logged.filter((line) => /same key/i.test(line))).toEqual([]);
});

test("a device reports the free space a member could read", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // `statfs` is attempted per mount, so one member of a filesystem can carry
  // no reading while another carries one.
  s.storage.volumes = [
    volumeSnapshot("/data", {
      device: "/dev/nvme0n1p2",
      fsid: "one",
      free: null,
      total: null,
    }),
    volumeSnapshot("/data/home", {
      device: "/dev/nvme0n1p2",
      fsid: "one",
      free: 1e11,
      total: 2e11,
    }),
  ];
  const t = await mount(s, c, { width: 140, height: 30 });
  try {
    await t.press("5");
    const line = t
      .frame()
      .split("\n")
      .find((row) => row.includes("/dev/nvme0n1p2"));
    expect(line).toBeDefined();
    expect(line).toContain("93.1 GiB free of 186.3 GiB");
    expect(line).not.toContain("not avail");
  } finally {
    await t.close();
  }
});

test("a filesystem's detail is drawn as a child of its row", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes = [volumeSnapshot("/data", { device: "/dev/sda1" })];
  const t = await mount(s, c, { width: 160, height: 40 });
  try {
    await t.press("5");
    const lines = t.frame().split("\n");
    const row = lines.findIndex((line) => line.includes("▾ /data"));
    expect(row).toBeGreaterThan(-1);
    expect(isChildLine(lines[row])).toBe(false);
    expect(isChildLine(lines[row + 1])).toBe(true);
    // The mount's own detail, not the device row's: subvolumes of one
    // filesystem share a device and its error counters, stated once above.
    expect(lines[row + 1]).toContain("Options");
  } finally {
    await t.close();
  }
});

test("a mount's detail does not repeat the device row's error counters", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes = [
    volumeSnapshot("/data", {
      device: "/dev/nvme0n1p2",
      errors: { "nvme0n1p2/corruption_errs": 3 },
      options: ["rw", "subvol=@data"],
    }),
  ];
  const t = await mount(s, c, { width: 140, height: 30 });
  try {
    await t.press("5");
    const frame = t.frame();
    // The device row states the counters once for every mount grouped under
    // it. The mount below it carries only what differs between mounts.
    expect(frame.split("corruption 3").length - 1).toBe(1);
    expect(frame).toContain("subvol=@data");
    expect(frame).not.toContain("Errors");
  } finally {
    await t.close();
  }
});

/** Two filesystems, one scrub report and two scratch directories. */
function everyList() {
  const s = emptySnapshot();
  s.storage.volumes = [
    volumeSnapshot("/data", { device: "/dev/sda1" }),
    volumeSnapshot("/home", { device: "/dev/sda2" }),
  ];
  s.storage.scrubs = [
    { path: "/run/btrfs-scrub/one", text: "clean", problem: false },
  ];
  s.storage.scratch = [
    { path: "/scratch/a", bytes: 10, age: 0, error: null },
    { path: "/scratch/b", bytes: 20, age: 0, error: null },
  ];
  return s;
}

test("Storage moves between its three lists with the region key and with left and right", async () => {
  const c = defaults();
  const s = everyList();
  // Each pair moves between the lists the same way: forward, then back.
  const pairs: [string, string][] = [
    [c.keys.next, c.keys.previous],
    ["right", "left"],
    [c.keys.right, c.keys.left],
  ];
  for (const [forward, back] of pairs) {
    const t = await mount(s, c, { width: 160, height: 44 });
    try {
      await t.press("5");
      // The keys pressed, then the selected row. Down stays inside the
      // filesystems rather than walking into the reports; forward lands on
      // the next list's first row, and at either end the reader stays on the
      // row they are on.
      const steps: [string[], string][] = [
        [[], "/data"],
        [["down"], "/home"],
        [[back], "/home"],
        [Array(10).fill("down"), "/home"],
        [[forward], "/run/btrfs-scrub/one"],
        [[forward], "/scratch/a"],
        [[forward], "/scratch/a"],
        [["down", forward], "/scratch/b"],
        [[back], "/run/btrfs-scrub/one"],
        [[back], "/data"],
      ];
      for (const [keys, row] of steps) {
        for (const key of keys) await t.press(key);
        expect({
          forward,
          keys,
          on: selectedRow(t.frame()).includes(row),
        }).toEqual({ forward, keys, on: true });
      }
      // The scratch list empties under its selected row: the selection moves
      // to the last row there is, and moving back goes on from there.
      await t.press(forward);
      await t.press(forward);
      await t.update({ ...s, storage: { ...s.storage, scratch: [] } });
      expect(selectedRow(t.frame())).toContain("/run/btrfs-scrub/one");
      await t.press(back);
      expect(selectedRow(t.frame())).toContain("/data");
    } finally {
      await t.close();
    }
  }
});

test("a Storage list's own key lands on its first row", async () => {
  const c = defaults();
  const t = await mount(everyList(), c, { width: 160, height: 44 });
  try {
    await t.press("5");
    // The keys pressed, then the selected row. Each key is pressed from
    // another list, then again from lower down its own list.
    const steps: [string[], string][] = [
      [[c.keys.scratch], "/scratch/a"],
      [["down"], "/scratch/b"],
      [[c.keys.scratch], "/scratch/a"],
      [[c.keys.scrub], "/run/btrfs-scrub/one"],
      [[c.keys.filesystems], "/data"],
      [["down"], "/home"],
      [[c.keys.filesystems], "/data"],
    ];
    for (const [keys, row] of steps) {
      for (const key of keys) await t.press(key);
      expect({ keys, on: selectedRow(t.frame()).includes(row) }).toEqual({
        keys,
        on: true,
      });
    }
  } finally {
    await t.close();
  }
});

test("a key for a Storage list with no rows changes nothing", async () => {
  const c = defaults();
  const s = everyList();
  s.storage.scrubs = [];
  const t = await mount(s, c, { width: 160, height: 44 });
  try {
    await t.press("5");
    // Off the first row, so a key that moved the selection would show.
    await t.press("down");
    expect(selectedRow(t.frame())).toContain("/home");
    const before = t.frame();
    await t.press(c.keys.scrub);
    expect(t.frame()).toBe(before);
  } finally {
    await t.close();
  }
});

test("each Storage list draws the key that jumps to it, dimmed before its name", async () => {
  // A rebound key, so what is drawn is read from the binding.
  const c = { ...defaults(), keys: { ...defaults().keys, scrub: "i" } };
  const t = await mount(everyList(), c, { width: 160, height: 44 });
  try {
    await t.press("5");
    const names: [string, string][] = [
      ["f", "Filesystems"],
      ["i", "Scrub reports"],
      ["x", "Scratch"],
    ];
    for (const [key, name] of names)
      expect({ name, key: cellStyle(t.ui, `${key} ${name}`, ui.dim) }).toEqual({
        name,
        key: "dim",
      });
    // A section nobody selects in has no key to reach it.
    expect(t.frame()).toMatch(/^ +Written since boot/m);
  } finally {
    await t.close();
  }
});

test("the device error counters are legible at a hundred columns", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes = [
    volumeSnapshot("/data", {
      device: "/dev/nvme0n1p2",
      errors: { "nvme0n1p2/corruption_errs": 3 },
      // A counter that rose since the last sample turns the row red, so this
      // reading is the one the colour is telling the reader to go and find.
      delta: { "nvme0n1p2/corruption_errs": 1 },
      options: ["rw", "subvol=@data"],
    }),
  ];
  const t = await mount(s, c, { width: 100, height: 30 });
  try {
    await t.press("5");
    const frame = t.frame();
    // The device row's own columns fill a terminal this narrow, so the
    // counters wrap onto a line of their own. They are the reading behind the
    // row's colour, and since the mount detail stopped repeating them, the
    // only copy of it.
    expect(frame).toContain("corruption 3 (+1)");
    expect(frame.split("corruption 3").length - 1).toBe(1);
  } finally {
    await t.close();
  }
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

test("a target whose row has gone is said out loud, not dropped", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes = [volumeSnapshot("/data")];
  s.groups = [groupSnapshot({ path: "busy.scope", name: "busy.scope" })];
  /** One screen rendered with a target, reporting what it did with it. */
  /** Storage rendered with a target, reporting what it did with it. */
  async function landOn(target: string) {
    const notices: [string, string][] = [];
    let used = 0;
    const handlers = new Set<KeyHandler>();
    const props = {
      snapshot: s,
      config: c,
      target,
      onTargetUsed: () => {
        used += 1;
      },
      onNotice: (text: string, level: string) => notices.push([text, level]),
    };
    const ui = await testRender(
      <KeyProvider handlers={handlers}>
        <Storage {...props} width={140} />
      </KeyProvider>,
      { width: 140, height: 30 },
    );
    try {
      await ui.renderOnce();
      return { used, notices, frame: ui.captureCharFrame() };
    } finally {
      ui.renderer.destroy();
    }
  }
  // A collector refresh between the keypress and this effect can take the row
  // the card named. The request is still consumed, so it cannot fire again on
  // a later sample, and the reader is told rather than left on a screen that
  // looks like they never pressed anything.
  const gone = await landOn("/gone");
  expect(gone.used).toBe(1);
  expect(gone.notices).toEqual([["/gone is no longer in the sample", "warn"]]);
  // A row that is there is landed on, and says nothing.
  const found = await landOn("/data");
  expect(found.used).toBe(1);
  expect(found.notices).toEqual([]);
  expect(found.frame).toContain("/data");
});
