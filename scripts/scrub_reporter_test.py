"""The scrub reporter vsys ships, run against stub system commands.

The report is a text protocol: src/collect/scrub.ts reads its `UUID:` and
`Status:` fields, the `Damaged files:` heading, each `logical <address>:`
heading and the two-space-indented paths under it. These tests pin what the
reporter writes against that reader, and what the installer puts where.
"""

from __future__ import annotations

import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
REPORTER = ROOT / "scripts" / "scrub-reporter"
SCRATCH_ROOT = ROOT / "tmp" / "scrub-reporter-tests"

STATUS_FOUND = """UUID:             2ff9dd6d-c928-4458-9444-bffb6c01eacb
Scrub started:    Mon Sep 28 04:56:49 2026
Status:           finished
Duration:         0:00:54
Error summary:    csum=3
  Corrected:      0
  Uncorrectable:  3
  Unverified:     0
"""
STATUS_CLEAN = """UUID:             2ff9dd6d-c928-4458-9444-bffb6c01eacb
Scrub started:    Mon Sep 28 04:56:49 2026
Status:           finished
Error summary:    no errors found
"""
KERNEL = """Sep 28 04:57:01 host kernel: BTRFS error (device dm-0): unable to fixup (regular) error at logical 953118621696 on dev /dev/dm-0 physical 1
Sep 28 04:57:02 host kernel: BTRFS error (device dm-0): unable to fixup (regular) error at logical 1597612883968 on dev /dev/dm-0 physical 2
Sep 28 04:57:03 host kernel: BTRFS error (device dm-0): unable to fixup (regular) error at logical 953118621696 on dev /dev/dm-0 physical 1
"""


def scratch() -> tempfile.TemporaryDirectory[str]:
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=SCRATCH_ROOT)


def stub(bin_dir: Path, name: str, body: str) -> None:
    path = bin_dir / name
    path.write_text("#!/usr/bin/env bash\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def child_env(bin_dir: Path) -> dict[str, str]:
    """The child's whole environment: stubs first, then the system tools."""
    return {"PATH": f"{bin_dir}:/usr/bin:/bin", "LC_ALL": "C"}


class ReporterTest(unittest.TestCase):
    def run_reporter(self, base: Path, status: str, kernel: str | None) -> tuple[subprocess.CompletedProcess[str], Path]:
        bin_dir = base / "bin"
        bin_dir.mkdir()
        (base / "status").write_text(status)
        stub(bin_dir, "systemd-escape", 'echo "-"\n')
        # None is a kernel log this user cannot read.
        if kernel is None:
            stub(bin_dir, "journalctl", "echo 'No journal files were found.' >&2\nexit 1\n")
        else:
            (base / "kernel").write_text(kernel)
            stub(bin_dir, "journalctl", f'cat "{base}/kernel"\n')
        # Two names for the first address, none for the second: one extent can
        # carry several names, and an address can resolve to free space.
        stub(
            bin_dir,
            "btrfs",
            f"""case "$1 $2" in
"scrub status") cat "{base}/status" ;;
"inspect-internal logical-resolve")
	case "$4" in
	953118621696) printf '%s\\n' /r/target/debug/build-script-build /r/target/debug/bsb-c664 ;;
	esac ;;
*) exit 2 ;;
esac
""",
        )
        reports = base / "reports"
        done = subprocess.run(
            ["bash", str(REPORTER / "btrfs-scrub-report"), "/", str(reports)],
            env=child_env(bin_dir),
            capture_output=True,
            text=True,
            check=False,
        )
        return done, reports / "-.result"

    def test_a_scrub_that_found_damage_names_every_path_under_each_address(self) -> None:
        with scratch() as tmp:
            done, report = self.run_reporter(Path(tmp), STATUS_FOUND, KERNEL)
            self.assertEqual(done.returncode, 0, done.stderr)
            lines = report.read_text().splitlines()
            self.assertIn("UUID:             2ff9dd6d-c928-4458-9444-bffb6c01eacb", lines)
            self.assertIn("Status:           finished", lines)
            self.assertIn("  Uncorrectable:  3", lines)
            section = lines.index(next(line for line in lines if line.startswith("Damaged files:")))
            # Each address once, in order, with every name under it.
            self.assertEqual(
                [line for line in lines[section:] if line.startswith("logical ") or line.startswith("  ")],
                [
                    "logical 953118621696:",
                    "  /r/target/debug/bsb-c664",
                    "  /r/target/debug/build-script-build",
                    "logical 1597612883968:",
                    "  (no file: free space, or already deleted)",
                ],
            )
            self.assertFalse(report.with_suffix(".result.tmp").exists())

    def test_a_clean_scrub_writes_no_damaged_file_section(self) -> None:
        with scratch() as tmp:
            done, report = self.run_reporter(Path(tmp), STATUS_CLEAN, KERNEL)
            self.assertEqual(done.returncode, 0, done.stderr)
            text = report.read_text()
            self.assertTrue(text.startswith("btrfs scrub finished, no errors: /\n"))
            self.assertIn("Error summary:    no errors found", text)
            self.assertNotIn("Damaged files:", text)

    def test_a_scrub_the_kernel_logged_no_address_for_says_so(self) -> None:
        with scratch() as tmp:
            done, report = self.run_reporter(Path(tmp), STATUS_FOUND, "")
            self.assertEqual(done.returncode, 0, done.stderr)
            lines = report.read_text().splitlines()
            self.assertIn("Damaged files: no unfixable address in the kernel log for this run.", lines)
            self.assertFalse(any(line.startswith("logical ") for line in lines))


    def test_an_unreadable_kernel_log_names_no_files_rather_than_none(self) -> None:
        # A section listing no address reads to vsys as a scrub that found no
        # damaged file, so a log the reporter could not read writes none.
        with scratch() as tmp:
            done, report = self.run_reporter(Path(tmp), STATUS_FOUND, None)
            self.assertEqual(done.returncode, 0, done.stderr)
            text = report.read_text()
            self.assertIn("Status:           finished", text)
            self.assertNotIn("Damaged files:", text)
            self.assertIn("No journal files were found.", text)


class InstallTest(unittest.TestCase):
    def run_install(self, base: Path, *, unit: bool = True, fail_download: str = "") -> tuple[subprocess.CompletedProcess[str], list[str]]:
        bin_dir = base / "bin"
        bin_dir.mkdir()
        calls = base / "calls"
        calls.write_text("")
        record = f'printf "%s\\n" "$(basename "$0") $*" >> "{calls}"\n'
        stub(bin_dir, "systemctl", record + ('[[ $1 == cat ]] && exit 1\n' if not unit else "") + "exit 0\n")
        stub(bin_dir, "systemd-tmpfiles", record)
        stub(bin_dir, "install", record)
        # The download serves the checkout's own files, by the name the URL ends in.
        stub(
            bin_dir,
            "curl",
            record
            + f"""name=${{2##*/}}
[[ $name == "{fail_download}" ]] && exit 22
cp "{REPORTER}/$name" "$4"
""",
        )
        done = subprocess.run(
            ["bash", "-s"],
            input=(REPORTER / "install").read_text(),
            env=child_env(bin_dir),
            capture_output=True,
            text=True,
            check=False,
        )
        return done, calls.read_text().splitlines()

    def test_the_installer_puts_each_file_where_systemd_reads_it(self) -> None:
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp))
            self.assertEqual(done.returncode, 0, done.stderr)
            installs = [call.split() for call in calls if call.startswith("install ")]
            self.assertEqual(
                [(call[1], Path(call[2]).name, call[3]) for call in installs],
                [
                    ("-Dm755", "btrfs-scrub-report", "/usr/local/bin/btrfs-scrub-report"),
                    ("-Dm644", "vsys-report.conf", "/etc/systemd/system/btrfs-scrub@.service.d/vsys-report.conf"),
                    ("-Dm644", "vsys-scrub.conf", "/etc/tmpfiles.d/vsys-scrub.conf"),
                ],
            )
            self.assertIn("systemd-tmpfiles --create /etc/tmpfiles.d/vsys-scrub.conf", calls)
            self.assertEqual(calls[-1], "systemctl daemon-reload")
            self.assertEqual(done.stdout.splitlines()[0], "scrub-reporter: installed")

    def test_no_scrub_unit_installs_nothing(self) -> None:
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp), unit=False)
            self.assertEqual(done.returncode, 1)
            self.assertEqual(done.stderr.splitlines()[0], "scrub-reporter: unit=btrfs-scrub@.service missing")
            self.assertEqual(calls, ["systemctl cat btrfs-scrub@.service"])

    def test_a_failed_download_installs_nothing(self) -> None:
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp), fail_download="vsys-scrub.conf")
            self.assertEqual(done.returncode, 1)
            self.assertEqual(done.stderr.splitlines()[0], "scrub-reporter: download=vsys-scrub.conf failed")
            self.assertFalse(any(call.startswith(("install ", "systemd-tmpfiles", "systemctl daemon-reload")) for call in calls))


class ShippedFilesTest(unittest.TestCase):
    def test_the_drop_in_and_the_tmpfiles_line_name_one_directory(self) -> None:
        # The reporter takes its directory from the drop-in, and the tmpfiles
        # line creates it; vsys reads its default scrubDir from the same path.
        drop_in = (REPORTER / "vsys-report.conf").read_text()
        tmpfiles = (REPORTER / "vsys-scrub.conf").read_text()
        exec_line = next(line for line in drop_in.splitlines() if line.startswith("ExecStopPost="))
        self.assertEqual(exec_line, "ExecStopPost=/usr/local/bin/btrfs-scrub-report %f /run/btrfs-scrub")
        rule = next(line for line in tmpfiles.splitlines() if line and not line.startswith("#"))
        self.assertEqual(rule.split()[:2], ["d", "/run/btrfs-scrub"])
        config = (ROOT / "src" / "config" / "config.ts").read_text()
        self.assertIn('scrubDir: "/run/btrfs-scrub",', config)


if __name__ == "__main__":
    unittest.main()
