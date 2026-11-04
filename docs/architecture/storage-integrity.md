# Storage integrity

Read before changing whether a filesystem reads as damaged, checked or healthy, how vsys reads the error counter, the kernel log and the check report, or the scrub reporter, the drive reporter, the report format, their installers or the udisks2 fallback.

## The approach

Judge storage by filesystem through `integrity()` in `src/model/integrity.ts`. Check reports, error counters, kernel logs and remembered finished checks provide independent evidence. Home, Storage and drill-downs consume that one judgment.

The dashboard reads with the user's permissions. Root-side reporters in `scripts/scrub-reporter/` and `scripts/smart-reporter/` leave reports it can read. Their shared text contract belongs here because Bash writers and TypeScript readers must agree.

## Why

A flat error counter proves no new failed read, not healthy data. Only a completed check reads the whole filesystem. Remembered evidence prevents an interrupted check from erasing the last completed result. Keeping privileged readers outside the dashboard preserves its permission boundary.

## Rules

Review holds boundaries without a named check.

- Do read as untroubled only `healthy` and `checking`. A filesystem never checked, whose current report could not be read, or whose counter is unreadable is never `healthy`. `src/model/integrity.test.ts` pins one row per state.
- Do let each source answer alone. Remembered damage and new counter or kernel-log errors still apply when the latest report cannot be read. Its address and block figures stay unknown. `src/collect/btrfs.test.ts` and `src/model/integrity.test.ts` check this priority. With the kernel log only, a logged failure still dates the last new error and names its inode; with neither source, the filesystem was never checked. The Storage row names the source of each time.
- Do cover counter growth by a finished check only where the growth's bound came no later than the check's end and the growth is no larger than the errors it counted. `scrubCoverage()` in `src/collect/btrfs.ts` is the one rule, and later growth stays `new-errors`.
- Do keep the time of the last counter growth in `errorMemoryPath`, outside the process, and treat a counter at zero after a reboot as a new baseline, never a repair.
- Do merge and replace the error memory under one file lock. A competing save reports its refusal and retries on the next sample. `src/collect/errors.test.ts` checks saves that overlap during writing and replacement.
- Do judge a remembered finished check as the live one is judged, through `scrubFoundDamage()`. A remembered check that found damage reads `damaged` whatever the current report says.
- Do hand a replaced collector the same `FinishedScrubMemory` instance ([layers.md](layers.md)), so a scrub that finishes during the handover lands in the one memory. Bind each report's filesystem identity and start time to the file version that supplied its text through `Reader.scrubReport()`. A failed read may retain those fields only for that version. A readable replacement replaces both fields, including missing values. `src/collect/io.test.ts`, `src/collect/collector.test.ts` and `src/collect/btrfs.test.ts` check the handover.
- Do treat an unreadable report with unknown association as possibly belonging to any filesystem. Its filename names a mount, which another filesystem can reuse. Keep report selection in `reportFor()` and health in `integrity()`. Only proof that an unreadable report is older or unrelated lets a readable report determine health. Unknown order and equal start times prove neither. Independent confirmed damage and new errors still stand, while unreadable figures stay unknown. `src/model/integrity.test.ts` and `src/collect/btrfs.test.ts` check this boundary.
- Do search the kernel log through `journalctl --output=json --grep` from the last retained cursor, record a failed search as a source error, and keep the failures earlier searches read. Keep the cursor before an unmatched failure while the boot ID is unreadable, so restored access can recover that failure. Keep the mount mappings from that cursor until it advances. A later mount must not resolve an earlier unmatched failure during replay. `src/collect/kernel-log.test.ts` checks recovery and device reuse.
- Do treat a logged failure as new until a check that started at or after it finishes. `integrity()` in `src/model/integrity.ts` holds this rule; `src/model/integrity.test.ts` checks it.
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

Copy `integrity()` in `src/model/integrity.ts` for one judgment over independent sources. For another root-side reader, copy `scripts/smart-reporter/`: a separate reporter, systemd units and an installer that verifies checksums before writing.

## Revisit when

Btrfs exposes a per-file damage record vsys can read without a scrub, or a source other than a report can prove a filesystem was read end to end. btrfs-progs gives a scrub status with addresses in a machine-readable form, or udisks2 gives the ATA raw counter, so a reporter is no longer the only source.

## Not governed

How the Storage row draws its words: [ui.md](ui.md). The package payload and the warden installer: [warden.md](warden.md).
