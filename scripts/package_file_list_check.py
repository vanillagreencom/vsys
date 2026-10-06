#!/usr/bin/env python3
"""Check the vsys package runtime payload and package recipes."""

from __future__ import annotations

import argparse
import fnmatch
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

from refusal import Refusal, refuse, report


# The members a shipped consumer cannot work without, at the mode it needs:
# install.sh refuses an archive that lacks any of them, `vsys warden install`
# runs warden/install, which installs the units and agent-tools.json, the
# service unit starts agent-warden, and the documented pane launcher setup
# links agent-confine, which runs agent-confine-lineage-capped beside it.
# The scrub reporter is one owned set: its drop-in runs the report script
# after every btrfs scrub, and its tmpfiles line creates the report directory
# whose absence Storage reads as no reporter. The drive reporter is another:
# its timer runs its service, which runs its script, into the directory its
# tmpfiles line creates. The manifest may ship more.
SCRUB_REPORTER = "lib/vsys/scripts/scrub-reporter/vsys-scrub-report"
SCRUB_DROP_IN = "lib/systemd/system/btrfs-scrub@.service.d/vsys-report.conf"
# The one command the packaged drop-in may run: the packaged reporter, given
# the scrubbed mount (%f) and the report directory vsys's scrubDir names.
SCRUB_COMMAND = f"/usr/{SCRUB_REPORTER} %f /var/lib/btrfs-scrub"
SMART_REPORTER = "lib/vsys/scripts/smart-reporter/vsys-smart-report"
SMART_SERVICE = "lib/systemd/system/vsys-smart-report.service"
REQUIRED_MODES = {
    "lib/vsys/warden/install": 0o755,
    "lib/vsys/warden/agent-warden": 0o755,
    "lib/vsys/warden/agent-confine": 0o755,
    "lib/vsys/warden/agent-confine-lineage-capped": 0o755,
    "lib/vsys/warden/systemd/agent-warden.service": 0o644,
    "lib/vsys/warden/systemd/agent-warden.timer": 0o644,
    "lib/vsys/warden/systemd/agents.slice": 0o644,
    "lib/vsys/data/agent-tools.json": 0o644,
    SCRUB_REPORTER: 0o755,
    SCRUB_DROP_IN: 0o644,
    "lib/tmpfiles.d/vsys-scrub.conf": 0o644,
    SMART_REPORTER: 0o755,
    SMART_SERVICE: 0o644,
    "lib/systemd/system/vsys-smart-report.timer": 0o644,
    "lib/tmpfiles.d/vsys-smart.conf": 0o644,
}
# Every row ships its source at PAYLOAD_PREFIX + source path. warden/install
# finds ../data/agent-tools.json and systemd/ beside itself, so the installed
# tree must mirror the repository tree, and a row naming another script ships
# the wrong file under a required name. A row named `vsys` would overwrite the
# binary in the release stage. Both packages ship every row under /usr: vsys-git
# stages it there and the vsys PKGBUILD copies the release archive's lib.
# install.sh copies only lib/vsys, because it installs nothing as root, so the
# only rows outside it are the system files under SYSTEM_PREFIXES, where
# systemd reads a package's own units and tmpfiles lines.
PAYLOAD_PREFIX = "lib/vsys/"
SYSTEM_PREFIXES = ("lib/systemd/system/", "lib/tmpfiles.d/")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        refuse(f"read=failed path={path}", str(error))


def parse_manifest(repo: Path) -> dict[str, tuple[int, str]]:
    manifest = repo / "packaging" / "vsys-runtime-files.txt"
    rows: dict[str, tuple[int, str]] = {}
    for number, raw in enumerate(read_text(manifest).splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 3:
            refuse(f"manifest=malformed line={number}", "A manifest row needs a mode, an archive path and a source path.")
        mode_text, archive_path, source_path = parts
        if archive_path.startswith("/") or ".." in Path(archive_path).parts:
            refuse(f"manifest=unsafe-archive-path path={archive_path}")
        if source_path.startswith("/") or ".." in Path(source_path).parts:
            refuse(f"manifest=unsafe-source-path path={source_path}")
        try:
            mode = int(mode_text, 8)
        except ValueError:
            refuse(f"manifest=bad-mode-text line={number} mode={mode_text}")
        if not archive_path.startswith(SYSTEM_PREFIXES) and archive_path != PAYLOAD_PREFIX + source_path:
            refuse(f"manifest=path-source-mismatch path={archive_path} source={source_path}")
        rows[archive_path] = (mode, source_path)
    for archive_path, mode in REQUIRED_MODES.items():
        if archive_path not in rows:
            refuse(f"manifest=missing-required path={archive_path}")
        actual = rows[archive_path][0]
        if actual != mode:
            refuse(f"manifest=bad-mode path={archive_path} actual={actual:o} expected={mode:o}")
    for _mode, source_path in rows.values():
        if not (repo / source_path).is_file():
            refuse(f"manifest=source-missing path={source_path}")
    return rows


def check_scrub_drop_in(repo: Path, rows: dict[str, tuple[int, str]]) -> None:
    """The packaged drop-in must run the reporter the package ships, at the
    path pacman installs it to and with the mount and report directory it
    needs, or every scrub ends with no report. Any other packaged file, or the
    reporter without its arguments, passes a path check and reports nothing."""
    text = read_text(repo / rows[SCRUB_DROP_IN][1])
    commands = [line.strip() for line in re.findall(r"^ExecStopPost=(.*)$", text, flags=re.MULTILINE)]
    if commands != [SCRUB_COMMAND]:
        refuse(f"drop-in=wrong-command path={SCRUB_DROP_IN} value={'|'.join(commands)}")


def check_smart_service(repo: Path, rows: dict[str, tuple[int, str]]) -> None:
    """The packaged service is the installer's service with one line changed:
    it runs the reporter the package ships, at the path pacman installs it to.
    Any other difference, such as a timeout or a sandbox line edited in one
    copy only, would make a packaged reporter run unlike an installed one."""
    installed = read_text(repo / "scripts" / "smart-reporter" / "vsys-smart-report.service")
    expected = re.sub(
        r"^ExecStart=.*$",
        lambda _match: f"ExecStart=/usr/{SMART_REPORTER} /run/smartctl",
        installed,
        flags=re.MULTILINE,
    )
    if read_text(repo / rows[SMART_SERVICE][1]) != expected:
        refuse(f"smart-service=differs path={SMART_SERVICE}")


def read_bytes(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        refuse(f"read=failed path={path}", str(error))


def check_tree(
    root: Path,
    label: str,
    rows: dict[str, tuple[int, str]],
    repo: Path | None = None,
) -> None:
    for archive_path, (mode, source_path) in rows.items():
        path = root / archive_path
        try:
            info = path.lstat()
        except FileNotFoundError:
            refuse(f"{label}=missing path={archive_path}")
        if stat.S_ISLNK(info.st_mode):
            refuse(f"{label}=symlink path={archive_path}")
        if not stat.S_ISREG(info.st_mode):
            refuse(f"{label}=not-file path={archive_path}")
        actual = stat.S_IMODE(info.st_mode)
        if actual != mode:
            refuse(f"{label}=bad-mode path={archive_path} actual={actual:o} expected={mode:o}")
        if repo is not None and read_bytes(path) != read_bytes(repo / source_path):
            refuse(f"{label}=content-mismatch path={archive_path} source={source_path}")


def check_stage_script(repo: Path, rows: dict[str, tuple[int, str]]) -> None:
    scratch = repo / "tmp" / "package-file-list-check"
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.mkdir(parents=True)
    subprocess.run([str(repo / "packaging" / "stage-runtime-files.sh"), str(scratch)], cwd=repo, check=True)
    check_tree(scratch, "staged", rows, repo)
    shipped = {
        str(path.relative_to(scratch))
        for path in scratch.rglob("*")
        if path.is_file() and not path.is_symlink()
    }
    if shipped != set(rows):
        refuse(f"staged=extra-files paths={sorted(shipped - set(rows))}")
    shutil.rmtree(scratch)


def check_release_workflow(repo: Path) -> None:
    text = read_text(repo / ".github" / "workflows" / "release.yml")
    if "packaging/stage-runtime-files.sh stage" not in text:
        refuse("release-workflow=no-stage", "The release workflow does not stage runtime files.")
    if not re.search(r"tar -czf .*\bvsys LICENSE README\.md lib\b", text):
        refuse("release-workflow=archive-without-lib", "The release workflow archive does not include lib.")


def check_aur_git_workflow(repo: Path, rows: dict[str, tuple[int, str]]) -> None:
    # vsys-git ships every manifest source, so a change to any one of them, or
    # to the staging route itself, must publish a new pkgver.
    text = read_text(repo / ".github" / "workflows" / "aur-git.yml")
    filters = re.findall(r'^\s+- "([^"]+)"$', text, flags=re.MULTILINE)
    staged = {source for _mode, source in rows.values()}
    for required in sorted(staged | {"packaging/stage-runtime-files.sh", "packaging/vsys-runtime-files.txt"}):
        if not any(fnmatch.fnmatchcase(required, pattern) for pattern in filters):
            refuse(f"aur-git-workflow=path-missing value={required}")


def check_ci_workflow(repo: Path) -> None:
    text = read_text(repo / ".github" / "workflows" / "ci.yml")
    if "#commit={commit}" not in text:
        refuse("ci-workflow=unpinned-git-source", "The arch-package workflow does not pin the local git source to HEAD.")
    start = text.find("name: Build the local vsys-git package")
    end = text.find("name: Install the package and check the warden path", start)
    if start == -1 or end == -1:
        refuse("ci-workflow=build-step-missing", "The arch-package workflow build step was not found.")
    build_step = text[start:end]
    if "${{" in build_step:
        refuse("ci-workflow=build-step-expression", "The arch-package workflow build step contains a GitHub expression.")


def check_pkgbuild(repo: Path, name: str, *, release: bool) -> None:
    text = read_text(repo / "packaging" / name / "PKGBUILD")
    for dependency in ("'python'", "'systemd'", "'systemd-libs'"):
        if dependency not in text:
            refuse(f"pkgbuild=dependency-missing package={name} value={dependency}")
    forbidden = ("/usr/lib/systemd/user", "systemctl", "preset")
    for value in forbidden:
        if value in text:
            refuse(f"pkgbuild=user-units package={name} value={value}", f"{name} enables or installs user units.")
    if re.search(r"^install=", text, flags=re.MULTILINE):
        refuse(f"pkgbuild=install-hook package={name}", f"{name} declares an install hook.")
    if "'!strip'" not in text:
        refuse(f"pkgbuild=strip-enabled package={name}", f"{name} does not disable binary stripping.")
    if "'!debug'" not in text:
        refuse(f"pkgbuild=debug-enabled package={name}", f"{name} does not disable debug package splitting.")
    if re.search(r"\bcp\s+-a\b", text) or "--preserve=ownership" in text:
        refuse(f"pkgbuild=ownership-preserved package={name}", f"{name} preserves archive ownership while copying payload files.")
    if release:
        if 'cp -R --no-preserve=ownership "${srcdir}/lib" "${pkgdir}/usr/"' not in text:
            refuse("pkgbuild=release-copy-missing package=vsys", "The vsys PKGBUILD does not copy the release lib tree without ownership.")
    elif 'packaging/stage-runtime-files.sh "${pkgdir}/usr"' not in text:
        refuse("pkgbuild=no-stage-script package=vsys-git", "The vsys-git PKGBUILD does not use the runtime staging script.")


def check_install_sh(repo: Path) -> None:
    text = read_text(repo / "install.sh")
    # Run as root, tar keeps the archive's owner uid, so a preserving copy
    # leaves the installed warden scripts owned by whichever local account has
    # the release builder's uid, and that account can rewrite them.
    if re.search(r"\bcp\s+-[A-Za-z]*p[A-Za-z]*\b", text) or "--preserve=ownership" in text:
        refuse("install-sh=ownership-preserved", "install.sh preserves archive ownership while copying payload files.")


def check_installed_root(root: Path, rows: dict[str, tuple[int, str]]) -> None:
    check_tree(root / "usr", "installed", rows)
    manifest_paths = {path.removeprefix(PAYLOAD_PREFIX) for path in rows if path.startswith(PAYLOAD_PREFIX)}
    installed_paths = {
        str(path.relative_to(root / "usr" / "lib" / "vsys"))
        for path in (root / "usr" / "lib" / "vsys").rglob("*")
        if path.is_file() and not path.is_symlink()
    }
    if installed_paths != manifest_paths:
        refuse(
            "installed=tree-mismatch "
            f"missing={sorted(manifest_paths - installed_paths)} "
            f"extra={sorted(installed_paths - manifest_paths)}"
        )


def run(repo: Path, installed_root: Path | None) -> None:
    rows = parse_manifest(repo)
    check_scrub_drop_in(repo, rows)
    check_smart_service(repo, rows)
    check_stage_script(repo, rows)
    check_release_workflow(repo)
    check_aur_git_workflow(repo, rows)
    check_ci_workflow(repo)
    check_pkgbuild(repo, "vsys", release=True)
    check_pkgbuild(repo, "vsys-git", release=False)
    check_install_sh(repo)
    if installed_root is not None:
        check_installed_root(installed_root, rows)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".", help="repository root to check")
    parser.add_argument("--installed-root", help="root filesystem containing /usr/lib/vsys")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    repo = Path(args.repo).resolve()
    installed_root = Path(args.installed_root).resolve() if args.installed_root else None
    try:
        run(repo, installed_root)
    except Refusal as error:
        report(error, "Package file-list check failed")
        return 1
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"::error::Package file-list check failed: {error}", file=sys.stderr)
        return 1
    print("Package file-list check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
