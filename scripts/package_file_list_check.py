#!/usr/bin/env python3
"""Check the vsys package runtime payload and package recipes."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys


REQUIRED_FILES = {
    "lib/vsys/warden/install": 0o755,
    "lib/vsys/warden/agent-warden": 0o755,
    "lib/vsys/warden/agent-confine": 0o755,
    "lib/vsys/warden/agent-confine-lineage-capped": 0o755,
    "lib/vsys/warden/systemd/agent-warden.service": 0o644,
    "lib/vsys/warden/systemd/agent-warden.timer": 0o644,
    "lib/vsys/warden/systemd/agents.slice": 0o644,
    "lib/vsys/data/agent-tools.json": 0o644,
}


class CheckFailure(Exception):
    pass


def fail(message: str) -> None:
    raise CheckFailure(message)


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        fail(f"read failed path={path}: {error}")


def parse_manifest(repo: Path) -> dict[str, tuple[int, str]]:
    manifest = repo / "packaging" / "vsys-runtime-files.txt"
    rows: dict[str, tuple[int, str]] = {}
    for number, raw in enumerate(read_text(manifest).splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 3:
            fail(f"manifest malformed line={number}")
        mode_text, archive_path, source_path = parts
        if archive_path.startswith("/") or ".." in Path(archive_path).parts:
            fail(f"manifest unsafe archive path={archive_path}")
        if source_path.startswith("/") or ".." in Path(source_path).parts:
            fail(f"manifest unsafe source path={source_path}")
        try:
            mode = int(mode_text, 8)
        except ValueError:
            fail(f"manifest bad mode line={number} mode={mode_text}")
        rows[archive_path] = (mode, source_path)
    expected = {path: (mode, "") for path, mode in REQUIRED_FILES.items()}
    actual = {path: (mode, "") for path, (mode, _source) in rows.items()}
    if actual != expected:
        fail(f"manifest payload mismatch actual={sorted(actual.items())}")
    for archive_path, (_mode, source_path) in rows.items():
        source = repo / source_path
        if not source.is_file():
            fail(f"manifest source missing path={source_path}")
        if source.name.endswith("_test.py"):
            fail(f"manifest ships test path={source_path}")
        if archive_path.endswith("_test.py"):
            fail(f"manifest ships test path={archive_path}")
    return rows


def check_tree(root: Path, label: str, rows: dict[str, tuple[int, str]]) -> None:
    for archive_path, (mode, _source_path) in rows.items():
        path = root / archive_path
        try:
            info = path.lstat()
        except FileNotFoundError:
            fail(f"{label} missing path={archive_path}")
        if stat.S_ISLNK(info.st_mode):
            fail(f"{label} symlink path={archive_path}")
        if not stat.S_ISREG(info.st_mode):
            fail(f"{label} not-file path={archive_path}")
        actual = stat.S_IMODE(info.st_mode)
        if actual != mode:
            fail(f"{label} bad-mode path={archive_path} actual={actual:o} expected={mode:o}")


def check_stage_script(repo: Path, rows: dict[str, tuple[int, str]]) -> None:
    scratch = repo / "tmp" / "package-file-list-check"
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.mkdir(parents=True)
    subprocess.run([str(repo / "packaging" / "stage-runtime-files.sh"), str(scratch)], cwd=repo, check=True)
    check_tree(scratch, "staged", rows)
    shipped = {
        str(path.relative_to(scratch))
        for path in scratch.rglob("*")
        if path.is_file() and not path.is_symlink()
    }
    if shipped != set(rows):
        fail(f"staged extra files paths={sorted(shipped - set(rows))}")
    shutil.rmtree(scratch)


def check_release_workflow(repo: Path) -> None:
    text = read_text(repo / ".github" / "workflows" / "release.yml")
    if "packaging/stage-runtime-files.sh stage" not in text:
        fail("release workflow does not stage runtime files")
    if not re.search(r"tar -czf .*\bvsys LICENSE README\.md lib\b", text):
        fail("release workflow archive does not include lib")


def check_aur_git_workflow(repo: Path) -> None:
    text = read_text(repo / ".github" / "workflows" / "aur-git.yml")
    for required in ('"warden/**"', '"packaging/stage-runtime-files.sh"', '"packaging/vsys-runtime-files.txt"'):
        if required not in text:
            fail(f"aur-git workflow path missing value={required}")


def check_ci_workflow(repo: Path) -> None:
    text = read_text(repo / ".github" / "workflows" / "ci.yml")
    if "#commit={commit}" not in text:
        fail("arch-package workflow does not pin the local git source to HEAD")


def check_pkgbuild(repo: Path, name: str, *, release: bool) -> None:
    text = read_text(repo / "packaging" / name / "PKGBUILD")
    for dependency in ("'python'", "'systemd-libs'"):
        if dependency not in text:
            fail(f"{name} dependency missing value={dependency}")
    forbidden = ("/usr/lib/systemd/user", "systemctl", "preset")
    for value in forbidden:
        if value in text:
            fail(f"{name} enables or installs user units value={value}")
    if re.search(r"^install=", text, flags=re.MULTILINE):
        fail(f"{name} declares an install hook")
    if re.search(r"\bcp\s+-a\b", text) or "--preserve=ownership" in text:
        fail(f"{name} preserves archive ownership while copying payload files")
    if release:
        if 'cp -R --no-preserve=ownership "${srcdir}/lib/vsys" "${pkgdir}/usr/lib/"' not in text:
            fail("vsys PKGBUILD does not copy the release lib/vsys tree without ownership")
    elif 'packaging/stage-runtime-files.sh "${pkgdir}/usr"' not in text:
        fail("vsys-git PKGBUILD does not use the runtime staging script")


def check_install_sh(repo: Path) -> None:
    text = read_text(repo / "install.sh")
    required = (
        "lib/vsys/warden/install",
        "lib/vsys/data/agent-tools.json",
        "vsys warden install",
        "command -v python3",
        "refusing to replace symlink",
    )
    for value in required:
        if value not in text:
            fail(f"install.sh missing package contract value={value}")
    if "/tmp" in text or "/var/tmp" in text:
        fail("install.sh writes scratch outside the user prefix or cache")


def check_installed_root(root: Path, rows: dict[str, tuple[int, str]]) -> None:
    installed = {f"lib/vsys/{path}": mode for path, mode in {
        "warden/install": 0o755,
        "warden/agent-warden": 0o755,
        "warden/agent-confine": 0o755,
        "warden/agent-confine-lineage-capped": 0o755,
        "warden/systemd/agent-warden.service": 0o644,
        "warden/systemd/agent-warden.timer": 0o644,
        "warden/systemd/agents.slice": 0o644,
        "data/agent-tools.json": 0o644,
    }.items()}
    check_tree(root / "usr", "installed", {path: (mode, "") for path, mode in installed.items()})
    manifest_paths = {path.removeprefix("lib/vsys/") for path in rows}
    installed_paths = {
        str(path.relative_to(root / "usr" / "lib" / "vsys"))
        for path in (root / "usr" / "lib" / "vsys").rglob("*")
        if path.is_file() and not path.is_symlink()
    }
    if installed_paths != manifest_paths:
        fail(
            "installed tree mismatch "
            f"missing={sorted(manifest_paths - installed_paths)} "
            f"extra={sorted(installed_paths - manifest_paths)}"
        )


def run(repo: Path, installed_root: Path | None) -> None:
    rows = parse_manifest(repo)
    check_stage_script(repo, rows)
    check_release_workflow(repo)
    check_aur_git_workflow(repo)
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
    except (CheckFailure, OSError, subprocess.CalledProcessError) as error:
        print(f"::error::Package file-list check failed: {error}", file=sys.stderr)
        return 1
    print("Package file-list check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
