// Cloud defect review 8, finding: a Btrfs mount made read-only by design reads as forced read-only.
// Run from the repository root: bun test review/tests/btrfs-readonly.test.ts
import { expect, test } from "bun:test";
import { btrfsMounts } from "../../src/collect/btrfs";
import { parseMounts } from "../../src/collect/mounts";

// Fedora Atomic (Silverblue/Kinoite) on Btrfs mounts /sysroot and the /usr
// bind mount read-only per mount while the superblock stays rw, because
// /var/home on the same filesystem is written. Btrfs forcing a filesystem
// read-only after an error sets SB_RDONLY, which mountinfo shows in the
// superblock options after " - ", never in the per-mount options.
const atomic = [
  "60 1 0:31 /root /sysroot ro,relatime shared:4 - btrfs /dev/nvme0n1p3 rw,seclabel,compress=zstd:1,ssd,space_cache=v2,subvolid=256,subvol=/root",
  "61 60 0:31 /root/ostree/deploy/fedora/deploy/abc.0/usr /usr ro,relatime shared:5 - btrfs /dev/nvme0n1p3 rw,seclabel,compress=zstd:1,ssd,space_cache=v2,subvolid=256,subvol=/root",
  "62 1 0:31 /home /var/home rw,relatime shared:6 - btrfs /dev/nvme0n1p3 rw,seclabel,compress=zstd:1,ssd,space_cache=v2,subvolid=257,subvol=/home",
].join("\n");

test("a mount made read-only by design is not a filesystem forced read-only", () => {
  const mounts = btrfsMounts(parseMounts(atomic));
  expect(mounts.map((m) => [m.mount, m.readOnly])).toEqual([
    ["/sysroot", false],
    ["/usr", false],
    ["/var/home", false],
  ]);
});

test("control: the superblock flag still reads as forced read-only", () => {
  const [m] = btrfsMounts(
    parseMounts("60 1 0:31 / /mnt rw,relatime - btrfs /dev/sda1 ro,space_cache=v2"),
  );
  expect(m?.readOnly).toBe(true);
});
