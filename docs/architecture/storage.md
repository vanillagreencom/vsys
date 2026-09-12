# Storage and devices

Covers: src/collect/btrfs.ts src/collect/devices.ts src/collect/errors.ts src/collect/mounts.ts src/collect/scratch.ts src/collect/scrub.ts src/model/integrity.ts src/model/writes.ts src/ui/integrity.ts src/ui/storage-screen.tsx

Storage collection reads filesystem state, device counters, drive reports and scratch sizes. A counter the kernel or a drive did not report stays unknown rather than becoming a zero.

## Boundaries

- The mount parser owns mount roots and path escaping for both cgroup and filesystem collection, including namespace and bind-mounted paths.
- Scratch traversal runs as a cooperative background task during interactive collection, so a snapshot carries its measurement time and pending state. Scripted collection waits for a complete scan.
- vsys runs no privileged helper. Drive lifetime writes come from `smartctl -A` reports a privileged timer leaves in the configured directory, one file per `/sys/block` device name with at most one extension, and a file matching no device is ignored.
- Btrfs subvolumes of one filesystem mount separately and each reports the whole device's free space and error counters, so Storage groups them under their device and a mount row carries only what differs between mounts.
- The filesystem, not the mount and not the device, is the unit of integrity. `volumesByDevice` in `src/model/integrity.ts` forms that group, and the cause ladder, the Storage line and the drill-down all read the one `integrity()` reading per group.
- The error counter counts reads that failed their checksum, not damaged files. It cannot move while nothing reads the damage, so a flat counter is never on its own a statement that the filesystem is sound. Only a completed check is.
- The time of a filesystem's last counter growth is kept in `errorMemoryPath`, outside the history window and outside the process. A growth time a write never landed lives only in this process, so the filesystem reads as unknown until one does. A counter reading zero after a reboot is a new baseline, never a repair. A write folds in the file as it stands, so two vsys processes watching one host keep the later growth time rather than the one that renamed last.
- A check that corrected every error it found left no damage behind. Corrected errors still raise a report card; they are not a damaged filesystem.

## The check report format

A privileged timer runs the check and writes one report per filesystem into `scrubDir`. vsys reads that file and runs nothing privileged of its own, so the file is a contract between the two. The helper on the owner's host is shipped by their dotfiles, not by vsys.

- `UUID:` names the filesystem. It is the directory name under `btrfsRoot`, and it is how a report is matched to the filesystem it speaks for. A report whose UUID matches nothing is listed as a report and speaks for no filesystem.
- Only a finished check has a result: a running or half-written report names no damaged file and carries no block count, so nothing offers a delete command under a check that has not said what it found.
- `Scrub started:`, `Status:`, `Corrected:` and `Uncorrectable:` carry the times and the counts. A field the report omits stays unread rather than becoming a zero, and so does one it states twice: a per-device listing holds no single reading for the filesystem. `Status: finished` is the only word that says the filesystem was read end to end; every other word leaves the state unknown.
- A `Damaged files:` section, when present, is followed by a `logical <address>:` heading per damaged block address and its resolved paths, each indented two spaces. An address with no path carries one parenthesised line saying so.
- The address, not the file, is the unit: one extent can be reachable under several names, and removing the first leaves the damage on disk for the next check to report again. Every path of an address is listed under it, and the copy command removes all of them together.
- Every other line is prose the helper may reword. The parser anchors on the labelled fields and on the address heading alone.
- A report with no `Damaged files:` section names no files. That is not a claim that there are none, and it never becomes an empty list.
- Paths are resolved as the check ends. A block freed and reused afterwards resolves to an unrelated file, which is why vsys names files and never deletes one. A path written since the check began is still listed, because dropping it would hide damage, but nothing offers to remove it: that name no longer proves what the check read.

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
12. One filesystem is one heading however its mounts name their device, and the lifetime counters sit under the filesystem's integrity row rather than on its mounts. `src/ui/storage-screen.test.tsx` checks interleaved mounts and both levels of the detail.
13. A report is matched to its filesystem by the UUID it carries, and its damaged-file list holds only paths still on disk, so a deleted file leaves the list. `src/collect/btrfs.test.ts` deletes one of an address's two names and reads the list back.
14. A report with no damaged-file section lists no files rather than none, and a field it omits stays unread. `src/collect/scrub.test.ts` checks both formats and a reworded header.
15. The first reading of a counter above zero establishes a baseline and claims no error time; later growth records its time and size, and a counter reset moves the baseline without erasing them. `src/collect/errors.test.ts` checks all three, and `src/collect/btrfs.test.ts` reads the time back from a second collector.
16. No integrity state but `healthy` and `checking` reads as untroubled, and a filesystem that was never checked, whose check stopped early, whose output could not be read, or whose counter is unreadable is never `healthy`. `src/model/integrity.test.ts` pins one row per state.
17. A damaged address counts as build output only when every path under it does, and only such an address is offered as a delete, in one line holding every path it carries. An address holding anything else is restored from a backup and gets no command at all. `src/model/integrity.test.ts` checks the classification; `src/ui/integrity.test.ts` checks both commands and the refusal.
18. A report that cannot be read stays a report: the row and its problem card remain rather than the file reading as absent. `src/collect/btrfs.test.ts` makes one unreadable and reads the row back.
19. A reading vsys could not take never becomes a reading of none: output that could not be read names no damaged file, and a record of past growth that failed to load leaves the state unknown rather than healthy, and is never overwritten by this process's own baselines. `src/model/integrity.test.ts` checks both states; `src/collect/errors.test.ts` checks the refusal to overwrite.
