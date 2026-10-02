"""The drive reporter vsys ships, run against stub system commands.

The report is smartctl's own text, and smartWrites() in
src/collect/devices.ts is its reader: the reporter case parses each report it
wrote with that parser, through Bun. The installer cases check what it puts
where, and what it refuses.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
REPORTER = ROOT / "scripts" / "smart-reporter"
SCRATCH_ROOT = ROOT / "tmp" / "smart-reporter-tests"

NVME = """smartctl 7.4 2023-08-01 r5530 [x86_64-linux] (local build)
=== START OF INFORMATION SECTION ===
Model Number:                       Samsung SSD 990 PRO 2TB
=== START OF SMART DATA SECTION ===
Data Units Written:                 8,000,000 [4.09 TB]
"""
ATA = """smartctl 7.4 2023-08-01 r5530 [x86_64-linux] (local build)
Device Model:     Crucial CT1000MX500SSD1
ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
241 Total_LBAs_Written      0x0032   099   099   000    Old_age   Always       -       2000000
"""


def scratch() -> tempfile.TemporaryDirectory[str]:
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=SCRATCH_ROOT)


def stub(bin_dir: Path, name: str, body: str) -> None:
    path = bin_dir / name
    path.write_text("#!/usr/bin/env bash\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def bash() -> str:
    path = shutil.which("bash")
    if path is None:
        raise AssertionError("bash=missing: the reporter and its installer are bash scripts")
    return path


def bun() -> str:
    found = ROOT / "node_modules" / ".bin" / "bun"
    path = str(found) if found.exists() else shutil.which("bun")
    if path is None:
        raise AssertionError("bun=missing: the report is parsed with vsys's own parser, which runs on Bun")
    return path


def parse(report: Path, home: Path) -> dict:
    """The report as vsys reads it."""
    done = subprocess.run(
        [bun(), "-e", "import { smartWrites } from './src/collect/devices.ts'; console.log(JSON.stringify(smartWrites(await Bun.file(process.env.REPORT).text())));"],
        cwd=ROOT,
        env={"PATH": "/usr/bin:/bin", "HOME": str(home), "REPORT": str(report)},
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(done.stdout)


class ReporterTest(unittest.TestCase):
    def test_each_drive_gets_one_whole_report_and_nothing_else_does(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            bin_dir = base / "bin"
            bin_dir.mkdir()
            calls = base / "calls"
            sys_block = base / "block"
            # A drive has a device link; dm-0 has none, and vsys draws no row
            # for loop0 or sr0 even though each has one.
            for name, drive in (("nvme0n1", True), ("sda", True), ("dm-0", False), ("loop0", True), ("sr0", True)):
                (sys_block / name).mkdir(parents=True)
                if drive:
                    (sys_block / name / "device").mkdir()
            (base / "nvme.txt").write_text(NVME)
            (base / "ata.txt").write_text(ATA)
            # sda's status sets bit 2, as smartctl does when a SMART command
            # failed: the report still stands.
            stub(
                bin_dir,
                "smartctl",
                f"""printf '%s\\n' "$*" >> "{calls}"
case $3 in
/dev/nvme0n1) cat "{base}/nvme.txt" ;;
/dev/sda) cat "{base}/ata.txt"; exit 4 ;;
*) exit 2 ;;
esac
""",
            )
            reports = base / "reports"
            done = subprocess.run(
                [bash(), str(REPORTER / "vsys-smart-report"), str(reports)],
                env={"PATH": f"{bin_dir}:/usr/bin:/bin", "LC_ALL": "C", "SYS_BLOCK": str(sys_block)},
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(calls.read_text().splitlines(), ["-i -A /dev/nvme0n1", "-i -A /dev/sda"])
            # No hidden file is left, and each name is one vsys maps to its device.
            self.assertEqual(sorted(os.listdir(reports)), ["nvme0n1.txt", "sda.txt"])
            self.assertEqual(
                parse(reports / "nvme0n1.txt", base),
                {"model": "Samsung SSD 990 PRO 2TB", "lifetimeWritten": 8_000_000 * 512 * 1000},
            )
            self.assertEqual(
                parse(reports / "sda.txt", base),
                {"model": "Crucial CT1000MX500SSD1", "lifetimeWritten": 2_000_000 * 512},
            )


class InstallTest(unittest.TestCase):
    def run_install(self, base: Path, *, smartctl: bool = True, fail_download: str = "") -> tuple[subprocess.CompletedProcess[str], list[str]]:
        bin_dir = base / "bin"
        bin_dir.mkdir()
        calls = base / "calls"
        calls.write_text("")
        record = f'printf "%s\\n" "$(basename "$0") $*" >> "{calls}"\n'
        for name in ("systemctl", "systemd-tmpfiles", "install"):
            stub(bin_dir, name, record)
        if smartctl:
            stub(bin_dir, "smartctl", record)
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
        # The system directories come after the stubs only where the case
        # needs a real tool; with no smartctl the installer stops before any.
        path = f"{bin_dir}:/usr/bin:/bin" if smartctl else str(bin_dir)
        done = subprocess.run(
            [bash(), "-s"],
            input=(REPORTER / "install").read_text(),
            env={"PATH": path, "LC_ALL": "C"},
            capture_output=True,
            text=True,
            check=False,
        )
        return done, calls.read_text().splitlines()

    def test_the_installer_puts_each_file_where_systemd_reads_it_and_starts_the_timer(self) -> None:
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp))
            self.assertEqual(done.returncode, 0, done.stderr)
            installs = [call.split() for call in calls if call.startswith("install ")]
            self.assertEqual(
                [(call[1], Path(call[2]).name, call[3]) for call in installs],
                [
                    ("-Dm755", "vsys-smart-report", "/usr/local/bin/vsys-smart-report"),
                    ("-Dm644", "vsys-smart-report.service", "/etc/systemd/system/vsys-smart-report.service"),
                    ("-Dm644", "vsys-smart-report.timer", "/etc/systemd/system/vsys-smart-report.timer"),
                    ("-Dm644", "vsys-smart.conf", "/etc/tmpfiles.d/vsys-smart.conf"),
                ],
            )
            self.assertEqual(
                calls[-3:],
                [
                    "systemd-tmpfiles --create /etc/tmpfiles.d/vsys-smart.conf",
                    "systemctl daemon-reload",
                    "systemctl enable --now vsys-smart-report.timer",
                ],
            )
            self.assertEqual(done.stdout.splitlines()[0], "smart-reporter: installed")

    def test_no_smartctl_installs_nothing(self) -> None:
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp), smartctl=False)
            self.assertEqual(done.returncode, 1)
            self.assertEqual(done.stderr.splitlines()[0], "smart-reporter: command=smartctl missing")
            self.assertEqual(calls, [])

    def test_a_failed_download_installs_nothing(self) -> None:
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp), fail_download="vsys-smart.conf")
            self.assertEqual(done.returncode, 1)
            self.assertEqual(done.stderr.splitlines()[0], "smart-reporter: download=vsys-smart.conf failed")
            self.assertFalse(any(call.startswith(("install ", "systemd-tmpfiles", "systemctl")) for call in calls))


class ShippedFilesTest(unittest.TestCase):
    def test_the_service_and_the_tmpfiles_line_name_the_default_report_directory(self) -> None:
        # The service hands the reporter its directory and the tmpfiles line
        # creates it; vsys reads its default smartDir from the same path.
        service = (REPORTER / "vsys-smart-report.service").read_text()
        tmpfiles = (REPORTER / "vsys-smart.conf").read_text()
        exec_line = next(line for line in service.splitlines() if line.startswith("ExecStart="))
        self.assertEqual(exec_line, "ExecStart=/usr/local/bin/vsys-smart-report /run/smartctl")
        rule = next(line for line in tmpfiles.splitlines() if line and not line.startswith("#"))
        self.assertEqual(rule.split()[:2], ["d", "/run/smartctl"])
        config = (ROOT / "src" / "config" / "config.ts").read_text()
        self.assertIn('smartDir: "/run/smartctl",', config)
        timer = (REPORTER / "vsys-smart-report.timer").read_text()
        self.assertIn("WantedBy=timers.target", timer.splitlines())


if __name__ == "__main__":
    unittest.main()
