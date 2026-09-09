# Storage and devices

Covers: src/collect/btrfs.ts src/collect/devices.ts src/collect/mounts.ts src/collect/scratch.ts src/model/writes.ts src/ui/storage.ts

Storage collection reads filesystem state, device counters, drive reports and scratch sizes. A counter the kernel or a drive did not report stays unknown rather than becoming a zero.

## Boundaries

- Scratch traversal runs as a cooperative background task during interactive collection. Snapshots carry its measurement time and pending state. Scripted collection waits for a complete scan.
- The mount parser owns mount roots and path escaping for cgroup and filesystem collection.

## Invariants

- Invalid io.stat counters stay unknown rather than becoming a zero write rate. `src/collect/collector.test.ts` plants an invalid counter.
- Bytes written since boot per slice come from the io.stat read Home already uses. Device totals are read once at the cgroup v2 root, which counts every writer on the machine, including services outside the watched user tree. `src/collect/collector.test.ts` checks the root against the watched tree and an unreadable root counter.
- Drive lifetime writes are parsed from `smartctl -A` reports written by a privileged timer, one file per `/sys/block` device name with a single optional extension. Every drive keeps a row, so a drive without a readable report is named as the one missing its lifetime writes. `src/collect/devices.test.ts` checks NVMe data units, ATA logical blocks, the drive model against its family name, and one report among two drives.
- Device error deltas use filesystem and device identity. `src/collect/btrfs.test.ts` checks sample and startup baselines.
- Missing mount information or device counters remain unknown in history. `src/store/point.test.ts` and `src/collect/btrfs.test.ts` check those failures.
- Aborted scrubs remain problems even when they counted no errors. `src/collect/btrfs.test.ts` checks that condition.
