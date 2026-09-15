# Storage and devices

Covers: src/collect/btrfs.ts src/collect/devices.ts src/collect/errors.ts src/collect/mounts.ts src/collect/scratch.ts src/collect/scratch-scan.ts src/collect/scratch-worker.ts src/collect/scrub.ts src/model/integrity.ts src/model/writes.ts src/ui/integrity.ts src/ui/storage-screen.tsx

Storage collection reads filesystem state, device counters, drive reports and scratch sizes. A counter the kernel or a drive did not report stays unknown rather than becoming a zero.

## Boundaries

- The mount parser owns mount roots and path escaping for both cgroup and filesystem collection, including namespace and bind-mounted paths.
- Scratch traversal runs on a thread of its own, started at the first scan and kept for the life of the collector. `ScratchCollector` in `src/collect/scratch.ts` owns that thread and publishes only complete readings, so a snapshot carries its measurement time and pending state. Scripted collection waits for a complete scan.
- The traversal reads each directory in one listing and takes each entry's status synchronously. It runs where blocking delays no sample, and the asynchronous form it replaced spent more processor time for the same readings.
- `scratchDutyPercent` is the share of one processor core a background traversal may hold. The traversal works for a slice, then rests until that slice is no more than its share of the two. A caller that waits for the reading gets the whole thread, because a script has no screen to protect. The reason the bound is a duty cycle rather than a stored index is [D004](../decisions/D004-scratch-scan-duty.md).
- A lower share lowers the processor time a traversal sustains and raises the total it spends, because the same reading is spread over more slices and each rest costs a wake-up. A reader setting the share to save total processor time gets the opposite. `bun run bench:scratch` reports both figures for one tree.
- A traversal is eligible to run again `scratchRefreshMs` after the last one finished, measured on the monotonic clock. Measured from the attempt instead, a traversal longer than the interval is eligible again the instant it ends and never pauses.
- Replacing the settings or closing the collector ends the scan thread, so a traversal stops where it stands. A reading that arrives for a scan the collector has given up on names that scan and is discarded rather than published under the settings that replaced it.
- vsys runs no privileged helper. Drive lifetime writes come from `smartctl -A` reports a privileged timer leaves in the configured directory, one file per `/sys/block` device name with at most one extension, and a file matching no device is ignored.
- Btrfs subvolumes of one filesystem mount separately and each reports the whole device's free space and error counters, so Storage groups them under their device and a mount row carries only what differs between mounts.
- The filesystem, not the mount and not the device, is the unit of integrity. `volumesByDevice` in `src/model/integrity.ts` forms that group, and the cause ladder, the Storage line and the drill-down all read the one `integrity()` reading per group.
- The error counter counts reads that failed their checksum, not damaged files. It cannot move while nothing reads the damage, so a flat counter is never on its own a statement that the filesystem is sound. Only a completed check is.
- The time of a filesystem's last counter growth is kept in `errorMemoryPath`, outside the history window and outside the process. A growth time a write never landed lives only in this process, so the filesystem reads as unknown until one does. A counter reading zero after a reboot is a new baseline, never a repair. A write folds in the file as it stands, so two vsys processes watching one host keep the later growth time rather than the one that renamed last.
- A check that corrected every error it found left no damage behind. Corrected errors still raise a report card; they are not a damaged filesystem.

## The check report format

A privileged timer runs the check and writes one report per filesystem into `scrubDir`. vsys reads that file and runs nothing privileged of its own, so the file is a contract between the two. The helper on the owner's host is shipped by their dotfiles, not by vsys.

- `UUID:` names the filesystem. It is the directory name under `btrfsRoot`, and it is how a report is matched to the filesystem it speaks for. A report whose UUID matches nothing is listed as a report and speaks for no filesystem.
- Only a finished check has a result: a running or half-written report names no damaged file and carries no block count, so nothing offers a delete command under a check that has not said what it found, and the words say the check has not finished rather than that its report counted nothing.
- A delete command is offered only on live data. On a pinned sample the paths were checked when that sample was taken, so the copy key says so instead.
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
10. One scratch traversal counts a hard link once per root and once per session, and a root it could not read reports no size rather than a zero beside the roots it read. `src/collect/scratch-scan.test.ts` checks both.
11. A traversal rests after every spent slice, for the time that slice earned at its duty, so it holds no more than its share of a thread. `src/collect/scratch-scan.test.ts` stages the clock and the wait and pins the rest asked for at each duty, including the zero a duty of 100 earns.
12. A traversal is eligible again only once the rescan interval has passed since the last one finished, an empty scratch setting needs no background work, and live reads reuse a single pending scan. `src/collect/scratch.test.ts` checks all three.
13. A failed traversal keeps the last complete reading and its measurement time and names what failed beside them, so no partial total is published as a complete one. `src/collect/scratch.test.ts` checks the reading and the error.
14. One scan thread serves every scan until it fails, a thread that fails is replaced rather than reused, a late event from a replaced thread reaches neither the thread now running nor the scan on it, and a closed host takes no further work. `src/collect/scratch-worker.test.ts` counts the threads started and checks the rest, including a reply for a scan the host gave up on.
15. Storage leads with the write totals, then filesystems, scrub reports and scratch. `src/ui/storage-screen.test.tsx` checks the order, a read-only mount and the filesystem severity.
16. One filesystem is one heading however its mounts name their device, and the lifetime counters sit under the filesystem's integrity row rather than on its mounts. `src/ui/storage-screen.test.tsx` checks interleaved mounts and both levels of the detail.
17. A report is matched to its filesystem by the UUID it carries, and its damaged-file list holds only paths still on disk, so a deleted file leaves the list. `src/collect/btrfs.test.ts` deletes one of an address's two names and reads the list back.
18. A report with no damaged-file section lists no files rather than none, and a field it omits stays unread. `src/collect/scrub.test.ts` checks both formats and a reworded header.
19. The first reading of a counter above zero establishes a baseline and claims no error time; later growth records its time and size, and a counter reset moves the baseline without erasing them. `src/collect/errors.test.ts` checks all three, and `src/collect/btrfs.test.ts` reads the time back from a second collector.
20. No integrity state but `healthy` and `checking` reads as untroubled, and a filesystem that was never checked, whose check stopped early, whose output could not be read, or whose counter is unreadable is never `healthy`. `src/model/integrity.test.ts` pins one row per state.
21. A damaged address counts as build output only when every path under it does, and only such an address is offered as a delete, in one line holding every path it carries. An address holding anything else is restored from a backup and gets no command at all. `src/model/integrity.test.ts` checks the classification; `src/ui/integrity.test.ts` checks both commands and the refusal.
22. A report that cannot be read stays a report: the row and its problem card remain rather than the file reading as absent. `src/collect/btrfs.test.ts` makes one unreadable and reads the row back.
23. A reading vsys could not take never becomes a reading of none: output that could not be read names no damaged file, and a record of past growth that failed to load leaves the state unknown rather than healthy, and is never overwritten by this process's own baselines. `src/model/integrity.test.ts` checks both states; `src/collect/errors.test.ts` checks the refusal to overwrite.
