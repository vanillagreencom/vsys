# Drive reporter

Covers: scripts/smart-reporter/ scripts/smart_reporter_test.py

Drive lifetime writes, and the udisks2 fallback that answers without the reporter, are in [storage](storage.md). This file holds the root side that writes the reports, and its install.

## The drive reporter

`scripts/smart-reporter/` holds the root side of drive lifetime writes: `vsys-smart-report`, a oneshot service and an hourly timer that run it, and the tmpfiles line that creates `/run/smartctl` at boot, the default `smartDir`. The reporter writes `smartctl -i -A` output to `<name>.txt` for each `/sys/block` device with a drive behind it, under a hidden name renamed whole, and skips the loop, memory, optical and floppy devices vsys draws no row for. A nonzero smartctl status still leaves the report, because smartctl sets status bits for a failing drive. Each drive's query runs under `timeout`, `SMARTCTL_TIMEOUT` seconds by default 20, so a stalled query or a wedged USB bridge costs only that drive's report, read as lifetime writes unknown, and not the reports after it; the service's `TimeoutStartSec` is sized for the whole run the same way, and raising `SMARTCTL_TIMEOUT` by D needs `TimeoutStartSec` raised by D times the drive count, not by D. A missing `timeout` command exits the reporter loudly instead of masking every report. `install` fetches the four files from a tagged release, `VSYS_VERSION` or the latest, and checks each against that release's `SHA256SUMS`. It puts them in place under names of vsys's own, starts the timer, and installs nothing when smartctl or timeout is missing, a download fails, or a checksum is missing or does not match. `.github/workflows/release.yml` checksums the four files into `SHA256SUMS`, and `test_the_release_checksums_every_file_the_installer_fetches` in `scripts/smart_reporter_test.py` holds the installer's file list to the files beside it and to the release's checksum list. vsys never runs it: Storage and Settings offer the line to copy.

The invariants that hold the report format and its precedence over udisks2, and the tests that enforce them, are in [storage § Invariants](storage.md#invariants).
