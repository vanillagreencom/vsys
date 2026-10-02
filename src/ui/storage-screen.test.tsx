import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { defaults } from "../config/config";
import { volumesByDevice } from "../model/integrity";
import type {
  CapabilityFailure,
  ScratchOrigin,
  Snapshot,
} from "../model/types";
import type { Level } from "../model/verdict";
import { emptySnapshot, groupSnapshot, volumeSnapshot } from "../test/fixture";
import { cellStyle, isChildLine, mount, selectedRow } from "../test/harness";
import { present } from "../test/present";
import { osc52 } from "./clipboard";
import { possibleSentence } from "./integrity";
import { type KeyHandler, KeyProvider } from "./keys";
import { regionOf, regionRanges, storageRegions } from "./regions";
import { driveReporterInstall, reporterInstall } from "./settings";
import {
  itemPath,
  Storage,
  type StorageItem,
  scratchSummary,
  storageItems,
  udisksText,
  volumeLevel,
} from "./storage-screen";
import { ui } from "./theme";

test("Storage lists filesystems, then scrubs, then scratch directories, then sessions", () => {
  const s = emptySnapshot();
  s.storage.volumes = [volumeSnapshot("/a")];
  s.storage.scrubs = [{ path: "/a", text: "ok", problem: false }];
  s.storage.scratch = [
    { path: "/tmp/x", bytes: 1, age: 0, error: null, origin: "configured" },
  ];
  s.storage.sessions = [{ path: "/tmp/s", bytes: 1, age: 0, error: null }];
  expect(storageItems(s).map((item) => item.kind)).toEqual([
    "filesystem",
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
    {
      name: "nvme0n1",
      number: "259:0",
      model: null,
      lifetimeWritten: 1e13,
      source: "smartctl",
    },
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
  // Keyed by the device these two groups share one key, which React reports as
  // unsupported: it may duplicate or omit a child, and which it does is not
  // ours to choose. This render still draws both, so the frame cannot show the
  // collision; React's same-key warning is the only place it is stated, and
  // the warning gate preloaded from `src/test/warnings.ts` fails this test on it.
  let frame = "";
  const t = await mount(s, c, { width: 140, height: 30 });
  try {
    await t.press("5");
    frame = t.frame();
  } finally {
    await t.close();
  }
  expect([frame.includes("/one"), frame.includes("/two")]).toEqual([
    true,
    true,
  ]);
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
    // The filesystem's integrity row is the first of the region; its mount
    // sits under it.
    await t.press("down");
    const lines = t.frame().split("\n");
    const row = lines.findIndex((line) => line.includes("▾ /data"));
    expect(row).toBeGreaterThan(-1);
    expect(isChildLine(present(lines[row], "the /data row"))).toBe(false);
    expect(isChildLine(present(lines[row + 1], "the line under /data"))).toBe(
      true,
    );
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
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press("5");
    // The filesystem's integrity row opens first. The lifetime counter is one
    // level under it, stated once for every mount grouped under it.
    const opened = t.frame();
    expect(opened.split("corruption 3").length - 1).toBe(1);
    expect(opened).toContain("counts reads that failed their checksum");
    // The mount below carries only what differs between mounts, and no copy
    // of the counter the filesystem above already stated.
    await t.press("down");
    const mounted = t.frame();
    expect(mounted).toContain("subvol=@data");
    expect(mounted).not.toContain("corruption 3");
    expect(mounted).not.toContain("Errors");
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
    {
      path: "/scratch/a",
      bytes: 10,
      age: 0,
      error: null,
      origin: "configured",
    },
    {
      path: "/scratch/b",
      bytes: 20,
      age: 0,
      error: null,
      origin: "configured",
    },
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
      // The filesystems region holds each filesystem's integrity row and the
      // mounts under it, so its first row is an integrity line.
      const steps: [string[], string][] = [
        [[], "Never checked"],
        [["down"], "/data"],
        [[back], "/data"],
        [Array(10).fill("down"), "/home"],
        [[forward], "/run/btrfs-scrub/one"],
        [[forward], "/scratch/a"],
        [[forward], "/scratch/a"],
        [["down", forward], "/scratch/b"],
        [[back], "/run/btrfs-scrub/one"],
        [[back], "Never checked"],
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
      expect(selectedRow(t.frame())).toContain("Never checked");
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
      [[c.keys.filesystems], "Never checked"],
      [["down"], "/data"],
      [[c.keys.filesystems], "Never checked"],
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
    expect(selectedRow(t.frame())).toContain("/data");
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
  // Each filesystem states its identity once, above the mounts under it.
  expect(storageItems(s).map(itemPath)).toEqual([
    "one",
    "/a",
    "/c",
    "two",
    "/b",
  ]);
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
  expect(groups[0]?.volumes.map((v) => v.mount)).toEqual([
    "/data",
    "/data/home",
    "/data/log",
  ]);
  // The heading still names a device a reader would type.
  expect(groups[0]?.device).toBe("/dev/mapper/pool");
  expect(groups[1]?.volumes.map((v) => v.mount)).toEqual(["/other"]);
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
      onCopy: () => {},
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
      await act(async () => {
        ui.renderer.destroy();
      });
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

/** A filesystem whose last check found damage under two names and one letter. */
function damagedSnapshot(time: number) {
  const s = emptySnapshot(time);
  s.storage.volumes = [
    volumeSnapshot("/", {
      device: "/dev/nvme0n1p2",
      fsid: "fs",
      errors: { "1/corruption_errs": 1390 },
      countersAvailable: true,
      lastErrorAt: time - 31 * 3600000,
      lastErrorSize: 26,
    }),
  ];
  s.storage.scrubs = [
    {
      path: "/run/btrfs-scrub/root.result",
      text: "Error summary:    csum=26",
      problem: true,
      readable: true,
      fsid: "fs",
      startedAt: time - 3600000,
      status: "finished",
      uncorrectable: 26,
      addresses: [
        {
          logical: 953118621696,
          paths: [
            "/r/target/debug/build-script-build",
            "/r/target/debug/bsb-c664",
          ],
        },
        { logical: 1597612883968, paths: ["/home/reader/letter.txt"] },
        { logical: 1597612883969, paths: [] },
      ],
    },
  ];
  return s;
}

test("a damaged filesystem lists every file each damaged address may hold", async () => {
  const c = defaults();
  const time = 1_760_000_000_000;
  const s = damagedSnapshot(time);
  const t = await mount(s, c, { width: 160, height: 60 });
  try {
    await t.press("5");
    const frame = t.frame();
    // The line itself, before anything is opened.
    expect(frame).toContain("Damage found: 3 possibly damaged files");
    expect(frame).toContain("last full check 1.0h ago");
    expect(frame).toContain("last new error 31.0h ago");
    // Both names of the first address and the letter, each possibly
    // damaged: the report names the block's start, not the damaged file, so
    // no line offers to remove one.
    expect(frame).toContain("/r/target/debug/build-script-build");
    expect(frame).toContain("/r/target/debug/bsb-c664");
    expect(frame).toContain("/home/reader/letter.txt");
    expect(frame).toContain("possibly damaged");
    // The sentence wraps; its opening sits whole on its first row.
    expect(frame).toContain(possibleSentence.slice(0, 40));
    expect(frame).not.toContain("rm -f");
    expect(frame).toContain("free space or already deleted");
    // The counter is explained where it is shown, one level under the line.
    expect(frame).toContain("counts reads that failed their checksum");
    expect(frame).toContain("corruption 1390");
    // The report's own words are a third idea under the counter, so a blank
    // row of the same block stands between them: the rule runs down it and no
    // word does.
    const rows = frame.split("\n");
    const counter = rows.findIndex((row) => row.includes("corruption 1390"));
    expect(rows[counter + 1]?.trim()).toBe("│");
    expect(rows[counter + 2]).toContain("Error summary:    csum=26");
  } finally {
    await t.close();
  }
});

test("a removed file leaves the list and the filesystem stops reading damaged", async () => {
  const c = defaults();
  const time = 1_760_000_000_000;
  const s = damagedSnapshot(time);
  const t = await mount(s, c, { width: 160, height: 60 });
  try {
    await t.press("5");
    expect(t.frame()).toContain("/home/reader/letter.txt");
    expect(t.frame()).toContain(possibleSentence.slice(0, 40));
    // The next sample carries the report with nothing left on disk under it,
    // which is what the collector produces once the reader removes the files.
    const cleared = damagedSnapshot(time + 1000);
    const scrub = present(cleared.storage.scrubs[0], "the scrub report");
    scrub.addresses = [];
    scrub.uncorrectable = 0;
    scrub.problem = false;
    await t.update(cleared);
    const frame = t.frame();
    expect(frame).not.toContain("/home/reader/letter.txt");
    // With no file listed there is nothing to call possibly damaged.
    expect(frame).not.toContain(possibleSentence.slice(0, 40));
    // The check that found nothing ran after the counter last grew, so the
    // filesystem has been read end to end since the last error.
    expect(frame).toContain("Healthy");
    expect(frame).toContain("No damaged address is left on this filesystem.");
  } finally {
    await t.close();
  }
});

test("the copy key on a damaged filesystem copies nothing, because no file is named exactly", async () => {
  const c = defaults();
  const time = 1_760_000_000_000;
  const t = await mount(damagedSnapshot(time), c, { width: 160, height: 60 });
  try {
    await t.press("5");
    await t.press(c.keys.copy);
    expect(t.written).toEqual([]);
  } finally {
    await t.close();
  }
});

/**
 * A machine with no scrub reporter: one filesystem, no report directory, and
 * the kernel log as the caller says.
 */
function unreportedSnapshot(
  time: number,
  csumFailures: Snapshot["storage"]["csumFailures"],
) {
  const s = emptySnapshot(time);
  s.capabilities = s.capabilities.map((cap) =>
    cap.id === "scrub"
      ? {
          ...cap,
          available: false,
          failure: "absent" as const,
          source: "/run/btrfs-scrub",
          detail: "ENOENT: no such file or directory",
        }
      : cap,
  );
  s.storage.volumes = [
    volumeSnapshot("/", {
      device: "/dev/nvme0n1p2",
      fsid: "fs",
      errors: { "1/corruption_errs": 0 },
      countersAvailable: true,
    }),
  ];
  s.storage.csumFailures = csumFailures;
  return s;
}

test("a machine with no scrub reporter says so and copies the command that installs one", async () => {
  const c = defaults();
  const time = 1_760_000_000_000;
  const t = await mount(unreportedSnapshot(time, null), c, {
    width: 160,
    height: 60,
  });
  try {
    await t.press("5");
    const frame = t.frame();
    expect(frame).toContain(
      "Never checked: no readable scrub report directory",
    );
    expect(frame).toContain("No scrub reporter is installed");
    expect(frame).toContain(reporterInstall);
    expect(frame).not.toContain("Healthy");
    await t.press(c.keys.copy);
    expect(t.written).toEqual([osc52(reporterInstall)]);
  } finally {
    await t.close();
  }
  // A reader who pointed the reports elsewhere runs a reporter of their own,
  // so the shipped one is not offered.
  const elsewhere = { ...c, scrubDir: "/srv/checks" };
  const other = await mount(unreportedSnapshot(time, null), elsewhere, {
    width: 160,
    height: 60,
  });
  try {
    await other.press("5");
    expect(other.frame()).not.toContain(reporterInstall);
    await other.press(c.keys.copy);
    expect(other.written).toEqual([]);
  } finally {
    await other.close();
  }
});

test("the install line is offered only where installing fills the gap, and copies on a pinned sample", async () => {
  const c = defaults();
  const time = 1_760_000_000_000;
  // A pinned sample copies the install line: it names no file that could
  // have changed since.
  const pinned = await mount(unreportedSnapshot(time, null), c, {
    width: 160,
    height: 60,
  });
  try {
    await pinned.press("5");
    await pinned.press(c.keys.pin);
    await pinned.press(c.keys.copy);
    expect(pinned.written).toEqual([osc52(reporterInstall)]);
  } finally {
    await pinned.close();
  }
  // A directory that exists and cannot be read is not fixed by installing
  // anything, so it is offered no install line and copies nothing.
  const unreadable = unreportedSnapshot(time, null);
  unreadable.capabilities = unreadable.capabilities.map((cap) =>
    cap.id === "scrub"
      ? { ...cap, failure: "unreadable" as const, detail: "EACCES" }
      : cap,
  );
  const t = await mount(unreadable, c, { width: 160, height: 60 });
  try {
    await t.press("5");
    expect(t.frame()).not.toContain(reporterInstall);
    await t.press(c.keys.copy);
    expect(t.written).toEqual([]);
  } finally {
    await t.close();
  }
});

/**
 * Two drives and the drive report directory as the caller says: present, or
 * absent with udisks answering or not.
 */
function lifetimeSnapshot(
  smart: "reports" | "absent",
  devices: Snapshot["storage"]["devices"],
  udisks: Snapshot["storage"]["udisks"],
) {
  const s = emptySnapshot();
  // `collector.ts` stands the capability up wherever a device already carries
  // a udisks-sourced write, whatever the report directory itself says, so an
  // "absent" directory with such a device is still available here, as it is
  // in the real collector.
  const udisksSupplies = (devices ?? []).some((d) => d.source === "udisks");
  s.capabilities = s.capabilities.map((cap) =>
    cap.id === "smart" && smart === "absent" && !udisksSupplies
      ? {
          ...cap,
          available: false,
          failure: "absent" as const,
          source: "/run/smartctl",
          detail: "ENOENT: no such file or directory",
        }
      : cap,
  );
  s.storage.devices = devices;
  if (udisks !== undefined) s.storage.udisks = udisks;
  return s;
}
const unknownDrive = {
  name: "sda",
  number: "8:0",
  model: null,
  lifetimeWritten: null,
  source: null,
};

test("drive lifetime writes name their source, and a machine with neither source is offered the reporter", async () => {
  const c = defaults();
  const rows = [
    {
      name: "a timer's reports",
      snapshot: lifetimeSnapshot(
        "reports",
        [
          {
            name: "nvme0n1",
            number: "259:0",
            model: null,
            lifetimeWritten: 1e13,
            source: "smartctl" as const,
          },
          unknownDrive,
        ],
        undefined,
      ),
      shows: [/nvme0n1\s+█+\s+9\.1 TiB\s+smartctl/],
      hides: [
        "udisks2",
        driveReporterInstall,
        "Drive lifetime reports: not available",
      ],
    },
    {
      // No report directory exists, but the capability still stands up: a
      // device already carries a udisks-sourced write, so Settings must never
      // say Storage has no drive lifetime writes while this row has one.
      name: "udisks alone",
      snapshot: lifetimeSnapshot(
        "absent",
        [
          {
            name: "nvme0n1",
            number: "259:0",
            model: null,
            lifetimeWritten: 1e13,
            source: "udisks" as const,
          },
          unknownDrive,
        ],
        null,
      ),
      shows: [
        /nvme0n1\s+█+\s+9\.1 TiB\s+udisks2/,
        "udisks2 answered in its place",
      ],
      hides: [
        /9\.1 TiB\s+smartctl/,
        "Drive lifetime reports: not available",
        "no readable drive report directory",
        driveReporterInstall,
      ],
    },
    {
      name: "neither source",
      snapshot: lifetimeSnapshot("absent", [unknownDrive], {
        failure: "absent",
        detail: "Failed to connect to bus: No such file or directory",
      }),
      shows: [
        "Drive lifetime reports: not available: no readable drive report directory",
        "udisks2 is unavailable",
        "No drive reporter is installed",
        driveReporterInstall,
      ],
      hides: ["9.1 TiB"],
    },
  ];
  for (const row of rows) {
    const t = await mount(row.snapshot, c, { width: 200, height: 60 });
    try {
      await t.press("5");
      const frame = t.frame();
      const has = (text: string | RegExp) =>
        typeof text === "string" ? frame.includes(text) : text.test(frame);
      for (const shown of row.shows)
        expect({ row: row.name, shown, found: has(shown) }).toEqual({
          row: row.name,
          shown,
          found: true,
        });
      for (const hidden of row.hides)
        expect({ row: row.name, hidden, found: has(hidden) }).toEqual({
          row: row.name,
          hidden,
          found: false,
        });
    } finally {
      await t.close();
    }
  }
  // A reader who pointed the reports elsewhere runs a timer of their own, so
  // the shipped one is not offered.
  const elsewhere = await mount(
    lifetimeSnapshot("absent", [unknownDrive], null),
    { ...c, smartDir: "/srv/smart" },
    { width: 200, height: 60 },
  );
  try {
    await elsewhere.press("5");
    expect(elsewhere.frame()).not.toContain(driveReporterInstall);
  } finally {
    await elsewhere.close();
  }
});

test("udisksText gives every CapabilityFailure, and the null outcome, its own sentence", () => {
  const detail = "unit-test detail";
  // The fragment each failure's sentence is known by. unreadable and masked
  // share one switch branch and so share one fragment by design.
  const fragmentByFailure: Record<CapabilityFailure, string> = {
    absent: "is unavailable",
    unreadable: "did not answer",
    masked: "did not answer",
    incomplete: "answered for no drive",
    malformed: "not in the expected format",
  };
  const nullFragment = "answered in its place";
  const allFragments = [
    nullFragment,
    ...new Set(Object.values(fragmentByFailure)),
  ];
  const rows: Array<{
    name: string;
    outcome: { failure: CapabilityFailure; detail: string } | null;
    fragment: string;
  }> = [
    { name: "null", outcome: null, fragment: nullFragment },
    ...(Object.keys(fragmentByFailure) as CapabilityFailure[]).map(
      (failure) => ({
        name: failure,
        outcome: { failure, detail },
        fragment: fragmentByFailure[failure],
      }),
    ),
  ];
  for (const { name, outcome, fragment } of rows) {
    const text = udisksText(outcome);
    expect({ name, text, hasOwn: text.includes(fragment) }).toEqual({
      name,
      text,
      hasOwn: true,
    });
    if (outcome !== null)
      expect({ name, hasDetail: text.includes(detail) }).toEqual({
        name,
        hasDetail: true,
      });
    for (const other of allFragments) {
      if (other === fragment) continue;
      expect({ name, other, hasOther: text.includes(other) }).toEqual({
        name,
        other,
        hasOther: false,
      });
    }
  }
});

test("with only the kernel log, a filesystem still dates its last new error", async () => {
  const c = defaults();
  const time = 1_760_000_000_000;
  const t = await mount(
    unreportedSnapshot(time, {
      fs: [{ root: 257, inode: 4242, at: time - 7200000 }],
    }),
    c,
    { width: 160, height: 60 },
  );
  try {
    await t.press("5");
    const frame = t.frame();
    expect(frame).toContain("New errors since last check");
    expect(frame).toContain("last new error 2.0h ago (kernel log)");
    expect(frame).toContain("inode 4242 in subvolume 257, logged 2.0h ago");
  } finally {
    await t.close();
  }
});

test("the scratch heading and its empty line are decided together", () => {
  const row = (path: string) => ({
    path,
    bytes: 1,
    age: 0,
    modifiedAt: null,
    error: null,
    origin: "configured" as const,
  });
  const rows: [
    string,
    string[],
    Partial<Snapshot["storage"]>,
    string,
    string | null,
  ][] = [
    // No roots and no reading: the section says so, and says it once.
    [
      "unconfigured",
      [],
      { scratchTime: 1000 },
      "measured ",
      "No scratch directory is configured.",
    ],
    // The shipped roots were measured and none is on this machine. That is a
    // reading, so it is neither a scan still to come nor a failure.
    [
      "default roots absent",
      ["/default"],
      { scratchTime: 1000, scratchAbsent: ["/default"] },
      "measured ",
      "None of the default scratch directories exists here.",
    ],
    // Roots set and the first traversal running. A reader who set them is
    // never told that none are set.
    [
      "first scan",
      ["/scratch"],
      { scratchPending: true },
      "measuring",
      "The configured scratch directories have not been measured yet.",
    ],
    [
      "first scan failed",
      ["/scratch"],
      {},
      "not measured yet",
      "The configured scratch directories have not been measured yet.",
    ],
    // The roots were cleared and the rows measured under them are still on
    // the screen, which is the frame between a settings change and its first
    // sample. Rows present are a reading, so no line denies them.
    [
      "cleared with stale rows",
      [],
      { scratch: [row("/scratch")], scratchTime: 1000 },
      "measured ",
      null,
    ],
    [
      "session rows only",
      [],
      { sessions: [row("/scratch/s")] },
      "not measured yet",
      null,
    ],
  ];
  for (const [name, scratchDirs, storage, state, empty] of rows) {
    const s = emptySnapshot();
    const summary = scratchSummary(
      { ...defaults(), scratchDirs },
      { ...s.storage, ...storage },
    );
    // The measured state carries a clock reading, so the row pins its words.
    expect({ name, states: summary.state.startsWith(state), empty }).toEqual({
      name,
      states: true,
      empty: summary.empty,
    });
  }
});

test("scratch roots with no reading yet are measuring, not unconfigured", async () => {
  const rows: [string[], boolean, string][] = [
    [[], false, "No scratch directory is configured."],
    [["/scratch"], true, "have not been measured yet"],
    [["/scratch"], false, "have not been measured yet"],
  ];
  for (const [scratchDirs, scratchPending, expected] of rows) {
    const c = { ...defaults(), scratchDirs };
    const s = emptySnapshot();
    s.storage.scratchPending = scratchPending;
    const t = await mount(s, c, { width: 140, height: 40 });
    try {
      await t.press("5");
      const frame = t.frame();
      expect({ scratchDirs, shown: frame.includes(expected) }).toEqual({
        scratchDirs,
        shown: true,
      });
      // A reader who has set roots is never told that none are set.
      expect({
        scratchDirs,
        denied:
          scratchDirs.length > 0 &&
          frame.includes("No scratch directory is configured."),
      }).toEqual({ scratchDirs, denied: false });
    } finally {
      await t.close();
    }
  }
});

test("each scratch root says where it came from under its row", async () => {
  const s = emptySnapshot();
  const root = (path: string, origin: ScratchOrigin | null) => ({
    path,
    bytes: 1,
    age: 0,
    error: null,
    origin,
  });
  s.storage.scratch = [
    root("/typed", "configured"),
    root("/shipped", "default"),
    root("/agent", "agent"),
    // A row an older build stored, whose origin is not known.
    root("/stored", null),
  ];
  s.storage.sessions = [{ path: "/agent/s", bytes: 1, age: 0, error: null }];
  // The narrowest terminal the screen is drawn for: an origin after the
  // row's fixed columns would start past its last column.
  const t = await mount(s, defaults(), { width: 80, height: 40 });
  try {
    await t.press("5");
    // Only the selected root opens its detail: with /typed selected, the
    // root under it says nothing about where it came from.
    const opened = t.frame().split("\n");
    const shipped = opened.findIndex((line) => line.includes("/shipped "));
    expect(opened[shipped + 1]).not.toContain("Origin");
    const origins: Record<string, string | null> = {};
    for (const path of [
      "/typed",
      "/shipped",
      "/agent",
      "/stored",
      "/agent/s",
    ]) {
      const lines = t.frame().split("\n");
      const row = lines.findIndex((line) => line.includes(`${path} `));
      expect(selectedRow(t.frame())).toContain(`${path} `);
      const under = lines[row + 1] ?? "";
      origins[path] = under.includes("Origin")
        ? under.slice(under.indexOf("Origin") + "Origin".length).trim()
        : null;
      await t.press("down");
    }
    expect(origins).toEqual({
      "/typed": "configured",
      "/shipped": "default setting",
      "/agent": "found on an agent",
      "/stored": null,
      // A session sits under its root and repeats nothing about it.
      "/agent/s": null,
    });
  } finally {
    await t.close();
  }
});

test("a missing scratch root's error follows its age on the row", async () => {
  const s = emptySnapshot();
  const error = "No such file or directory";
  s.storage.scratch = [
    { path: "/typed", bytes: null, age: 0, error, origin: "configured" },
  ];
  const t = await mount(s, defaults(), { width: 120, height: 30 });
  try {
    await t.press("5");
    const line =
      t
        .frame()
        .split("\n")
        .find((row) => row.includes("/typed ")) ?? "";
    expect(line.trimEnd().endsWith(`ago  ${error}`)).toBe(true);
  } finally {
    await t.close();
  }
});

test("every kind of Storage row is placed, marked, opened and followed by one rule", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes = [volumeSnapshot("/data", { device: "/dev/data" })];
  s.storage.scrubs = [
    { path: "/run/btrfs-scrub/data", text: "clean", problem: false },
  ];
  s.storage.scratch = [
    {
      path: "/scratch/root",
      bytes: 1,
      age: 0,
      error: null,
      origin: "configured",
    },
  ];
  s.storage.sessions = [
    { path: "/scratch/session", bytes: 1, age: 0, error: null },
  ];
  const items = storageItems(s);
  // Every kind the screen draws is in the fixture. The set is the type's own:
  // a kind added to `StorageItem` and missing here fails to compile, so this
  // test cannot quietly narrow when the fixture changes.
  const kinds: Record<StorageItem["kind"], true> = {
    filesystem: true,
    volume: true,
    scrub: true,
    scratch: true,
  };
  for (const kind of Object.keys(kinds))
    expect({ kind, drawn: items.some((item) => item.kind === kind) }).toEqual({
      kind,
      drawn: true,
    });
  // A scratch row is a root or a session, and both are drawn.
  expect(
    items.flatMap((item) => (item.kind === "scratch" ? [item.session] : [])),
  ).toEqual([false, true]);
  /** Whether `line` names `path` as a word, not as the tail of a longer one. */
  const names = (line: string, path: string) =>
    line.split(/[\s▍▸]+/).includes(path);
  /**
   * Whether the marked row is `item`. A filesystem's row is its integrity
   * line, which two filesystems in one state share, so it is told by the
   * device heading drawn above it; every other row carries its own path.
   */
  const marks = (frame: string, item: StorageItem) => {
    const lines = frame.split("\n");
    const y = lines.findIndex((line) => line.includes("▍"));
    if (y < 0) return false;
    return item.kind === "filesystem"
      ? present(lines[y - 1], "the line above the marked row").includes(
          "/dev/data",
        )
      : names(present(lines[y], "the marked row"), itemPath(item));
  };
  // A filesystem that sorts above every row, arriving with a sample, so each
  // row's number names another row afterwards.
  const later: Snapshot = {
    ...s,
    time: s.time + 1000,
    storage: {
      ...s.storage,
      volumes: [
        volumeSnapshot("/aaa", { device: "/dev/aaa" }),
        ...s.storage.volumes,
      ],
    },
  };
  const counts = [
    items.filter((item) => item.kind === "filesystem" || item.kind === "volume")
      .length,
    items.filter((item) => item.kind === "scrub").length,
    items.filter((item) => item.kind === "scratch").length,
  ];
  for (const [at, item] of items.entries()) {
    const key = `${item.kind} ${itemPath(item)}`;
    // Reached from the keyboard on a terminal too short to hold the screen,
    // so the row is only on it if the scroll found it.
    const region = regionOf(counts, at);
    const [start] = present(regionRanges(counts)[region], `region ${region}`);
    const offset = at - start;
    const t = await mount(s, c, { width: 140, height: 16 });
    try {
      await t.press("5");
      // A reader arrives at a screen that has finished drawing itself.
      await t.settle();
      await t.press(
        c.keys[present(storageRegions[region], `region ${region}`).action],
      );
      for (let i = 0; i < offset; i++) await t.press("down");
      await t.settle();
      expect({ key, marked: marks(t.frame(), item) }).toEqual({
        key,
        marked: true,
      });
      await t.update(later);
      await t.settle();
      expect({ key, followed: marks(t.frame(), item) }).toEqual({
        key,
        followed: true,
      });
    } finally {
      await t.close();
    }
    // Reached with the mouse, on a terminal that holds every row.
    const m = await mount(s, c, { width: 140, height: 60 });
    try {
      await m.press("5");
      const lines = m.frame().split("\n");
      const heading = lines.findIndex((line) => line.includes("/dev/data"));
      const y =
        item.kind === "filesystem"
          ? heading + 1
          : lines.findIndex((line) => names(line, itemPath(item)));
      await m.click(4, y);
      expect({ key, clicked: marks(m.frame(), item) }).toEqual({
        key,
        clicked: true,
      });
    } finally {
      await m.close();
    }
  }
});

test("two arrows that arrive before a render move Storage two rows", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.scratch = ["/scratch/a", "/scratch/b", "/scratch/c"].map(
    (path) => ({ path, bytes: 1, age: 0, error: null, origin: "configured" }),
  );
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press("5");
    await t.press(c.keys.scratch);
    expect(selectedRow(t.frame())).toContain("/scratch/a");
    await t.pressTogether(["down", "down"]);
    expect(selectedRow(t.frame())).toContain("/scratch/c");
  } finally {
    await t.close();
  }
});

/** One filesystem with two mounts, a scrub report and two scratch roots. */
function wheelList() {
  const s = emptySnapshot();
  s.storage.volumes = [
    volumeSnapshot("/data", { device: "/dev/sda1", fsid: "sda1" }),
    volumeSnapshot("/home", { device: "/dev/sda1", fsid: "sda1" }),
  ];
  s.storage.scrubs = [
    { path: "/run/btrfs-scrub/one", text: "clean", problem: false },
  ];
  s.storage.scratch = ["/scratch/a", "/scratch/b"].map((path) => ({
    path,
    bytes: 1,
    age: 0,
    error: null,
    origin: "configured" as const,
  }));
  return s;
}

/** The thirty files the tall detail names, first to last. */
const tallFiles = Array.from(
  { length: 30 },
  (_, i) => `/home/reader/file-${String(i).padStart(2, "0")}.txt`,
);
/**
 * A damaged filesystem whose detail names every one of `tallFiles`, taller
 * than any screen the wheel table uses, with a clean filesystem above it and
 * the scrub report and two scratch roots below it.
 */
function tallDetail() {
  const s = damagedSnapshot(1_760_000_000_000);
  present(s.storage.scrubs[0], "the scrub report").addresses = tallFiles.map(
    (path, i) => ({
      logical: 1000 + i,
      paths: [path],
    }),
  );
  s.storage.volumes = [
    volumeSnapshot("/data", { device: "/dev/sda1", fsid: "sda1" }),
    ...s.storage.volumes,
  ];
  s.storage.scratch = wheelList().storage.scratch;
  return s;
}

test("each rule the Storage wheel follows", async () => {
  type Mounted = Awaited<ReturnType<typeof mount>>;
  const c = defaults();
  /** The line of the marked row, which a notch is turned over. */
  const marked = (t: Mounted) =>
    t
      .frame()
      .split("\n")
      .findIndex((line) => line.includes("▍"));
  /** The selected row, named by the label it carries. */
  const on = (t: Mounted) => {
    const row = selectedRow(t.frame());
    const labels = [
      "Never checked",
      "/data",
      "/home",
      "/run/btrfs-scrub/one",
      "/scratch/a",
      "/scratch/b",
    ];
    return labels.find((label) => row.includes(label)) ?? row;
  };
  /** The first line drawn under the header, without rules or scrollbar. */
  const top = (t: Mounted) =>
    t
      .frame()
      .split("\n")
      .slice(2)
      .map((line) => line.replace(/[─▀▄█]/g, "").trim())
      .find((line) => line !== "");
  /**
   * Turns the wheel `way` until the selection leaves the tall row, and lists
   * in order the first frame drawing `watch` and the notch that moved on.
   * Whether `watch` was drawn before the first notch leads the list.
   */
  const readTall = async (t: Mounted, way: "up" | "down", watch: string) => {
    const seen: (string | boolean)[] = [t.frame().includes(watch)];
    for (let notch = 0; notch < 200; notch++) {
      await t.wheel(10, 8, way);
      await t.settle();
      if (!seen.includes(watch) && t.frame().includes(watch)) seen.push(watch);
      const row = selectedRow(t.frame());
      if (row !== "" && !row.includes("Damaged files found")) {
        seen.push("moved on");
        break;
      }
    }
    return seen;
  };
  // The rule, the screen, the keys pressed on Storage before the wheel, what
  // the wheel does and reads back, and what it must read.
  const rows: {
    rule: string;
    snapshot: () => Snapshot;
    height: number;
    keys: string[];
    wheel: (t: Mounted) => Promise<unknown>;
    expected: unknown;
  }[] = [
    {
      // The arrows stop at a list's end; the wheel walks on into the next,
      // and stops at the last row.
      rule: "a notch moves one row, through every list",
      snapshot: wheelList,
      height: 44,
      keys: [],
      wheel: async (t) => {
        const y = marked(t);
        const ways = [
          "down",
          "down",
          "down",
          "down",
          "up",
          "down",
          "down",
        ] as const;
        const reached = [];
        for (const way of [...ways, "down"] as const) {
          await t.wheel(10, y, way);
          reached.push(on(t));
        }
        return reached;
      },
      expected: [
        "/data",
        "/home",
        "/run/btrfs-scrub/one",
        "/scratch/a",
        "/run/btrfs-scrub/one",
        "/scratch/a",
        "/scratch/b",
        "/scratch/b",
      ],
    },
    {
      // An arrow from /data to /home leaves this heading on top.
      rule: "a notch that moves the selection scrolls no further than an arrow",
      snapshot: wheelList,
      height: 16,
      keys: ["down"],
      wheel: async (t) => {
        await t.wheel(10, marked(t), "down");
        await t.settle();
        return { on: on(t), top: top(t) };
      },
      expected: { on: "/home", top: "Drive lifetime writes" },
    },
    {
      // Down to the scratch list and back: the write totals are above the
      // fold, and nothing above the first row is selectable.
      rule: "a notch the selection cannot take scrolls the screen",
      snapshot: wheelList,
      height: 16,
      keys: ["right", "right", "right", "left", "left", "left"],
      wheel: async (t) => {
        const y = marked(t);
        for (let i = 0; i < 15; i++) await t.wheel(10, y, "up");
        await t.settle();
        return { on: on(t), top: top(t) };
      },
      expected: { on: "Never checked", top: "Written since boot" },
    },
    {
      // Reached from /data, the tall row is drawn from its top.
      rule: "a notch down reads an open detail to its end before moving on",
      snapshot: tallDetail,
      height: 24,
      keys: ["down", "down"],
      wheel: (t) =>
        readTall(t, "down", present(tallFiles[29], "the last tall file")),
      expected: [false, tallFiles[29], "moved on"],
    },
    {
      // Turned over the scrollbar, the wheel scrolls the box alone, which
      // leaves the tall row drawn to its end.
      rule: "a notch up reads an open detail back to its start before moving on",
      snapshot: tallDetail,
      height: 24,
      keys: ["down", "down"],
      wheel: async (t) => {
        for (let i = 0; i < 60; i++) await t.wheel(119, 8, "down");
        await t.settle();
        return readTall(t, "up", present(tallFiles[0], "the first tall file"));
      },
      expected: [false, tallFiles[0], "moved on"],
    },
    {
      // Four notches before a render. The later ones step from rows the
      // earlier ones chose, not drawn open yet, the last from a scratch root
      // below the fold, and each still moves a row.
      rule: "a fast flick steps from the row last chosen",
      snapshot: wheelList,
      height: 16,
      keys: ["down"],
      wheel: async (t) => {
        const y = marked(t);
        await act(async () => {
          for (let i = 0; i < 4; i++)
            await t.ui.mockMouse.scroll(10, y, "down");
        });
        await t.settle();
        return on(t);
      },
      expected: "/scratch/b",
    },
    {
      rule: "with no row to select, a notch scrolls the screen",
      snapshot: () => emptySnapshot(),
      height: 12,
      keys: [],
      wheel: async (t) => {
        for (let i = 0; i < 30; i++) await t.wheel(10, 4, "down");
        await t.settle();
        return top(t);
      },
      expected: "f Filesystems",
    },
  ];
  for (const row of rows) {
    const size = { width: 120, height: row.height };
    const t = await mount(row.snapshot(), c, size);
    try {
      await t.press("5");
      await t.settle();
      for (const key of row.keys) {
        await t.press(key);
        await t.settle();
      }
      expect({ rule: row.rule, got: await row.wheel(t) }).toEqual({
        rule: row.rule,
        got: row.expected,
      });
    } finally {
      await t.close();
    }
  }
});

test("two mounts stacked at one path are two rows a reader can stand on", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // One filesystem mounted twice at one path: one heading, its integrity
  // row, and two mount rows that read alike.
  s.storage.volumes = [
    volumeSnapshot("/data", { options: ["subvol=/a"] }),
    volumeSnapshot("/data", { options: ["subvol=/b"] }),
  ];
  /** The frame's line numbers of the two mount rows, and of the marked row. */
  const lines = (frame: string) => {
    const all = frame.split("\n");
    return {
      mounts: all.flatMap((line, at) =>
        /[▸▾] \/data\b/.test(line) ? [at] : [],
      ),
      marked: all.findIndex((line) => line.includes("▍")),
    };
  };
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press("5");
    const steps: [presses: number, mount: number][] = [
      [1, 0],
      [2, 1],
    ];
    for (const [presses, mount] of steps) {
      await t.press(c.keys.filesystems);
      for (let i = 0; i < presses; i++) await t.press("down");
      const at = lines(t.frame());
      expect(at.mounts.length).toBe(2);
      expect({ presses, marked: at.marked }).toEqual({
        presses,
        marked: present(at.mounts[mount], `mount ${mount}`),
      });
    }
    for (const mount of [0, 1, 0]) {
      const y = present(lines(t.frame()).mounts[mount], `mount ${mount}`);
      await t.click(4, y);
      expect({ mount, marked: lines(t.frame()).marked }).toEqual({
        mount,
        marked: present(lines(t.frame()).mounts[mount], `mount ${mount}`),
      });
    }
  } finally {
    await t.close();
  }
});
