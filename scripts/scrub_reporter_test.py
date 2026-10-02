"""The scrub reporter vsys ships, run against stub system commands.

The report is a text protocol, and src/collect/scrub.ts is its reader: each
reporter case parses the report it wrote with that parser, through Bun. The
installer cases check what it puts where, and what it refuses.
"""

from __future__ import annotations

import calendar
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
REPORTER = ROOT / "scripts" / "scrub-reporter"
SCRATCH_ROOT = ROOT / "tmp" / "scrub-reporter-tests"
UUID = "2ff9dd6d-c928-4458-9444-bffb6c01eacb"
STARTED = "Mon Sep 28 04:56:49 2026"


def status(state: str = "finished", errors: str = "csum=4", uncorrectable: int = 4, started: str = STARTED) -> str:
    return f"""UUID:             {UUID}
Scrub started:    {started}
Status:           {state}
Duration:         0:00:54
Error summary:    {errors}
  Corrected:      0
  Uncorrectable:  {uncorrectable}
  Unverified:     0
"""


STATUS_CLEAN = f"""UUID:             {UUID}
Scrub started:    {STARTED}
Status:           finished
Error summary:    no errors found
"""
# Addresses the stubbed resolver answers for, each a different outcome.
NAMED = 953118621696
# Off a 64 KiB boundary: a no-extent answer here is free space.
FREE = 1597612888064
# On one: through kernel 7.2 the logged block start can sit in a gap before
# the block's first extent, so a no-extent answer is not free space.
GAP = 1597612883968
UNMOUNTED = 1597612883969
SPLIT = 1597612883970
SPACED = 1597612883971
UNNAMED = 1597612883972
STDERR = 1597612883973
OTHER_FS = 5555


def fixup(device: str, address: int) -> str:
    """The wording kernels wrote before the scrub rewrite."""
    return f"Sep 28 04:57:01 host kernel: BTRFS error (device {device} state M): unable to fixup (regular) error at logical {address} on dev /dev/{device} physical 1"


def scrub_fixup(device: str, address: int) -> str:
    """The wording this host's 7.2 kernel writes, copied from its journal."""
    return f"Sep 11 17:04:40 cachy kernel: BTRFS error (device {device}): scrub: unable to fixup (regular) error at logical {address} on dev /dev/mapper/luks-4cb565bf-a669-49e2-91e9-5ec3fe422175 physical 831861293056"


def scratch() -> tempfile.TemporaryDirectory[str]:
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=SCRATCH_ROOT)


def stub(bin_dir: Path, name: str, body: str) -> None:
    path = bin_dir / name
    path.write_text("#!/usr/bin/env bash\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def child_env(bin_dir: Path, **extra: str) -> dict[str, str]:
    """The child's whole environment: stubs first, then the system tools."""
    return {"PATH": f"{bin_dir}:/usr/bin:/bin", "LC_ALL": "C", **extra}


def bun() -> str:
    found = ROOT / "node_modules" / ".bin" / "bun"
    path = str(found) if found.exists() else shutil.which("bun")
    if path is None:
        raise AssertionError("bun=missing: the report is parsed with vsys's own parser, which runs on Bun")
    return path


def parse(report: Path, home: Path) -> dict:
    """The report as vsys reads it."""
    done = subprocess.run(
        [bun(), "-e", "import { parseScrub } from './src/collect/scrub.ts'; console.log(JSON.stringify(parseScrub(await Bun.file(process.env.REPORT).text())));"],
        cwd=ROOT,
        env={"PATH": "/usr/bin:/bin", "HOME": str(home), "TZ": "UTC", "REPORT": str(report)},
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(done.stdout)


class ReporterTest(unittest.TestCase):
    def fixture(self, base: Path, status_text: str, kernel: str | None) -> Path:
        """Stub btrfs, journalctl and systemd-escape, and a filesystem of real files."""
        bin_dir = base / "bin"
        bin_dir.mkdir()
        (base / "status").write_text(status_text)
        fs = base / "fs"
        (fs / "target").mkdir(parents=True)
        first = fs / "target" / "build-script-build"
        first.write_text("x")
        # Two names of one damaged extent: the second is a hard link.
        os.link(first, fs / "target" / "bsb-c664")
        # A directory whose name ends in a newline holds the damaged file, so
        # btrfs prints its one name as two lines, and both lines name real,
        # healthy files.
        split = fs / "target" / "evil\n" / fs.relative_to("/") / "target" / "victim"
        split.parent.mkdir(parents=True)
        split.write_text("damaged")
        (fs / "target" / "evil").write_text("healthy")
        (fs / "target" / "victim").write_text("healthy")
        # A damaged name that differs from a healthy one by a trailing space.
        spaced = fs / "target" / "victim "
        spaced.write_text("damaged")
        # A second damaged inode with no name btrfs printed.
        unnamed = fs / "target" / "unlinked"
        unnamed.write_text("damaged")
        refs = base / "refs"
        names = base / "names"
        refs.mkdir()
        names.mkdir()

        def held(address: int, *paths: Path) -> None:
            (refs / str(address)).write_text("".join(f"inode {os.stat(p).st_ino} offset 0 root 5\n" for p in paths))

        held(NAMED, first)
        (names / str(NAMED)).write_text(f"{fs}/target/build-script-build\n{fs}/target/bsb-c664\n")
        (refs / f"{FREE}.err").write_text("ERROR: logical ino ioctl: No such file or directory\n")
        (refs / f"{GAP}.err").write_text("ERROR: logical ino ioctl: No such file or directory\n")
        held(UNMOUNTED, first)
        (names / str(UNMOUNTED)).write_text("inode 300 subvol snapshots/1 could not be accessed: not mounted\n")
        held(SPLIT, split)
        (names / str(SPLIT)).write_text(f"{split}\n")
        held(SPACED, spaced)
        (names / str(SPACED)).write_text(f"{spaced}\n")
        held(UNNAMED, first, unnamed)
        (names / str(UNNAMED)).write_text(f"{first}\n")
        # btrfs names one inode, fails another on stderr, and exits 0.
        held(STDERR, first)
        (names / str(STDERR)).write_text(f"{first}\n")
        (names / f"{STDERR}.warn").write_text("ERROR: ino paths ioctl: Permission denied\n")
        stub(bin_dir, "systemd-escape", 'echo "-"\n')
        if kernel is None:
            stub(bin_dir, "journalctl", "echo 'No journal files were found.' >&2\nexit 1\n")
        else:
            (base / "kernel").write_text(kernel)
            stub(bin_dir, "journalctl", f'printf "%s\\n" "$@" > "{base}/journalctl.args"\ncat "{base}/kernel"\n')
        stub(
            bin_dir,
            "btrfs",
            f"""case "$1 $2" in
"scrub status") cat "{base}/status" ;;
"device stats") printf '%s\\n' '[/dev/vsys-test-a].write_io_errs    0' '[/dev/vsys-test-a].corruption_errs  4' ;;
"inspect-internal rootid")
	# rootid opens a regular file for writing, which a read-only snapshot
	# refuses; a directory it opens read-only.
	if [[ -d $3 ]]; then echo 5; else echo "ERROR: cannot open $3: Read-only file system" >&2; exit 1; fi ;;
"inspect-internal logical-resolve")
	ls -A "{base}/reports" >> "{base}/listing"
	if [[ $3 == -P ]]; then table={refs}; address=$5; else table={names}; address=$4; fi
	if [[ -f $table/$address.stop ]]; then kill -TERM 0; sleep 5; fi
	if [[ -f $table/$address.err ]]; then cat "$table/$address.err" >&2; exit 1; fi
	if [[ -f $table/$address.warn ]]; then cat "$table/$address.warn" >&2; fi
	if [[ -f $table/$address ]]; then cat "$table/$address"; fi ;;
*) exit 2 ;;
esac
""",
        )
        return bin_dir

    def run_reporter(self, base: Path, status_text: str, kernel: str | None, **env: str) -> tuple[subprocess.CompletedProcess[str], Path]:
        bin_dir = base / "bin" if (base / "bin").exists() else self.fixture(base, status_text, kernel)
        reports = base / "reports"
        done = subprocess.run(
            ["bash", str(REPORTER / "vsys-scrub-report"), "/", str(reports)],
            env=child_env(bin_dir, **env),
            capture_output=True,
            text=True,
            check=False,
            start_new_session=True,
        )
        return done, reports / "-.result"

    def test_each_address_lists_only_names_proved_to_be_of_its_damage(self) -> None:
        kernel = "\n".join(fixup("vsys-test-a", a) for a in (FREE, GAP, NAMED, UNMOUNTED, SPLIT, NAMED))
        # The same report from a kernel that prefixes the words with `scrub: `.
        kernel += "\n" + "\n".join(scrub_fixup("vsys-test-a", a) for a in (SPACED, UNNAMED, STDERR))
        # Another filesystem's address, logged inside this scrub's window.
        kernel += "\n" + fixup("vsys-test-b", OTHER_FS) + "\n"
        with scratch() as tmp:
            base = Path(tmp)
            done, report = self.run_reporter(base, status(uncorrectable=6), kernel)
            self.assertEqual(done.returncode, 0, done.stderr)
            fs = base / "fs"
            read = parse(report, base)
            self.assertEqual(read["uuid"], UUID)
            self.assertEqual(read["status"], "finished")
            self.assertEqual(read["uncorrectable"], 6)
            self.assertEqual(read["corrected"], 0)
            self.assertEqual(read["startedAt"], calendar.timegm(time.strptime(STARTED, "%a %b %d %H:%M:%S %Y")) * 1000)
            self.assertEqual(
                read["addresses"],
                [
                    {"logical": NAMED, "paths": [f"{fs}/target/bsb-c664", f"{fs}/target/build-script-build"]},
                    # No extent at a 64 KiB block start is damage the report
                    # cannot name, never free space.
                    {"logical": GAP, "paths": [], "resolved": False},
                    # Unresolved, never free space: a snapshot not mounted, and
                    # a name btrfs split in two whose halves are healthy files.
                    {"logical": UNMOUNTED, "paths": [], "resolved": False},
                    {"logical": SPLIT, "paths": [], "resolved": False},
                    # A name with a trailing space reads as a healthy file's
                    # name once trimmed, so it is never written.
                    {"logical": SPACED, "paths": [], "resolved": False},
                    # One inode got no name, so the list would be partial.
                    {"logical": UNNAMED, "paths": [], "resolved": False},
                    # btrfs failed to name an inode on stderr and exited 0.
                    {"logical": STDERR, "paths": [], "resolved": False},
                    {"logical": FREE, "paths": []},
                ],
            )
            lines = report.read_text().splitlines()
            gap = lines[lines.index(f"logical {GAP}:") + 1]
            self.assertTrue(gap.startswith("  (not resolved"), gap)
            self.assertEqual(lines[lines.index(f"logical {FREE}:") + 1], "  (no file: free space, or already deleted)")
            self.assertNotIn(f"{fs}/target/victim \n", report.read_text())
            self.assertNotIn(str(OTHER_FS), report.read_text())
            # btrfs's own reason stays in the report for the reader.
            self.assertIn("  (not resolved: inode 300 subvol snapshots/1 could not be accessed: not mounted)", report.read_text().splitlines())
            # The search starts when the scrub started.
            args = (base / "journalctl.args").read_text().splitlines()
            self.assertEqual(args[args.index("--since") + 1], "2026-09-28 04:56:49")
            # While it resolved, only a hidden file stood in the report directory.
            self.assertEqual(set((base / "listing").read_text().split()), {".-.result.tmp"})
            self.assertEqual(sorted(os.listdir(base / "reports")), ["-.result"])

    def test_a_start_time_that_does_not_parse_searches_the_last_hour(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            done, _ = self.run_reporter(base, status(started="sometime"), fixup("vsys-test-a", NAMED))
            self.assertEqual(done.returncode, 0, done.stderr)
            args = (base / "journalctl.args").read_text().splitlines()
            self.assertEqual(args[args.index("--since") + 1], "-1h")

    def test_addresses_past_the_limit_are_counted_not_resolved(self) -> None:
        kernel = "\n".join(fixup("vsys-test-a", a) for a in (NAMED, FREE))
        with scratch() as tmp:
            base = Path(tmp)
            done, report = self.run_reporter(base, status(), kernel, BTRFS_SCRUB_MAX_ADDRESSES="1")
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual([a["logical"] for a in parse(report, base)["addresses"]], [NAMED])
            self.assertIn("(1 more addresses not resolved; raise BTRFS_SCRUB_MAX_ADDRESSES)", report.read_text().splitlines())

    def test_a_clean_scrub_writes_no_damaged_file_section(self) -> None:
        with scratch() as tmp:
            done, report = self.run_reporter(Path(tmp), STATUS_CLEAN, "")
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertTrue(report.read_text().startswith("btrfs scrub finished, no errors: /\n"))
            self.assertIsNone(parse(report, Path(tmp))["addresses"])

    def test_a_scrub_that_stopped_early_is_not_called_finished(self) -> None:
        with scratch() as tmp:
            done, report = self.run_reporter(Path(tmp), status(state="aborted", errors="no errors found"), "")
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(report.read_text().splitlines()[0], "btrfs scrub did not complete (aborted): /")

    def test_a_scrub_the_kernel_logged_no_address_for_says_so(self) -> None:
        with scratch() as tmp:
            done, report = self.run_reporter(Path(tmp), status(), "")
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(parse(report, Path(tmp))["addresses"], [])

    def test_an_unreadable_kernel_log_names_no_files_rather_than_none(self) -> None:
        # A section listing no address reads to vsys as a scrub that found no
        # damaged file, so a log the reporter could not read writes none.
        with scratch() as tmp:
            done, report = self.run_reporter(Path(tmp), status(), None)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIsNone(parse(report, Path(tmp))["addresses"])
            self.assertIn("No journal files were found.", report.read_text())

    def test_a_run_stopped_while_resolving_leaves_no_file_vsys_reads(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            self.fixture(base, status(), fixup("vsys-test-a", NAMED))
            (base / "reports").mkdir()
            (base / "reports" / "-.result").write_text("last month's report\n")
            (base / "refs" / f"{NAMED}.stop").write_text("")
            done, report = self.run_reporter(base, "", "")
            self.assertEqual(done.returncode, 128 + signal.SIGTERM, done.stderr)
            # The last complete report stands, and nothing half written is left.
            self.assertEqual(os.listdir(base / "reports"), ["-.result"])
            self.assertEqual(report.read_text(), "last month's report\n")


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
                    ("-Dm755", "vsys-scrub-report", "/usr/local/bin/vsys-scrub-report"),
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
        self.assertEqual(exec_line, "ExecStopPost=/usr/local/bin/vsys-scrub-report %f /run/btrfs-scrub")
        rule = next(line for line in tmpfiles.splitlines() if line and not line.startswith("#"))
        self.assertEqual(rule.split()[:2], ["d", "/run/btrfs-scrub"])
        config = (ROOT / "src" / "config" / "config.ts").read_text()
        self.assertIn('scrubDir: "/run/btrfs-scrub",', config)


if __name__ == "__main__":
    unittest.main()
