# vsys runs no privileged code; root-side reporters write files it reads

Read before changing the scrub reporter, the drive reporter, the check report format, their installers, or the udisks2 fallback.

## The approach

Two reporters run as root from systemd and leave files vsys reads with the user's permissions. `scripts/scrub-reporter/vsys-scrub-report` runs after each Btrfs scrub, from a `btrfs-scrub@.service` drop-in, and writes one check report per filesystem into `scrubDir`. `scripts/smart-reporter/vsys-smart-report` runs from a timer and writes one `smartctl` report per drive into `smartDir`. Each ships two ways. The vsys and vsys-git packages install the files listed in `packaging/vsys-runtime-files.txt` and enable no timer. A one-command installer fetches the files from a tagged release, checks each against that release's `SHA256SUMS`, and installs them under names of vsys's own. Where no drive report exists, vsys asks udisks2 over the system bus through `busctl --system --json=short`.

## Why

Resolving a damaged block to a file and reading SMART attributes need root, and vsys keeps its promise to read the machine with the user's permissions. A report file is a contract shared by two programs in two languages, so its rules live here rather than in either one.

## Rules

- Do write a report under a dot-prefixed name and rename it whole. vsys reads no hidden file, so it never reads a half-written report. `src/collect/btrfs.test.ts` places a half-written report beside a complete one.
- Do anchor the parser on the labelled fields (`UUID:`, `Scrub started:`, `Duration:`, `Status:`, `Corrected:`, `Uncorrectable:`, `Error summary:`), the `logical <address>:` heading and the `(not resolved` mark alone. Every other line is prose the reporter may reword.
- Do list under an address all of its names or none. A name with whitespace at an end, a control character, a line-separator code point or a byte that was not UTF-8 marks the address not resolved, because once read it can be another file's name. `src/collect/scrub.test.ts` checks each name the text cannot carry.
- Do leave out the `Damaged files:` section when the kernel log or the device list could not be read. A section listing no address would read as a check that found no damaged file. `scripts/scrub_reporter_test.py` runs the reporter against stub commands and parses its output with vsys's own parser.
- Do keep `Status: finished` the only word that says the filesystem was read end to end, and leave a field the report omits or states twice unread.
- Do offer the install line only where the report directory does not exist and the directory setting is the shipped default. A reader who set `scrubDir` or `smartDir` elsewhere runs a reporter of their own and is offered none. Where the package installed the reporter, offer `systemctl enable --now` for the timers systemd calls `disabled` and never the `curl` line. `src/collect/scrub-timers.test.ts` and `src/ui/settings.test.ts` check both.
- Do bound each drive's `smartctl` query with `timeout`, so a wedged drive costs only its own report, and keep a report smartctl exited nonzero on, because it sets status bits for a failing drive.
- Do prefer a report over udisks2 for the same drive, mark every total with its source, and take udisks2's ATA attribute 241 only where its unit is sectors. `src/collect/devices.test.ts` checks the precedence, and `src/collect/udisks.test.ts` checks the units against `src/test/udisks.ts`, a stand-in for busctl.
- Never let vsys run an installer or a reporter. Storage and Settings offer the line to copy.
- Never install from a release whose `SHA256SUMS` is missing or does not match. `scripts/scrub_reporter_test.py` and `scripts/smart_reporter_test.py` run both installers against each failure.
- Never let a package enable a timer or install a user unit. `scripts/package_file_list_check.py` refuses it, and holds the drop-in and the service to running the packaged reporter.

## The canonical example

`scripts/smart-reporter/`: the reporter, its service and timer, the tmpfiles line that creates the report directory, and an installer that verifies checksums before writing anything. Copy its layout for another root-side reader.

## Revisit when

btrfs-progs gives a scrub status with addresses in a machine-readable form, or udisks2 gives the ATA raw counter, so a reporter is no longer the only source.

## Not governed

How a report's findings become a filesystem state: [storage-integrity.md](storage-integrity.md). The package payload and the warden installer: [warden-install.md](warden-install.md).
