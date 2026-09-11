# Storage and devices

Covers: src/collect/btrfs.ts src/collect/devices.ts src/collect/mounts.ts src/collect/scratch.ts src/model/writes.ts src/ui/storage-screen.tsx

Storage collection reads filesystem state, device counters, drive reports and scratch sizes. A counter the kernel or a drive did not report stays unknown rather than becoming a zero.

## Boundaries

- The mount parser owns mount roots and path escaping for both cgroup and filesystem collection, including namespace and bind-mounted paths.
- Scratch traversal runs as a cooperative background task during interactive collection, so a snapshot carries its measurement time and pending state. Scripted collection waits for a complete scan.
- vsys runs no privileged helper. Drive lifetime writes come from `smartctl -A` reports a privileged timer leaves in the configured directory, one file per `/sys/block` device name with at most one extension, and a file matching no device is ignored.
- Btrfs subvolumes of one filesystem mount separately and each reports the whole device's free space and error counters, so Storage groups them under their device and a mount row carries only what differs between mounts.

## Invariants

1. Invalid `io.stat` counters stay unknown rather than becoming a zero write rate. `src/collect/collector.test.ts` plants an invalid counter; `src/model/writes.test.ts` checks an unreadable counter.
2. Bytes written since boot are reported per slice and per named device. Device totals are read once at the cgroup v2 root, which counts every writer on the machine, including services outside the watched user tree. `src/collect/collector.test.ts` checks the root against the watched tree; `src/model/writes.test.ts` checks the split.
3. Lifetime writes are parsed from NVMe data units and ATA logical blocks, and a drive reporting no counter stays unknown rather than zero. `src/collect/devices.test.ts` checks both units and the missing counter.
4. Every drive keeps a row of its own, so a drive without a readable report is named as the one missing its lifetime writes. `src/model/writes.test.ts` and `src/collect/devices.test.ts` check a report among two drives.
5. A drive's family name is used only where it names no model of its own. `src/collect/devices.test.ts` checks it.
6. Device error deltas use filesystem and device identity, and device mapper aliases resolve to the filesystem counters beneath them. `src/collect/btrfs.test.ts` checks sample and startup baselines and the alias.
7. Mount options retain both the mount and the superblock read-only flags. `src/collect/btrfs.test.ts` checks both.
8. An aborted scrub stays a problem even when it counted no errors, and output that cannot be read cannot report healthy. `src/collect/btrfs.test.ts` checks both conditions.
9. Missing mount information cannot report zero corruption. `src/store/point.test.ts` checks the failure.
10. One scratch traversal counts a hard link once per root and once per session, and an empty scratch setting needs no background work. `src/collect/scratch.test.ts` checks both, and that live reads reuse a single pending scan.
11. Storage leads with the write totals, then filesystems, scrub reports and scratch. `src/ui/storage-screen.test.tsx` checks the order, a read-only mount and the filesystem severity.
12. One filesystem is one heading however its mounts name their device, and a mount's detail does not repeat the device row's error counters. `src/ui/storage-screen.test.tsx` checks interleaved mounts and the detail.
