"""Exercise package file-list check failure controls."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts" / "package_file_list_check.py"
INSTALL = ROOT / "install.sh"


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

    def test_ownership_preserving_release_copy_fails(self) -> None:
        pkgbuild = self.repo / "packaging" / "vsys" / "PKGBUILD"
        pkgbuild.write_text(pkgbuild.read_text().replace(
            'cp -R --no-preserve=ownership "${srcdir}/lib/vsys" "${pkgdir}/usr/lib/"',
            'cp -a "${srcdir}/lib/vsys" "${pkgdir}/usr/lib/"',
        ))
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("preserves archive ownership", result.stderr)


class InstallScript(unittest.TestCase):
    def setUp(self) -> None:
        scratch_root = ROOT / "tmp" / "install-sh-tests"
        scratch_root.mkdir(parents=True, exist_ok=True)
        self.scratch = tempfile.TemporaryDirectory(dir=scratch_root)
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.version = "vfixture"
        self.asset = "vsys-vfixture-linux-x86_64.tar.gz"
        self.bin_dir = self.root / "home" / ".local" / "bin"
        self.cache = self.root / "cache"

    def make_archive(self, shape: str) -> None:
        stage = self.root / f"stage-{shape}"
        stage.mkdir()
        vsys = stage / "vsys"
        vsys.write_text(f"{shape} binary\n")
        vsys.chmod(0o755)
        if shape == "full":
            for relative in (
                "warden/install",
                "warden/agent-warden",
                "warden/agent-confine",
                "warden/agent-confine-lineage-capped",
                "warden/systemd/agent-warden.service",
                "warden/systemd/agent-warden.timer",
                "warden/systemd/agents.slice",
                "data/agent-tools.json",
            ):
                source = ROOT / relative
                target = stage / "lib" / "vsys" / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        elif shape == "partial":
            target = stage / "lib" / "vsys" / "warden" / "install"
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / "warden" / "install", target)
        elif shape != "legacy":
            raise AssertionError(f"unknown archive shape: {shape}")
        archive = self.root / self.asset
        with tarfile.open(archive, "w:gz") as tar:
            for path in sorted(stage.rglob("*")):
                tar.add(path, arcname=str(path.relative_to(stage)))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (self.root / "SHA256SUMS").write_text(f"{digest}  {self.asset}\n")

    def write_curl_stub(self) -> Path:
        commands = self.root / "commands"
        commands.mkdir()
        curl = commands / "curl"
        curl.write_text(
            "#!/bin/sh\n"
            "url=\n"
            "out=\n"
            "while [ \"$#\" -gt 0 ]; do\n"
            "  case \"$1\" in\n"
            "    -o) shift; out=$1 ;;\n"
            "    http*) url=$1 ;;\n"
            "  esac\n"
            "  shift\n"
            "done\n"
            "[ -n \"$out\" ] || exit 2\n"
            f"case \"$url\" in\n"
            f"  *SHA256SUMS) cp {self.root / 'SHA256SUMS'} \"$out\" ;;\n"
            f"  *{self.asset}) cp {self.root / self.asset} \"$out\" ;;\n"
            "  *) exit 3 ;;\n"
            "esac\n"
        )
        curl.chmod(0o755)
        return commands

    def run_install(self) -> subprocess.CompletedProcess[str]:
        commands = self.write_curl_stub()
        env = {
            **os.environ,
            "HOME": str(self.root / "home"),
            "PATH": str(commands) + os.pathsep + os.environ["PATH"],
            "VSYS_INSTALL_DIR": str(self.bin_dir),
            "VSYS_VERSION": self.version,
            "XDG_CACHE_HOME": str(self.cache),
        }
        return subprocess.run(["bash", str(INSTALL)], env=env, capture_output=True, text=True)

    def test_symlinked_lib_refusal_leaves_existing_binary(self) -> None:
        self.make_archive("full")
        self.bin_dir.mkdir(parents=True)
        binary = self.bin_dir / "vsys"
        binary.write_text("old binary\n")
        binary.chmod(0o755)
        lib = self.root / "home" / ".local" / "lib"
        lib.mkdir()
        target = self.root / "elsewhere"
        target.mkdir()
        (lib / "vsys").symlink_to(target)
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refusing to replace symlink", result.stderr)
        self.assertEqual(binary.read_text(), "old binary\n")
        self.assertTrue((lib / "vsys").is_symlink())

    def test_legacy_archive_installs_binary_without_warden(self) -> None:
        self.make_archive("legacy")
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.bin_dir / "vsys").read_text(), "legacy binary\n")
        self.assertIn("This release does not include the optional warden.", result.stdout)
        self.assertFalse((self.root / "home" / ".local" / "lib" / "vsys").exists())

    def test_partial_lib_tree_refuses_before_replacing_binary(self) -> None:
        self.make_archive("partial")
        self.bin_dir.mkdir(parents=True)
        binary = self.bin_dir / "vsys"
        binary.write_text("old binary\n")
        binary.chmod(0o755)
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("the archive holds no lib/vsys/warden/agent-warden", result.stderr)
        self.assertEqual(binary.read_text(), "old binary\n")


if __name__ == "__main__":
    unittest.main()
