# Storage integrity

Covers: src/collect/errors.ts src/collect/kernel-log.ts src/collect/scrub.ts src/model/integrity.ts src/ui/integrity.ts scripts/scrub-reporter/ scripts/scrub_reporter_test.py

Storage answers two questions per filesystem: is its data damaged, and when was it last read end to end. Three sources answer them. A check report says what a completed scrub found. The error counter and the kernel log each record a failed read when one happens. Filesystem, device and mount collection are in [storage](storage.md).

## Boundaries

- The filesystem, not the mount and not the device, is the unit of integrity. `volumesByDevice` in `src/model/integrity.ts` forms that group, and the cause ladder, the Storage line and the drill-down all read the one `integrity()` reading per group.
- The error counter counts reads that failed their checksum, not damaged files. It cannot move while nothing reads the damage, so a flat counter is never on its own a statement that the filesystem is sound. Only a completed check is.
- The time of a filesystem's last counter growth is kept in `errorMemoryPath`, outside the history window and outside the process. A growth time a write never landed lives only in this process, so the filesystem reads as unknown until one does. A counter reading zero after a reboot is a new baseline, never a repair. A write folds in the file as it stands, so two vsys processes watching one host keep the later growth time rather than the one that renamed last.
- A check that corrected every error it found left no damage behind. Corrected errors still raise a report card; they are not a damaged filesystem.
- The last check comes only from a report. The last new error is the newer of the counter's last growth and the kernel log's last failed read, and the Storage line names the source of each time. A report read the whole filesystem. The counter and the log saw only the reads that happened, and the counter only while a vsys process watched it.

## The kernel log

- Btrfs logs every data read that fails its checksum as `csum failed root R ino I`. `KernelLog` in `src/collect/kernel-log.ts` reads those lines from `journalctl --output=json`, searched with `--grep`, so no helper is needed.
- The `kernel-log` capability searches for one kernel message from this boot, once at start. An answer with none means this user cannot read the system journal. A collector whose probe failed never searches.
- The first search reads every boot the journal holds. On the author's workstation, with 12 boots retained, it took 0.415 s. Each later search starts after the cursor the last one ended on, and took 0.007 s there.
- A device name holds for one boot. A failure is matched to its filesystem through the `first mount of filesystem` line its own boot logged for that device. A failure from this boot with no such line is matched through this boot's sysfs. A failure from an earlier boot with no such line is left out.
- Resolving an inode to a path needs root. A failure the kernel logged after the last finished check shows as an inode in a subvolume. A check that finished later read the filesystem end to end, and its report names what is still damaged.
- `csumFailures` holds the newest 64 inodes per filesystem. Null means the log was not read, which is never a log of none.

## The scrub reporter

vsys runs no privileged code. `scripts/scrub-reporter/` holds the root side for a reader to install: `btrfs-scrub-report`, the `btrfs-scrub@.service` drop-in that runs it after every scrub, and the tmpfiles line that creates `/run/btrfs-scrub` at boot. `install` puts the three in place and schedules no scrub.

- The report directory tells an installed reporter that has not run yet from no reporter at all. The first reads "Never checked". The second names the missing source.
- The reporter resolves damaged addresses from the kernel log of the scrub's run. A kernel log it cannot read leaves the report with no `Damaged files:` section, because a section listing no address would read as a check that found no damaged file.
- Where the report directory does not exist and `scrubDir` is the shipped default, Settings and Storage offer the install as a line the copy key copies. A reader who set `scrubDir` elsewhere runs a reporter of their own and is offered none.

## The check report format

The reporter writes one report per filesystem into `scrubDir`, and vsys reads it, so the file is a contract between the two.

- `UUID:` names the filesystem. It is the directory name under `btrfsRoot`, and it is how a report is matched to the filesystem it speaks for. A report whose UUID matches nothing is listed as a report and speaks for no filesystem.
- Only a finished check has a result: a running or half-written report names no damaged file and carries no block count, so nothing offers a delete command under a check that has not said what it found, and the words say the check has not finished rather than that its report counted nothing.
- A delete command is offered only on live data. On a pinned sample the paths were checked when that sample was taken, so the copy key says so instead.
- `Scrub started:`, `Status:`, `Corrected:` and `Uncorrectable:` carry the times and the counts. A field the report omits stays unread rather than becoming a zero, and so does one it states twice: a per-device listing holds no single reading for the filesystem. `Status: finished` is the only word that says the filesystem was read end to end; every other word leaves the state unknown.
- A `Damaged files:` section, when present, is followed by a `logical <address>:` heading per damaged block address and its resolved paths, each indented two spaces. An address with no path carries one parenthesised line saying so.
- The address, not the file, is the unit: one extent can be reachable under several names, and removing the first leaves the damage on disk for the next check to report again. Every path of an address is listed under it, and the copy command removes all of them together.
- Every other line is prose the reporter may reword. The parser anchors on the labelled fields and on the address heading alone.
- A report with no `Damaged files:` section names no files. That is not a claim that there are none, and it never becomes an empty list.
- Paths are resolved as the check ends. A block freed and reused afterwards resolves to an unrelated file, which is why vsys names files and never deletes one. A path written since the check began is still listed, because dropping it would hide damage, but nothing offers to remove it: that name no longer proves what the check read.

## Invariants

1. A report is matched to its filesystem by the UUID it carries, and its damaged-file list holds only paths still on disk, so a deleted file leaves the list. `src/collect/btrfs.test.ts` deletes one of an address's two names and reads the list back.
2. A report with no damaged-file section lists no files rather than none, and a field it omits stays unread. `src/collect/scrub.test.ts` checks both formats and a reworded header.
3. The first reading of a counter above zero establishes a baseline and claims no error time; later growth records its time and size, and a counter reset moves the baseline without erasing them. `src/collect/errors.test.ts` checks all three, and `src/collect/btrfs.test.ts` reads the time back from a second collector.
4. No integrity state but `healthy` and `checking` reads as untroubled, and a filesystem that was never checked, whose check stopped early, whose output could not be read, or whose counter is unreadable is never `healthy`. `src/model/integrity.test.ts` pins one row per state.
5. A damaged address counts as build output only when every path under it does, and only such an address is offered as a delete, in one line holding every path it carries. An address holding anything else is restored from a backup and gets no command at all. `src/model/integrity.test.ts` checks the classification; `src/ui/integrity.test.ts` checks both commands and the refusal.
6. A report that cannot be read stays a report: the row and its problem card remain rather than the file reading as absent. `src/collect/btrfs.test.ts` makes one unreadable and reads the row back.
7. A reading vsys could not take never becomes a reading of none: output that could not be read names no damaged file, and a record of past growth that failed to load leaves the state unknown rather than healthy, and is never overwritten by this process's own baselines. `src/model/integrity.test.ts` checks both states; `src/collect/errors.test.ts` checks the refusal to overwrite.
8. Each source answers on its own, and no source alone makes a filesystem healthy. With both, the newer error speaks, and a check that finished after a logged failure covers it. With reports only, the log reads as unread. With the kernel log only, a logged failure still dates the last new error and names its inode. With neither, the filesystem was never checked. `src/model/integrity.test.ts` holds one row per combination; `src/ui/integrity.test.ts` reads the source each line names.
9. A logged failure belongs to the filesystem its own boot mounted on that device, an earlier boot's failure with no mount line is left out, and a search that failed to parse is asked again from the same cursor. `src/collect/kernel-log.test.ts` renames a device across two boots and checks each.
10. A kernel log the probe could not search is never searched, and a search that fails names `journalctl` and leaves the reading unread. `src/collect/collector.test.ts` counts the searches; `src/collect/kernel-log.test.ts` checks the failure.
11. The reporter writes the fields the parser reads and every name under each address, a kernel log it cannot read leaves no damaged-file section, and the installer installs nothing when the scrub unit is missing or a download fails. `scripts/scrub_reporter_test.py` runs both against stub system commands, and checks that the drop-in, the tmpfiles line and the default `scrubDir` name one directory.
