import { expect, test } from "bun:test";
import { defaults } from "../../src/config/config";
import { volumesByDevice } from "../../src/model/integrity";
import { emptySnapshot, volumeSnapshot } from "../../src/test/fixture";
import { mount } from "../../src/test/harness";

// The common Btrfs layout: root and home are two subvolumes of one filesystem,
// so they carry one filesystem id. Storage groups them under one filesystem.
test("the Filesystems heading counts filesystems, not mounts", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const fsid = "4a1d9c0e-0000-4000-8000-000000000001";
  s.storage.volumes = [
    volumeSnapshot("/", { fsid, device: "/dev/nvme0n1p2" }),
    volumeSnapshot("/home", { fsid, device: "/dev/nvme0n1p2" }),
  ];
  expect(volumesByDevice(s.storage.volumes)).toHaveLength(1);
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press(c.keys.storage);
    const frame = t.frame();
    const heading = frame.split("\n").find((l) => l.includes("Filesystems"));
    if (process.env.SHOW) console.log(frame);
    expect(heading).toMatch(/Filesystems\s+1\s/);
  } finally {
    await t.close();
  }
});
