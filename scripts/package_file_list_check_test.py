"""Exercise package file-list check failure controls."""

from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts" / "package_file_list_check.py"


class PackageFileListCheck(unittest.TestCase):
    def setUp(self) -> None:
        scratch_root = ROOT / "tmp" / "package-file-list-tests"
        scratch_root.mkdir(parents=True, exist_ok=True)
        self.scratch = tempfile.TemporaryDirectory(dir=scratch_root)
        self.addCleanup(self.scratch.cleanup)
        self.repo = Path(self.scratch.name) / "repo"
        for path in (
            ".github/workflows/release.yml",
            ".github/workflows/aur-git.yml",
            "packaging/vsys-runtime-files.txt",
            "packaging/stage-runtime-files.sh",
            "packaging/vsys/PKGBUILD",
            "packaging/vsys-git/PKGBUILD",
            "install.sh",
            "warden/install",
            "warden/agent-warden",
            "warden/agent-confine",
            "warden/agent-confine-lineage-capped",
            "warden/systemd/agent-warden.service",
            "warden/systemd/agent-warden.timer",
            "warden/systemd/agents.slice",
            "data/agent-tools.json",
        ):
            source = ROOT / path
            target = self.repo / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

    def run_check(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(CHECK), "--repo", str(self.repo)],
            capture_output=True,
            text=True,
        )

    def test_current_package_contract_passes(self) -> None:
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_warden_file_fails(self) -> None:
        (self.repo / "packaging" / "vsys-runtime-files.txt").write_text(
            (self.repo / "packaging" / "vsys-runtime-files.txt")
            .read_text()
            .replace("755 lib/vsys/warden/install warden/install\n", "")
        )
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("manifest payload mismatch", result.stderr)

    def test_user_unit_install_path_fails(self) -> None:
        pkgbuild = self.repo / "packaging" / "vsys" / "PKGBUILD"
        pkgbuild.write_text(pkgbuild.read_text() + "\ninstall -Dm644 x \"$pkgdir/usr/lib/systemd/user/x\"\n")
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("systemd/user", result.stderr)


if __name__ == "__main__":
    unittest.main()
