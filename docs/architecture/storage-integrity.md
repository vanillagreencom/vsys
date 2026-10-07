# A filesystem is healthy only when a finished check says so

Read before changing whether a filesystem reads as damaged, checked or healthy, how vsys reads the error counter, the kernel log and the check report, or the scrub reporter, the drive reporter, the report format, their installers or the udisks2 fallback.

## The approach

Storage answers two questions per filesystem: is its data damaged, and when was it last read end to end. Three sources answer. A check report says what a completed Btrfs scrub found. The error counter and the kernel log each record a failed checksum read when one happens. `integrity()` in `src/model/integrity.ts` is the one reading; the filesystem, not the mount and not the device, is its unit through `volumesByDevice`; and the cause ladder, the Storage row and the drill-down all read it. The collector remembers the last finished check in `FinishedScrubMemory` in `src/collect/btrfs.ts` across a later report that did not finish.

vsys runs no privileged code. Two reporters run as root from systemd and leave files vsys reads with the user's permissions. `scripts/scrub-reporter/vsys-scrub-report` runs after each Btrfs scrub, from a `btrfs-scrub@.service` drop-in, and writes one check report per mount into `scrubDir`. `scripts/smart-reporter/vsys-smart-report` runs from a timer and writes one `smartctl` report per drive into `smartDir`. The vsys and vsys-git packages install the reporter files listed in `packaging/vsys-runtime-files.txt`; a one-command installer per reporter fetches them from a tagged release instead. Where no drive report exists, vsys asks udisks2 over the system bus through `busctl`.

## Why

The error counter counts reads that failed. It stays still while nothing reads the damaged part, so a flat counter is not a sound filesystem; only a finished check read the whole filesystem. A scrub that stops early overwrites its mount's report that proved the filesystem sound, and without the memory that filesystem would fall back to unknown.

Resolving a damaged block to a file and reading SMART attributes need root, and vsys reads the machine with the user's permissions. The dashboard reads what a privileged reporter wrote and is never privileged itself. A report file is a contract shared by two programs in two languages, so its rules live here rather than in either one.

## Rules

- Do read as untroubled only `healthy` and `checking`. A filesystem never checked, whose report could not be read, or whose counter is unreadable is never `healthy`. `src/model/integrity.test.ts` pins one row per state.
- Do let each source answer alone. Remembered damage and new counter or kernel-log errors still apply when the latest report cannot be read. Its address and block figures stay unknown. `src/collect/btrfs.test.ts` and `src/model/integrity.test.ts` check this priority. With the kernel log only, a logged failure still dates the last new error and names its inode; with neither source, the filesystem was never checked. The Storage row names the source of each time.
- Do cover counter growth by a finished check only where the growth's bound came no later than the check's end and the growth is no larger than the errors it counted. `scrubCoverage()` in `src/collect/btrfs.ts` is the one rule, and later growth stays `new-errors`.
- Do keep the time of the last counter growth in `errorMemoryPath`, outside the process, and treat a counter at zero after a reboot as a new baseline, never a repair.
- Do merge and replace the error memory under one file lock. A competing save reports its refusal and retries on the next sample. `src/collect/errors.test.ts` checks saves that overlap during writing and replacement.
- Do judge a remembered finished check as the live one is judged, through `scrubFoundDamage()`. A remembered check that found damage reads `damaged` whatever the current report says.
- Do hand a replaced collector the same `FinishedScrubMemory` instance ([layers.md](layers.md)), so a scrub that finishes during the handover lands in the one memory. Keep each report's filesystem identity and start time together in that memory. A failed read must preserve report order across mounts and collector replacement. A readable replacement report replaces both fields, including missing values. `src/collect/collector.test.ts` and `src/collect/btrfs.test.ts` check it.
- Do search the kernel log through `journalctl --output=json --grep` from the last retained cursor, record a failed search as a source error, and keep the failures earlier searches read. Keep the cursor before an unmatched failure while the boot ID is unreadable, so restored access can recover that failure. Keep the mount mappings from that cursor until it advances. A later mount must not resolve an earlier unmatched failure during replay. `src/collect/kernel-log.test.ts` checks recovery and device reuse.
- Do list every file a report names as possibly damaged, with every name its address carries, and count blocks the check counted beyond the listed addresses as unnamed damage.
- Do write a report under a dot-prefixed name and rename it whole. vsys reads no hidden file, so it never reads a half-written report. `src/collect/btrfs.test.ts` places a half-written report beside a complete one.
- Do keep `Damaged files:` as the fixed label that opens the damaged-address section. The reporter may reword the text after that label. The parser ignores address-shaped prose outside that section, as `src/collect/scrub.test.ts` checks. Keep the other labelled fields, the `logical <address>:` heading and the `(not resolved` mark unchanged.
- Do list under an address all of its names or none. A name with whitespace at an end, a control character, a line-separator code point or a byte that was not UTF-8 marks the address not resolved, because once read it can be another file's name. `src/collect/scrub.test.ts` checks each name the text cannot carry.
- Do leave out the `Damaged files:` section when the kernel log or the device list could not be read. A section listing no address would read as a check that found no damaged file. `scripts/scrub_reporter_test.py` runs the reporter against stub commands and parses its output with vsys's own parser.
- Do keep `Status: finished` the only word that says the filesystem was read end to end, and leave a field the report omits or states twice unread.
- Do offer the install line, through `reporterOffer()` in `src/ui/settings.ts`, only where the report directory does not exist and the directory setting is the shipped default. A reader who set `scrubDir` or `smartDir` elsewhere runs a reporter of their own and is offered none. Where the package installed the reporter, offer `systemctl enable --now` for the timers systemd calls `disabled` and never the `curl` line. `src/collect/scrub-timers.test.ts` and `src/ui/settings.test.ts` check both.
- Do bound each drive's `smartctl` query with `timeout`, so a wedged drive costs only its own report, and keep a report smartctl exited nonzero on, because it sets status bits for a failing drive.
- Do accept a drive report only when its serial number matches the current drive's serial number in sysfs. Read NVMe's text serial and SATA or SCSI's binary unit-serial page through `Reader`. A missing or unreadable identity leaves the saved model and total unknown. A device name alone can refer to a replacement drive. `src/collect/devices.test.ts` checks both identity interfaces and the match. Prefer an accepted report over udisks2 for the same drive, mark every total with its source, and take udisks2's ATA attribute 241 only where its unit is sectors. `src/collect/udisks.test.ts` checks the units against `src/test/udisks.ts`, a stand-in for busctl.
- Never offer a command that removes a listed file. `src/ui/storage-screen.test.tsx` copies nothing from a damaged filesystem, and `src/ui/attention.test.ts` checks the damage card.
- Never read a report that cannot be read as an absent report, and never read a hidden file in the report directory as a report. `src/collect/btrfs.test.ts` checks both.
- Never read an unread report or counter as healthy. The `scrub` and `integrity-unknown` causes raise on them.
- Never let vsys run an installer or a reporter, or gain a privilege to read what a reporter writes. Storage and Settings offer the line to copy.
- Never install from a release whose `SHA256SUMS` is missing or does not match. `scripts/scrub_reporter_test.py` and `scripts/smart_reporter_test.py` run both installers against each failure.
- Never let a package enable a timer or install a user unit. `scripts/package_file_list_check.py` refuses it, and holds the drop-in and the service to running the packaged reporter.

## The canonical example

`integrity()` in `src/model/integrity.ts`: one function taking the report, the counter memory, the logged failures and the remembered check, and returning the state with its two dated times and their sources. Copy it: every reader calls it rather than judging a source itself. For another root-side reader, copy the layout of `scripts/smart-reporter/`: the reporter, its service and timer, the tmpfiles line that creates the report directory, and an installer that verifies checksums before writing anything.

## Revisit when

Btrfs exposes a per-file damage record vsys can read without a scrub, or a source other than a report can prove a filesystem was read end to end. btrfs-progs gives a scrub status with addresses in a machine-readable form, or udisks2 gives the ATA raw counter, so a reporter is no longer the only source.

## Not governed

How the Storage row draws its words: [ui.md](ui.md). The package payload and the warden installer: [warden.md](warden.md).
