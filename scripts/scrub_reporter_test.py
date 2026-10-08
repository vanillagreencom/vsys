"""The scrub reporter vsys ships, run against stub system commands.

The report is a text protocol, and src/collect/scrub.ts is its reader: each
reporter case parses the report it wrote with that parser, through Bun. The
installer cases check what it puts where, and what it refuses.
"""

from __future__ import annotations

import calendar
import hashlib
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


# What `btrfs device stats` prints for the one device of the fixture filesystem.
DEVICE_STATS = "[/dev/vsys-test-a].write_io_errs    0\n[/dev/vsys-test-a].corruption_errs  4\n"

STATUS_CLEAN = f"""UUID:             {UUID}
Scrub started:    {STARTED}
Status:           finished
Error summary:    no errors found
"""
# Addresses the stubbed resolver answers for, each a different outcome.
NAMED = 953118621696
# The resolver answers that no extent holds these, once by failing and once
# by printing no inode. On some kernels a logged block start can sit in a gap
# before the block's first extent, so neither answer is free space.
NO_EXTENT = 1597612883968
# The second sector (offset 4096) of NO_EXTENT's own floored block: resolving
# it exercises the "ioctl succeeds but holds no inode" no-extent path beside
# NO_EXTENT's own "ioctl fails" path, within the one block both now floor to.
EMPTY = NO_EXTENT + 4096
# Each of these is the start of its own 64 KiB block, not an address a few
# bytes from NO_EXTENT: once the scan floors to a block and sweeps only its
# own 16 sectors, an address that close would floor into NO_EXTENT's block
# and never reach the fixture below that gives it its own distinct failure.
UNMOUNTED = NO_EXTENT + 65536 * 6
SPLIT = NO_EXTENT + 65536 * 7
SPACED = NO_EXTENT + 65536 * 8
UNNAMED = NO_EXTENT + 65536 * 9
STDERR = NO_EXTENT + 65536 * 10
OTHER_FS = 5555
# The kernel logs this block's start, which has no extent; the file the scrub
# actually damaged sits five 4 KiB sectors later in the same 64 KiB block.
LATE_SECTOR = NO_EXTENT + 65536 * 2
# This block's start fails resolution for a real reason (btrfs warns on
# stderr); a different sector of the same block resolves cleanly.
MIXED_SECTOR = NO_EXTENT + 65536 * 3
# The file the scrub damaged sits only at the block's very last 4 KiB
# sector (offset 15 * 4096), proving the full 16-sector sweep runs to its end.
LAST_SECTOR = NO_EXTENT + 65536 * 4
# Btrfs's own reproduction: a block group that does not start on a 64 KiB
# boundary from byte zero. The kernel logs this block's start exactly as
# btrfs placed it, not on any absolute grid, and the file sits at the
# block's last sector. Flooring the address to the nearest absolute 64 KiB
# multiple, rather than scanning from the address as given, computes the
# wrong window and misses this file.
BLOCK_GROUP_START = 69632
BLOCK_GROUP_LAST_SECTOR = BLOCK_GROUP_START + 15 * 4096
# This block's first sector fails resolution for a real reason, but btrfs
# gives no diagnostic text at all (an empty stderr, e.g. a nested-subvolume
# path-buffer error): the failure must still mark the block not resolved,
# never read as harmless because its reason string happened to be empty. A
# different sector of the same block resolves cleanly.
EMPTY_DIAGNOSTIC = NO_EXTENT + 65536 * 11


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
    """The report as vsys reads it, with the problem verdict Storage draws from it."""
    done = subprocess.run(
        [
            bun(),
            "-e",
            "import { scrubProblem } from './src/collect/btrfs.ts'; import { parseScrub } from './src/collect/scrub.ts';"
            " const text = await Bun.file(process.env.REPORT).text();"
            " console.log(JSON.stringify({ ...parseScrub(text), problem: scrubProblem(text) }));",
        ],
        cwd=ROOT,
        env={"PATH": "/usr/bin:/bin", "HOME": str(home), "TZ": "UTC", "REPORT": str(report)},
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(done.stdout)


class ReporterTest(unittest.TestCase):
    def fixture(self, base: Path, status_text: str, kernel: str | None, device_stats: str | None = DEVICE_STATS) -> Path:
        """Stub btrfs, journalctl and systemd-escape, and a filesystem of real files.

        A `device_stats` of None makes `btrfs device stats` fail.
        """
        bin_dir = base / "bin"
        bin_dir.mkdir()
        (base / "status").write_text(status_text)
        if device_stats is not None:
            (base / "device-stats").write_text(device_stats)
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
        # A file reachable only from a sector later in its 64 KiB block, and
        # one reachable from a sector in a block whose first sector fails.
        late = fs / "target" / "late"
        late.write_text("damaged")
        safe = fs / "target" / "safe"
        safe.write_text("damaged")
        # A file reachable only from the block's very last sector, and one
        # reachable only from the last sector of a block group that does not
        # start on an absolute 64 KiB boundary.
        last = fs / "target" / "last"
        last.write_text("damaged")
        unaligned_group = fs / "target" / "unaligned-group"
        unaligned_group.write_text("damaged")
        # A file reachable from a sector beside one that fails with no
        # diagnostic text at all.
        clean = fs / "target" / "clean"
        clean.write_text("damaged")
        refs = base / "refs"
        names = base / "names"
        refs.mkdir()
        names.mkdir()

        def held(address: int, *paths: Path) -> None:
            (refs / str(address)).write_text("".join(f"inode {os.stat(p).st_ino} offset 0 root 5\n" for p in paths))

        held(NAMED, first)
        (names / str(NAMED)).write_text(f"{fs}/target/build-script-build\n{fs}/target/bsb-c664\n")
        (refs / f"{NO_EXTENT}.err").write_text("ERROR: logical ino ioctl: No such file or directory\n")
        (refs / str(EMPTY)).write_text("")
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
        # LATE_SECTOR's own first sector has no fixture, so it reads as no
        # extent; its sixth sector (offset 5 * 4096) holds the file.
        held(LATE_SECTOR + 5 * 4096, late)
        (names / str(LATE_SECTOR + 5 * 4096)).write_text(f"{late}\n")
        # MIXED_SECTOR's first sector fails like STDERR above; its fourth
        # sector (offset 3 * 4096) resolves cleanly.
        held(MIXED_SECTOR, first)
        (names / str(MIXED_SECTOR)).write_text(f"{first}\n")
        (names / f"{MIXED_SECTOR}.warn").write_text("ERROR: ino paths ioctl: Permission denied\n")
        held(MIXED_SECTOR + 3 * 4096, safe)
        (names / str(MIXED_SECTOR + 3 * 4096)).write_text(f"{safe}\n")
        # LAST_SECTOR's file sits only at its block's final sector (index 15).
        held(LAST_SECTOR + 15 * 4096, last)
        (names / str(LAST_SECTOR + 15 * 4096)).write_text(f"{last}\n")
        # BLOCK_GROUP_LAST_SECTOR sits 15 sectors past the logged, real block
        # start btrfs placed on no absolute grid; reachable only by scanning
        # from that given address, never by flooring it to one of this
        # reporter's own.
        held(BLOCK_GROUP_LAST_SECTOR, unaligned_group)
        (names / str(BLOCK_GROUP_LAST_SECTOR)).write_text(f"{unaligned_group}\n")
        # EMPTY_DIAGNOSTIC's own first sector fails the -P ioctl with no
        # output at all on stdout or stderr; its second sector (offset
        # 4096) resolves cleanly.
        (refs / f"{EMPTY_DIAGNOSTIC}.err").write_text("")
        held(EMPTY_DIAGNOSTIC + 4096, clean)
        (names / str(EMPTY_DIAGNOSTIC + 4096)).write_text(f"{clean}\n")
        stub(bin_dir, "systemd-escape", 'echo "-"\n')
        stub(bin_dir, "findmnt", f'echo "{UUID}"\n')
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
"device stats")
	if [[ -f {base}/device-stats ]]; then cat "{base}/device-stats"; else echo "ERROR: getting device info for $3 failed: Inappropriate ioctl for device" >&2; exit 1; fi ;;
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

    def run_reporter(
        self, base: Path, status_text: str, kernel: str | None, device_stats: str | None = DEVICE_STATS,
        *, umask: int = -1, **env: str
    ) -> tuple[subprocess.CompletedProcess[str], Path]:
        bin_dir = base / "bin" if (base / "bin").exists() else self.fixture(base, status_text, kernel, device_stats)
        reports = base / "reports"
        done = subprocess.run(
            ["bash", str(REPORTER / "vsys-scrub-report"), "/", str(reports)],
            env=child_env(bin_dir, **env),
            capture_output=True,
            text=True,
            check=False,
            start_new_session=True,
            umask=umask,
        )
        return done, reports / "-.result"

    def test_resolved_name_requires_the_scrubbed_filesystem(self) -> None:
        cases = (
            ("same filesystem at another mount", UUID, 0, True),
            ("foreign filesystem", "ffffffff-ffff-ffff-ffff-ffffffffffff", 0, False),
            ("missing identity", "", 0, False),
            ("failed identity read", UUID, 1, False),
        )
        for label, file_uuid, exit_code, accepted in cases:
            with self.subTest(case=label), scratch() as tmp:
                base = Path(tmp)
                bin_dir = self.fixture(base, status(uncorrectable=1), fixup("vsys-test-a", NAMED))
                other = base / "other-mount" / "victim"
                other.parent.mkdir()
                other.write_text("x")
                # Matching inode and subvolume IDs do not prove filesystem identity.
                (base / "refs" / str(NAMED)).write_text(f"inode {other.stat().st_ino} offset 0 root 5\n")
                (base / "names" / str(NAMED)).write_text(f"{other}\n")
                stub(bin_dir, "findmnt", f'''[[ "$*" == "--noheadings --output UUID --target {other}" ]] || exit 2
echo "{file_uuid}"
exit {exit_code}
''')
                done, report = self.run_reporter(base, status(), None)
                self.assertEqual(done.returncode, 0, done.stderr)
                address = parse(report, base)["addresses"][0]
                self.assertEqual(address["logical"], NAMED)
                self.assertEqual(address["paths"], [str(other)] if accepted else [])
                self.assertEqual(address.get("resolved", True), accepted)

    def test_report_replacement_keeps_other_user_read_permission(self) -> None:
        for mask in (0o022, 0o077):
            with self.subTest(umask=oct(mask)), scratch() as tmp:
                base = Path(tmp)
                reports = base / "reports"
                reports.mkdir()
                reports.chmod(0o755)
                report = reports / "-.result"
                report.write_text("old report\n")
                report.chmod(0o644)
                done, report = self.run_reporter(base, STATUS_CLEAN, None, umask=mask)
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertIn(STATUS_CLEAN, report.read_text())
                self.assertEqual(stat.S_IMODE(report.stat().st_mode), 0o644)

    def test_each_address_lists_only_names_proved_to_be_of_its_damage(self) -> None:
        kernel = "\n".join(fixup("vsys-test-a", a) for a in (EMPTY, NO_EXTENT, NAMED, UNMOUNTED, SPLIT, NAMED))
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
                    # No extent holds it: damage the report cannot name,
                    # never free space.
                    {"logical": NO_EXTENT, "paths": [], "resolved": False},
                    {"logical": EMPTY, "paths": [], "resolved": False},
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
                ],
            )
            # Each way the resolver says no extent gets the not-resolved line,
            # and no address is written as free space.
            lines = report.read_text().splitlines()
            for address in (NO_EXTENT, EMPTY):
                answer = lines[lines.index(f"logical {address}:") + 1]
                self.assertTrue(answer.startswith("  (not resolved"), answer)
            self.assertNotIn("(no file", report.read_text())
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

    def test_a_file_later_in_the_block_is_found_when_the_blocks_start_has_no_extent(self) -> None:
        kernel = fixup("vsys-test-a", LATE_SECTOR)
        with scratch() as tmp:
            base = Path(tmp)
            done, report = self.run_reporter(base, status(uncorrectable=1), kernel)
            self.assertEqual(done.returncode, 0, done.stderr)
            fs = base / "fs"
            read = parse(report, base)
            # The kernel-logged address itself has no extent; the file the
            # scrub damaged sits five sectors later in the same block, and is
            # listed because every sector was tried, not only the start.
            self.assertEqual(read["addresses"], [{"logical": LATE_SECTOR, "paths": [f"{fs}/target/late"]}])

    def test_a_resolution_failure_in_one_sector_marks_the_block_not_resolved_even_beside_a_name_a_different_sector_proves(self) -> None:
        kernel = fixup("vsys-test-a", MIXED_SECTOR)
        with scratch() as tmp:
            base = Path(tmp)
            done, report = self.run_reporter(base, status(uncorrectable=1), kernel)
            self.assertEqual(done.returncode, 0, done.stderr)
            fs = base / "fs"
            text = report.read_text()
            # The raw report still carries the name a clean sector proved, for
            # a reader of the file itself, beside the other sector's failure.
            self.assertIn(f"  {fs}/target/safe", text.splitlines())
            self.assertIn("  (not resolved: ERROR: ino paths ioctl: Permission denied )", text.splitlines())
            # Once vsys parses it, the not-resolved mark drops that name too:
            # the report cannot say every file in the block was found, so the
            # address is not resolved rather than partially listed.
            read = parse(report, base)
            self.assertEqual(read["addresses"], [{"logical": MIXED_SECTOR, "paths": [], "resolved": False}])

    def test_the_blocks_last_sector_is_still_resolved(self) -> None:
        kernel = fixup("vsys-test-a", LAST_SECTOR)
        with scratch() as tmp:
            base = Path(tmp)
            done, report = self.run_reporter(base, status(uncorrectable=1), kernel)
            self.assertEqual(done.returncode, 0, done.stderr)
            fs = base / "fs"
            read = parse(report, base)
            # The file sits only at sector index 15, the sweep's last
            # iteration, so a scan that stopped one sector short would miss it.
            self.assertEqual(read["addresses"], [{"logical": LAST_SECTOR, "paths": [f"{fs}/target/last"]}])

    def test_a_block_group_not_on_an_absolute_64kib_boundary_still_resolves_its_last_sector(self) -> None:
        kernel = fixup("vsys-test-a", BLOCK_GROUP_START)
        with scratch() as tmp:
            base = Path(tmp)
            done, report = self.run_reporter(base, status(uncorrectable=1), kernel)
            self.assertEqual(done.returncode, 0, done.stderr)
            fs = base / "fs"
            read = parse(report, base)
            # Btrfs rounds the logged address down within its own block
            # group, not to any absolute 64 KiB grid. Scanning the block's
            # 16 sectors from the address exactly as given, rather than
            # flooring it to the nearest multiple of 65536, is what finds a
            # file at this block's real last sector.
            self.assertEqual(read["addresses"], [{"logical": BLOCK_GROUP_START, "paths": [f"{fs}/target/unaligned-group"]}])

    def test_a_failure_with_no_diagnostic_text_still_marks_the_block_not_resolved(self) -> None:
        kernel = fixup("vsys-test-a", EMPTY_DIAGNOSTIC)
        with scratch() as tmp:
            base = Path(tmp)
            done, report = self.run_reporter(base, status(uncorrectable=1), kernel)
            self.assertEqual(done.returncode, 0, done.stderr)
            # The failing sector gives btrfs no diagnostic text at all, but
            # the not-resolved marker still follows the failure itself, not
            # whether a reason string happened to be non-empty.
            self.assertIn("  (not resolved: no diagnostic text)", report.read_text().splitlines())
            read = parse(report, base)
            self.assertEqual(read["addresses"], [{"logical": EMPTY_DIAGNOSTIC, "paths": [], "resolved": False}])

    def test_a_start_time_that_does_not_parse_searches_the_last_hour(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            done, _ = self.run_reporter(base, status(started="sometime"), fixup("vsys-test-a", NAMED))
            self.assertEqual(done.returncode, 0, done.stderr)
            args = (base / "journalctl.args").read_text().splitlines()
            self.assertEqual(args[args.index("--since") + 1], "-1h")

    def test_addresses_past_the_limit_are_counted_not_resolved(self) -> None:
        kernel = "\n".join(fixup("vsys-test-a", a) for a in (NAMED, NO_EXTENT))
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
            read = parse(report, Path(tmp))
            self.assertEqual((read["status"], read["problem"]), ("finished", False))
            self.assertIsNone(read["addresses"])

    def test_a_scrub_that_stopped_early_is_not_called_finished(self) -> None:
        with scratch() as tmp:
            done, report = self.run_reporter(Path(tmp), status(state="aborted", errors="no errors found"), "")
            self.assertEqual(done.returncode, 0, done.stderr)
            read = parse(report, Path(tmp))
            self.assertEqual((read["status"], read["problem"]), ("aborted", True))

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

    def test_a_device_list_it_cannot_read_names_no_files_rather_than_none(self) -> None:
        # Without this filesystem's devices no logged address can be kept, so
        # a section would list none and read as a scrub that found no damaged
        # file. The kernel log names a damaged address on the device each time.
        # A failed `btrfs device stats`, and one that named no device.
        for device_stats in (None, ""):
            with self.subTest(device_stats=device_stats), scratch() as tmp:
                done, report = self.run_reporter(Path(tmp), status(), fixup("vsys-test-a", NAMED), device_stats)
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertIsNone(parse(report, Path(tmp))["addresses"])

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


REPORTER_FILES = ("vsys-scrub-report", "vsys-report.conf", "vsys-scrub.conf")


def reporter_sums(**overrides: str) -> str:
    """The checksums a release publishing the checkout's own files would
    carry, except a name given in overrides checksums that text instead: a
    test corrupting one downloaded file still needs the others, and that
    one, to pass checksum verification before it reaches its own guard.
    """
    return "".join(
        f"{hashlib.sha256(overrides[name].encode() if name in overrides else (REPORTER / name).read_bytes()).hexdigest()}  {name}\n"
        for name in REPORTER_FILES
    )


class InstallTest(unittest.TestCase):
    def run_install(
        self,
        base: Path,
        *,
        unit: bool = True,
        fail_download: str = "",
        fail_sums: bool = False,
        sums_text: str | None = None,
        version: str | None = "vfixture",
        api_tag: str | None = "vlatest-fixture",
        fail_api: bool = False,
        legacy_dir: Path | None = None,
        scrub_dir: Path | None = None,
        scrub_dir_unset: bool = False,
        report_conf: str | None = None,
        cp_stub: str = "",
        mv_stub: str = "",
        umask: int = -1,
    ) -> tuple[subprocess.CompletedProcess[str], list[str]]:
        """version=None leaves VSYS_VERSION unset, so install resolves the tag
        itself from the stubbed GitHub API, the same lookup install.sh uses.

        scrub_dir_unset=True drops VSYS_SCRUB_DIR from the child's environment
        entirely, so migration falls back to the installer's own report_dir
        resolution; the caller must then keep report_dir (via report_conf)
        off the real /var/lib and /run so the test stays scratch-only.
        """
        bin_dir = base / "bin"
        bin_dir.mkdir()
        calls = base / "calls"
        calls.write_text("")
        record = f'printf "%s\\n" "$(basename "$0") $*" >> "{calls}"\n'
        stub(bin_dir, "systemctl", record + ('[[ $1 == cat ]] && exit 1\n' if not unit else "") + "exit 0\n")
        stub(bin_dir, "systemd-tmpfiles", record)
        stub(bin_dir, "install", record)
        sums_path = base / "SHA256SUMS"
        sums_path.write_text(sums_text if sums_text is not None else reporter_sums())
        sums_fetch = "exit 22" if fail_sums else f'cp "{sums_path}" "$4"'
        if fail_api:
            api_fetch = "exit 22"
        else:
            body = f'{{"tag_name": "{api_tag}"}}' if api_tag is not None else '{"message": "Not Found"}'
            api_fetch = f"printf '%s\\n' '{body}'"
        if cp_stub:
            stub(bin_dir, "cp", cp_stub)
        if mv_stub:
            stub(bin_dir, "mv", mv_stub)
        # report_conf hands the installer a corrupted vsys-report.conf for
        # just that one download (a case the installer must itself refuse,
        # so it never touches a real system that way).
        if report_conf is not None:
            (base / "vsys-report.conf").write_text(report_conf)
        # The download serves the checkout's own files, by the name the URL ends
        # in, so the call carries the resolved version in its path either way,
        # except vsys-report.conf when a test hands its own text. The version
        # lookup has no -o: curl writes the release JSON to stdout.
        stub(
            bin_dir,
            "curl",
            record
            + f"""url=$2
case "$url" in
*/releases/latest) {api_fetch} ;;
*)
	name=${{url##*/}}
	case "$name" in
	SHA256SUMS) {sums_fetch} ;;
	"{fail_download}") exit 22 ;;
	vsys-report.conf)
		if [[ -f "{base}/vsys-report.conf" ]]; then
			cp "{base}/vsys-report.conf" "$4"
		else
			cp "{REPORTER}/$name" "$4"
		fi
		;;
	*) cp "{REPORTER}/$name" "$4" ;;
	esac
	;;
esac
""",
        )
        env_extra = {} if version is None else {"VSYS_VERSION": version}
        if not scrub_dir_unset:
            env_extra["VSYS_SCRUB_DIR"] = str(scrub_dir if scrub_dir is not None else base / "unused-persistent")
        # VSYS_SCRUB_DIR/VSYS_SCRUB_LEGACY_DIR keep the install script's own
        # migration logic off the real /var/lib and /run: a path under `base`
        # that nothing creates reproduces "legacy directory absent".
        done = subprocess.run(
            ["bash", "-s"],
            input=(REPORTER / "install").read_text(),
            env=child_env(
                bin_dir,
                VSYS_SCRUB_LEGACY_DIR=str(legacy_dir if legacy_dir is not None else base / "unused-legacy"),
                **env_extra,
            ),
            capture_output=True,
            text=True,
            check=False,
            umask=umask,
        )
        return done, calls.read_text().splitlines()

    def test_migrated_report_keeps_other_user_read_permission(self) -> None:
        for mask in (0o022, 0o077):
            with self.subTest(umask=oct(mask)), scratch() as tmp:
                base = Path(tmp)
                legacy = base / "legacy"
                legacy.mkdir()
                source = legacy / "-.result"
                source.write_text(STATUS_CLEAN)
                source.chmod(0o644)
                reports = base / "reports"
                reports.mkdir()
                reports.chmod(0o755)
                done, _ = self.run_install(base, legacy_dir=legacy, scrub_dir=reports, umask=mask)
                self.assertEqual(done.returncode, 0, done.stderr)
                report = reports / source.name
                self.assertEqual(report.read_text(), STATUS_CLEAN)
                self.assertEqual(stat.S_IMODE(report.stat().st_mode), 0o644)

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

    def test_the_installer_fetches_from_the_resolved_version_tag(self) -> None:
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp), version="v9.9.9")
            self.assertEqual(done.returncode, 0, done.stderr)
            fetches = [call for call in calls if call.startswith("curl ")]
            self.assertTrue(
                any("/vanillagreencom/vsys/v9.9.9/scripts/scrub-reporter/vsys-scrub-report" in call for call in fetches),
                fetches,
            )
            self.assertTrue(
                any("/vanillagreencom/vsys/releases/download/v9.9.9/SHA256SUMS" in call for call in fetches),
                fetches,
            )

    def test_an_unset_version_resolves_the_latest_release(self) -> None:
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp), version=None, api_tag="vlatest-fixture")
            self.assertEqual(done.returncode, 0, done.stderr)
            fetches = [call for call in calls if call.startswith("curl ")]
            self.assertTrue(any("api.github.com/repos/vanillagreencom/vsys/releases/latest" in call for call in fetches), fetches)
            self.assertTrue(
                any("/vanillagreencom/vsys/vlatest-fixture/scripts/scrub-reporter/vsys-scrub-report" in call for call in fetches),
                fetches,
            )

    def test_a_failed_version_lookup_installs_nothing(self) -> None:
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp), version=None, fail_api=True)
            self.assertEqual(done.returncode, 1)
            self.assertEqual(done.stderr.splitlines()[0], "scrub-reporter: lookup=latest-release failed")
            self.assertFalse(any(call.startswith(("install ", "systemd-tmpfiles", "systemctl daemon-reload")) for call in calls))

    def test_a_release_response_with_no_tag_installs_nothing(self) -> None:
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp), version=None, api_tag=None)
            self.assertEqual(done.returncode, 1)
            self.assertEqual(done.stderr.splitlines()[0], "scrub-reporter: lookup=latest-release empty repo=vanillagreencom/vsys")
            self.assertFalse(any(call.startswith(("install ", "systemd-tmpfiles", "systemctl daemon-reload")) for call in calls))

    def test_no_scrub_unit_installs_nothing(self) -> None:
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp), unit=False)
            self.assertEqual(done.returncode, 1)
            self.assertEqual(done.stderr.splitlines()[0], "scrub-reporter: unit=btrfs-scrub@.service missing")
            self.assertEqual(calls, ["systemctl cat btrfs-scrub@.service"])

    def test_a_report_conf_with_no_execstoppost_line_installs_nothing(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            broken = "\n".join(
                line
                for line in (REPORTER / "vsys-report.conf").read_text().splitlines()
                if not line.startswith("ExecStopPost=")
            ) + "\n"
            done, calls = self.run_install(base, report_conf=broken, sums_text=reporter_sums(**{"vsys-report.conf": broken}))
            self.assertEqual(done.returncode, 1)
            self.assertTrue(
                done.stderr.splitlines()[0].startswith("scrub-reporter: parse=vsys-report.conf-missing-execstoppost"),
                done.stderr,
            )
            self.assertFalse(any(call.startswith(("install ", "systemd-tmpfiles", "systemctl daemon-reload")) for call in calls))

    def test_a_report_conf_with_a_relative_execstoppost_path_installs_nothing(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            original = (REPORTER / "vsys-report.conf").read_text()
            broken = original.replace("/var/lib/btrfs-scrub", "var/lib/btrfs-scrub")
            self.assertIn("ExecStopPost=", broken)
            done, calls = self.run_install(base, report_conf=broken, sums_text=reporter_sums(**{"vsys-report.conf": broken}))
            self.assertEqual(done.returncode, 1)
            self.assertTrue(
                done.stderr.splitlines()[0].startswith("scrub-reporter: parse=vsys-report.conf-bad-execstoppost value="),
                done.stderr,
            )
            self.assertFalse(any(call.startswith(("install ", "systemd-tmpfiles", "systemctl daemon-reload")) for call in calls))

    def test_a_failed_download_installs_nothing(self) -> None:
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp), fail_download="vsys-scrub.conf")
            self.assertEqual(done.returncode, 1)
            self.assertEqual(done.stderr.splitlines()[0], "scrub-reporter: download=vsys-scrub.conf failed")
            self.assertFalse(any(call.startswith(("install ", "systemd-tmpfiles", "systemctl daemon-reload")) for call in calls))

    def test_a_release_with_no_sha256sums_installs_nothing(self) -> None:
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp), fail_sums=True)
            self.assertEqual(done.returncode, 1)
            self.assertEqual(done.stderr.splitlines()[0], "scrub-reporter: download=SHA256SUMS failed release=vfixture")
            self.assertFalse(any(call.startswith(("install ", "systemd-tmpfiles", "systemctl daemon-reload")) for call in calls))

    def test_a_checksum_mismatch_installs_nothing(self) -> None:
        wrong = "".join(f"{'0' * 64}  {name}\n" for name in REPORTER_FILES)
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp), sums_text=wrong)
            self.assertEqual(done.returncode, 1)
            self.assertEqual(done.stderr.splitlines()[0], "scrub-reporter: checksum=vsys-scrub-report mismatch")
            self.assertFalse(any(call.startswith(("install ", "systemd-tmpfiles", "systemctl daemon-reload")) for call in calls))

    def test_sha256sums_missing_a_file_installs_nothing(self) -> None:
        digest = hashlib.sha256((REPORTER / "vsys-scrub-report").read_bytes()).hexdigest()
        partial = f"{digest}  vsys-scrub-report\n"
        with scratch() as tmp:
            done, calls = self.run_install(Path(tmp), sums_text=partial)
            self.assertEqual(done.returncode, 1)
            self.assertEqual(done.stderr.splitlines()[0], "scrub-reporter: checksum=vsys-report.conf unlisted")
            self.assertFalse(any(call.startswith(("install ", "systemd-tmpfiles", "systemctl daemon-reload")) for call in calls))

    def test_a_report_in_the_old_tmpfs_directory_is_migrated(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            legacy = base / "legacy"
            legacy.mkdir()
            (legacy / "root.result").write_text("btrfs scrub finished, no errors: /\n")
            persistent = base / "persistent"
            done, calls = self.run_install(base, legacy_dir=legacy, scrub_dir=persistent)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(
                (persistent / "root.result").read_text(),
                "btrfs scrub finished, no errors: /\n",
            )

    def test_migration_targets_the_downloaded_confs_own_report_directory_not_the_hardcoded_default(self) -> None:
        # An old tag's vsys-report.conf (VSYS_VERSION pinned to it, or the
        # unversioned install run in the window before a new release is cut)
        # still points ExecStopPost at a pre-VSY-75 report directory, never
        # at the new hardcoded default. Migration must follow that directory,
        # not the hardcoded one, so a carried-over report is never written
        # somewhere nothing else reads.
        with scratch() as tmp:
            base = Path(tmp)
            old_tag_dir = base / "old-tag-report-dir"
            conf = (REPORTER / "vsys-report.conf").read_text().replace("/var/lib/btrfs-scrub", str(old_tag_dir))
            self.assertIn(f"ExecStopPost=/usr/local/bin/vsys-scrub-report %f {old_tag_dir}", conf)
            legacy = base / "legacy"
            legacy.mkdir()
            (legacy / "root.result").write_text("the carried-over report\n")
            done, calls = self.run_install(
                base,
                legacy_dir=legacy,
                scrub_dir_unset=True,
                report_conf=conf,
                sums_text=reporter_sums(**{"vsys-report.conf": conf}),
            )
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual((old_tag_dir / "root.result").read_text(), "the carried-over report\n")
            self.assertFalse((Path("/var/lib/btrfs-scrub") / "root.result").exists())

    def test_migration_never_overwrites_a_report_already_in_the_persistent_directory(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            legacy = base / "legacy"
            legacy.mkdir()
            (legacy / "root.result").write_text("stale, from before this install\n")
            persistent = base / "persistent"
            persistent.mkdir()
            (persistent / "root.result").write_text("the report already there\n")
            done, calls = self.run_install(base, legacy_dir=legacy, scrub_dir=persistent)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(
                (persistent / "root.result").read_text(),
                "the report already there\n",
            )

    def test_no_legacy_directory_migrates_nothing(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            persistent = base / "persistent"
            done, calls = self.run_install(base, scrub_dir=persistent)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertFalse(persistent.exists())

    def test_a_stray_temp_file_left_by_an_interrupted_migration_is_cleaned_up(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            legacy = base / "legacy"
            legacy.mkdir()
            (legacy / "root.result").write_text("the real report\n")
            persistent = base / "persistent"
            persistent.mkdir()
            # No "orphan.result" exists in the legacy directory, so nothing
            # in the ordinary migration loop ever names or recreates this
            # stray; only the explicit cleanup sweep can remove it, which
            # makes this a real control for that sweep rather than for the
            # copy loop that migrates root.result regardless.
            (persistent / ".migrate.orphan.result.tmp").write_text("half-written garbage from a killed run\n")
            done, calls = self.run_install(base, legacy_dir=legacy, scrub_dir=persistent)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual((persistent / "root.result").read_text(), "the real report\n")
            self.assertEqual(sorted(os.listdir(persistent)), ["root.result"])

    def test_migration_never_touches_a_report_the_reporter_is_still_writing(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            legacy = base / "legacy"
            legacy.mkdir()
            (legacy / "root.result").write_text("the legacy report\n")
            persistent = base / "persistent"
            persistent.mkdir()
            # The reporter's own temp name (vsys-scrub-report writes
            # .<name>.tmp, never migration's .migrate.<name>.tmp), standing
            # in for a scrub of another mount still being written while this
            # install runs. The stray-cleanup sweep must never touch it.
            writing = persistent / ".home.result.tmp"
            writing.write_text("a report vsys-scrub-report is still writing\n")
            done, calls = self.run_install(base, legacy_dir=legacy, scrub_dir=persistent)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(writing.read_text(), "a report vsys-scrub-report is still writing\n")
            self.assertEqual((persistent / "root.result").read_text(), "the legacy report\n")

    def test_a_report_the_reporter_finishes_mid_migration_is_never_overwritten(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            legacy = base / "legacy"
            legacy.mkdir()
            (legacy / "root.result").write_text("stale, from before this install\n")
            persistent = base / "persistent"
            # While migration's cp is copying the legacy report into its own
            # temp name, the reporter finishes writing a fresh report for the
            # same mount directly into the destination: a real race, forced
            # open deterministically at the one point migration touches
            # disk for this report, rather than by timing.
            cp_stub = f"""if [[ $3 == *.migrate.root.result.tmp ]]; then
	mkdir -p -- "{persistent}"
	printf '%s\\n' "the fresh report, just finished" >"{persistent}/root.result"
fi
exec /usr/bin/cp "$@"
"""
            done, calls = self.run_install(base, legacy_dir=legacy, scrub_dir=persistent, cp_stub=cp_stub)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual((persistent / "root.result").read_text(), "the fresh report, just finished\n")
            self.assertEqual(os.listdir(persistent), ["root.result"])

    def test_an_mv_that_reports_failure_on_a_skipped_destination_still_installs(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            legacy = base / "legacy"
            legacy.mkdir()
            (legacy / "root.result").write_text("stale, from before this install\n")
            persistent = base / "persistent"
            # Same race as the test above (a fresh report lands while cp is
            # still copying the legacy one into its temp name), but mv -n
            # itself now also mimics unpatched coreutils 9.2-9.4, which can
            # report failure for a skip it still performs correctly. Without
            # a `|| true` on that bare statement, set -e would abort the
            # script on this exit code before the [[ -e $tmp ]] fallback runs.
            cp_stub = f"""if [[ $3 == *.migrate.root.result.tmp ]]; then
	mkdir -p -- "{persistent}"
	printf '%s\\n' "the fresh report, just finished" >"{persistent}/root.result"
fi
exec /usr/bin/cp "$@"
"""
            mv_stub = """dest=$4
if [[ -e $dest ]]; then
	exit 1
fi
exec /usr/bin/mv "$@"
"""
            done, calls = self.run_install(
                base, legacy_dir=legacy, scrub_dir=persistent, cp_stub=cp_stub, mv_stub=mv_stub
            )
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual((persistent / "root.result").read_text(), "the fresh report, just finished\n")
            self.assertEqual(os.listdir(persistent), ["root.result"])

    def test_a_migration_copy_failure_is_reported_as_a_carry_over_problem_not_an_install_failure(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            legacy = base / "legacy"
            legacy.mkdir()
            # A legacy entry that is a directory, not a report: cp refuses it.
            (legacy / "root.result").mkdir()
            persistent = base / "persistent"
            done, calls = self.run_install(base, legacy_dir=legacy, scrub_dir=persistent)
            self.assertEqual(done.returncode, 1)
            self.assertEqual(
                done.stderr.splitlines()[0],
                f"scrub-reporter: legacy-migrate=copy-failed report={legacy / 'root.result'}",
            )
            # The core install already completed before the carry-over failed.
            self.assertEqual(calls[-1], "systemctl daemon-reload")
            self.assertEqual(os.listdir(persistent), [])

    def test_a_migration_mkdir_failure_is_reported_as_a_carry_over_problem_not_an_install_failure(self) -> None:
        with scratch() as tmp:
            base = Path(tmp)
            legacy = base / "legacy"
            legacy.mkdir()
            (legacy / "root.result").write_text("x\n")
            readonly_parent = base / "readonly"
            readonly_parent.mkdir(mode=0o555)
            persistent = readonly_parent / "persistent"
            try:
                done, calls = self.run_install(base, legacy_dir=legacy, scrub_dir=persistent)
                self.assertEqual(done.returncode, 1)
                self.assertEqual(
                    done.stderr.splitlines()[0],
                    f"scrub-reporter: legacy-migrate=mkdir-failed dir={persistent}",
                )
                self.assertEqual(calls[-1], "systemctl daemon-reload")
            finally:
                readonly_parent.chmod(0o755)


class ShippedFilesTest(unittest.TestCase):
    def test_the_drop_in_and_the_tmpfiles_line_name_one_directory(self) -> None:
        # The reporter takes its directory from the drop-in, and the tmpfiles
        # line creates it; vsys reads its default scrubDir from the same path.
        drop_in = (REPORTER / "vsys-report.conf").read_text()
        tmpfiles = (REPORTER / "vsys-scrub.conf").read_text()
        exec_line = next(line for line in drop_in.splitlines() if line.startswith("ExecStopPost="))
        self.assertEqual(exec_line, "ExecStopPost=/usr/local/bin/vsys-scrub-report %f /var/lib/btrfs-scrub")
        rule = next(line for line in tmpfiles.splitlines() if line and not line.startswith("#"))
        self.assertEqual(rule.split()[:2], ["d", "/var/lib/btrfs-scrub"])
        config = (ROOT / "src" / "config" / "config.ts").read_text()
        self.assertIn('scrubDir: "/var/lib/btrfs-scrub",', config)


if __name__ == "__main__":
    unittest.main()
