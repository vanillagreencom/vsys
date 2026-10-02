# Scrub reporter and check reports

Covers: src/collect/scrub.ts src/collect/scrub.test.ts src/ui/integrity.ts scripts/scrub-reporter/ scripts/scrub_reporter_test.py

A check report is the only source of the last check in [storage integrity](storage-integrity.md). The scrub reporter writes it as root, and vsys parses it. The invariants that hold both, and the tests that enforce them, are in [storage integrity § Invariants](storage-integrity.md#invariants).

## The scrub reporter

vsys runs no privileged code. `scripts/scrub-reporter/` holds the root side for a reader to install: `vsys-scrub-report`, the `btrfs-scrub@.service` drop-in that runs it after every scrub, and the tmpfiles line that creates `/var/lib/btrfs-scrub`. `install` puts the three in place under names of vsys's own, so a reporter already set up under another name keeps running beside it. It schedules no scrub.

- The report directory tells an installed reporter that has not run yet from no reporter at all. The first reads "Never checked". The second names the missing source.
- The reporter takes damaged addresses from the kernel log of the scrub's run, and only from lines whose device `btrfs device stats` lists for this filesystem. A logical address means something on one filesystem only, and every Btrfs filesystem writes to the one kernel log. It reads the line with and without the `scrub: ` prefix kernels since the scrub rewrite write.
- A kernel log or a device list it cannot read leaves the report with no `Damaged files:` section, because a section listing no address would read as a check that found no damaged file.
- The raw report can show a proved name beside a `(not resolved: ...)` line for the same address in a mixed block; what Storage shows after `parseScrub` is strictly all of an address's names or none, and each name reaches the screen byte for byte. Every name is a name of an inode `logical-resolve -P` holds for that address, checked by inode number and by the subvolume of its containing directory, which `rootid` opens read-only where a snapshot would refuse the file. Every inode the address belongs to has a name. No name has whitespace at an end or a control character. btrfs prints a name with a newline as two lines, and an unchecked line could name a healthy file. An address failing any of these, or one btrfs could not resolve or warned on stderr, lists no name and a `(not resolved: ...)` line instead; the mark can still sit beside a proved name. A no-extent answer is never free space, because a block start can sit in a gap, as below; vsys still reads an older report's `(no file:` line as free space.
- The kernel rate-limits the line that names an address, and the reporter resolves at most `BTRFS_SCRUB_MAX_ADDRESSES`, so a report can list fewer addresses than the blocks it counted.
- Where the report directory does not exist and `scrubDir` is the shipped default, Settings and Storage offer the install as a line the copy key copies. A reader who set `scrubDir` elsewhere runs a reporter of their own and is offered none, and so is a directory that exists and cannot be read.
- Each sample takes the scrub capability from the asynchronous listing the reports come from: the two never disagree, no synchronous read of the directory runs on the sample path, and the offer leaves once the install creates the directory.

## The check report format

The reporter writes one report per filesystem into `scrubDir`, and vsys reads it, so the file is a contract between the two.

- `UUID:` names the filesystem. It is the directory name under `btrfsRoot`, and it is how a report is matched to the filesystem it speaks for. A report whose UUID matches nothing is listed as a report and speaks for no filesystem.
- Only a finished check has a result: a running or half-written report names no damaged file and carries no block count, so no file is listed under a check that has not said what it found, and the words say the check has not finished rather than that its report counted nothing.
- `Scrub started:`, `Status:`, `Corrected:` and `Uncorrectable:` carry the times and the counts. A field the report omits stays unread rather than becoming a zero, and so does one it states twice: a per-device listing holds no single reading for the filesystem. `Status: finished` is the only word that says the filesystem was read end to end; every other word leaves the state unknown.
- A file whose name starts with a dot is not a report. The reporter writes under such a name and renames the report whole, so vsys never reads one half written.
- A `Damaged files:` section, when present, is followed by a `logical <address>:` heading per damaged block address and its resolved paths, each indented two spaces. An address with no path carries one parenthesised line saying so. A line starting `(not resolved` marks damage whose files are not named: no file under it is listed, and it is never free space.
- The address, not the file, is the unit: one extent can be reachable under several names, and every path of an address is listed under it.
- Every other line is prose the reporter may reword. The parser anchors on the labelled fields, the address heading and the `(not resolved` mark alone.
- vsys reads a report as written, untrimmed, and takes each name byte for byte. A name with whitespace at an end, a control character, a line-separator code point (U+2028, U+2029), or a byte that was not UTF-8 marks its address not resolved, because once read it can be another file's name. Marking an address not resolved drops every name already read for it, so the set a reader sees for that address is always all of its names or none.
- `Uncorrectable:` counts blocks. Where it is larger than the number of listed addresses, the difference is damage no file is named for, which [invariant 13](storage-integrity.md#invariants) holds.
- A report with no `Damaged files:` section names no files. That is not a claim that there are none, and it never becomes an empty list.
- Paths are resolved as the check ends. A block freed and reused afterwards resolves to an unrelated file.
- Every listed file is possibly damaged. On stable 7.2 before 7.2.7 and on mainline before 7.3-rc2, the `unable to fixup` line gives the start of the 64 KiB block the check could not repair, not the damaged sector; 33ce0aa4c576 (v7.3-rc2, backported to 7.2.7) logs the sector itself. A block start can sit in a gap, so a sector with no extent is never free space. The reporter resolves each of the block's 16 sectors; an older copy may resolve only the start, vsys cannot tell which wrote a report, and more than one file can share a block, so this never says which failed. `possibleSentence` in `src/ui/integrity.ts` says so, and neither it nor the damage card offers a command that removes a file.
