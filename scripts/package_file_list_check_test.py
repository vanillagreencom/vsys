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
MANIFEST = "packaging/vsys-runtime-files.txt"

sys.path.insert(0, str(CHECK.parent))

from package_file_list_check import PAYLOAD_PREFIX, SCRUB_DROP_IN, SMART_SERVICE, parse_manifest  # noqa: E402

PAYLOAD = parse_manifest(ROOT)
# The scrub and drive reporters' rows outside the warden payload.
REPORTER_ROWS = (
    "lib/vsys/scripts/scrub-reporter/vsys-scrub-report",
    SCRUB_DROP_IN,
    "lib/tmpfiles.d/vsys-scrub.conf",
    "lib/vsys/scripts/smart-reporter/vsys-smart-report",
    SMART_SERVICE,
    "lib/systemd/system/vsys-smart-report.timer",
    "lib/tmpfiles.d/vsys-smart.conf",
)


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
            ".github/workflows/ci.yml",
            MANIFEST,
            "packaging/stage-runtime-files.sh",
            "packaging/vsys/PKGBUILD",
            "packaging/vsys-git/PKGBUILD",
            "install.sh",
            "scripts/smart-reporter/vsys-smart-report.service",
            *(source for _mode, source in PAYLOAD.values()),
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

    def refusal(self, result: subprocess.CompletedProcess[str], prose: bool = True) -> str:
        """The refusal's key=value line, which the check prints first. The
        error annotation after it carries the refusal's prose, or for a
        refusal with none, the key line itself."""
        self.assertNotEqual(result.returncode, 0)
        lines = result.stderr.splitlines()
        self.assertGreaterEqual(len(lines), 2, result.stderr)
        line, annotation = lines[0], lines[1]
        self.assertTrue(annotation.startswith("::error::"), annotation)
        message = annotation.partition(": ")[2]
        if prose:
            self.assertNotIn(message, ("", line))
        else:
            self.assertEqual(message, line)
        return line

    def test_current_package_contract_passes(self) -> None:
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_manifest_defects_fail(self) -> None:
        manifest = self.repo / MANIFEST
        original = manifest.read_text()
        row = "755 lib/vsys/warden/install warden/install\n"
        self.assertIn(row, original)
        # The manifest refusals carry no prose; a failed read carries the
        # read error's.
        for name, text, expected, prose in (
            ("required row missing", original.replace(row, ""), "manifest=missing-required path=lib/vsys/warden/install", False),
            (
                "required row wrong mode",
                original.replace(row, "644" + row[3:]),
                "manifest=bad-mode path=lib/vsys/warden/install actual=644 expected=755",
                False,
            ),
            (
                "row outside lib/vsys",
                original + "644 lib/systemd/user/x.service warden/systemd/agents.slice\n",
                "manifest=path-source-mismatch path=lib/systemd/user/x.service source=warden/systemd/agents.slice",
                False,
            ),
            (
                "required path from another warden script",
                original.replace(row, "755 lib/vsys/warden/install warden/agent-warden\n"),
                "manifest=path-source-mismatch path=lib/vsys/warden/install source=warden/agent-warden",
                False,
            ),
            # ci.py runs the check with no packaging/ guard of its own, so a
            # renamed packaging/ fails here.
            ("manifest missing", None, f"read=failed path={self.repo.resolve() / MANIFEST}", True),
        ):
            with self.subTest(name):
                if text is None:
                    manifest.unlink()
                else:
                    manifest.write_text(text)
                self.assertEqual(self.refusal(self.run_check(), prose), expected)

    def test_reporter_rows_are_required(self) -> None:
        manifest = self.repo / MANIFEST
        original = manifest.read_text()
        for path in REPORTER_ROWS:
            with self.subTest(path):
                rows = [line for line in original.splitlines(keepends=True) if f" {path} " in line]
                self.assertEqual(len(rows), 1)
                manifest.write_text(original.replace(rows[0], ""))
                self.assertEqual(self.refusal(self.run_check(), prose=False), f"manifest=missing-required path={path}")

    def test_scrub_drop_in_must_run_the_packaged_reporter_with_its_arguments(self) -> None:
        drop_in = self.repo / PAYLOAD[SCRUB_DROP_IN][1]
        original = drop_in.read_text()
        command = "/usr/lib/vsys/scripts/scrub-reporter/vsys-scrub-report %f /var/lib/btrfs-scrub"
        self.assertEqual(original.count(command), 1)
        for name, wrong in (
            ("unpackaged script", "/usr/local/bin/vsys-scrub-report %f /var/lib/btrfs-scrub"),
            ("another packaged executable", "/usr/lib/vsys/warden/agent-warden %f /var/lib/btrfs-scrub"),
            ("a payload file that is not executable", "/usr/lib/vsys/data/agent-tools.json %f /var/lib/btrfs-scrub"),
            ("the reporter without arguments", "/usr/lib/vsys/scripts/scrub-reporter/vsys-scrub-report"),
            ("the reporter without its report directory", "/usr/lib/vsys/scripts/scrub-reporter/vsys-scrub-report %f"),
            # systemd reads an empty assignment as a reset of every earlier one.
            ("a later reset", command + "\nExecStopPost="),
        ):
            with self.subTest(name):
                drop_in.write_text(original.replace(command, wrong))
                self.assertEqual(
                    self.refusal(self.run_check(), prose=False).split()[0:2],
                    ["drop-in=wrong-command", f"path={SCRUB_DROP_IN}"],
                )

    def test_smart_service_is_the_installer_service_running_the_packaged_reporter(self) -> None:
        service = self.repo / PAYLOAD[SMART_SERVICE][1]
        original = service.read_text()
        command = "ExecStart=/usr/lib/vsys/scripts/smart-reporter/vsys-smart-report /run/smartctl\n"
        self.assertEqual(original.count(command), 1)
        for name, old, new in (
            ("unpackaged script", command, "ExecStart=/usr/local/bin/vsys-smart-report /run/smartctl\n"),
            ("the reporter without its report directory", command, command.replace(" /run/smartctl", "")),
            ("a timeout edited in one copy", "TimeoutStartSec=900\n", "TimeoutStartSec=90\n"),
            ("a sandbox line dropped from one copy", "ProtectSystem=full\n", ""),
        ):
            with self.subTest(name):
                self.assertEqual(original.count(old), 1)
                service.write_text(original.replace(old, new))
                self.assertEqual(
                    self.refusal(self.run_check(), prose=False),
                    f"smart-service=differs path={SMART_SERVICE}",
                )

    def test_manifest_source_the_aur_workflow_does_not_watch_fails(self) -> None:
        (self.repo / "packaging" / "extra.json").write_text("{}\n")
        manifest = self.repo / MANIFEST
        manifest.write_text(manifest.read_text() + "644 lib/tmpfiles.d/extra.json packaging/extra.json\n")
        self.assertEqual(
            self.refusal(self.run_check(), prose=False),
            "aur-git-workflow=path-missing value=packaging/extra.json",
        )

    def test_extra_manifest_row_passes(self) -> None:
        (self.repo / "data" / "extra.json").write_text("{}\n")
        manifest = self.repo / MANIFEST
        manifest.write_text(manifest.read_text() + "644 lib/vsys/data/extra.json data/extra.json\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_user_unit_install_path_fails(self) -> None:
        pkgbuild = self.repo / "packaging" / "vsys" / "PKGBUILD"
        pkgbuild.write_text(pkgbuild.read_text() + "\ninstall -Dm644 x \"$pkgdir/usr/lib/systemd/user/x\"\n")
        self.assertEqual(self.refusal(self.run_check()), "pkgbuild=user-units package=vsys value=/usr/lib/systemd/user")

    def test_missing_required_dependency_fails(self) -> None:
        line = "depends=('python' 'systemd' 'systemd-libs')\n"
        for package in ("vsys", "vsys-git"):
            pkgbuild = self.repo / "packaging" / package / "PKGBUILD"
            original = pkgbuild.read_text()
            self.assertEqual(original.count(line), 1)
            for dependency, without in (
                ("'python'", "depends=('systemd' 'systemd-libs')\n"),
                ("'systemd'", "depends=('python' 'systemd-libs')\n"),
                ("'systemd-libs'", "depends=('python' 'systemd')\n"),
            ):
                with self.subTest(package=package, dependency=dependency):
                    pkgbuild.write_text(original.replace(line, without))
                    self.assertEqual(
                        self.refusal(self.run_check(), prose=False),
                        f"pkgbuild=dependency-missing package={package} value={dependency}",
                    )
            pkgbuild.write_text(original)

    def test_strip_enabled_pkgbuild_fails(self) -> None:
        pkgbuild = self.repo / "packaging" / "vsys-git" / "PKGBUILD"
        pkgbuild.write_text(pkgbuild.read_text().replace("options=('!strip' '!debug')\n", ""))
        self.assertEqual(self.refusal(self.run_check()), "pkgbuild=strip-enabled package=vsys-git")

    def test_arch_package_source_without_commit_fails(self) -> None:
        workflow = self.repo / ".github" / "workflows" / "ci.yml"
        workflow.write_text(workflow.read_text().replace("#commit={commit}", ""))
        self.assertEqual(self.refusal(self.run_check()), "ci-workflow=unpinned-git-source")

    def test_arch_package_build_step_github_expression_fails(self) -> None:
        workflow = self.repo / ".github" / "workflows" / "ci.yml"
        workflow.write_text(workflow.read_text().replace(
            'pkg_var = "$" + "{pkgname}"',
            'pkg_var = "${{pkgname}}"',
        ))
        self.assertEqual(self.refusal(self.run_check()), "ci-workflow=build-step-expression")

    def test_ownership_preserving_release_copy_fails(self) -> None:
        pkgbuild = self.repo / "packaging" / "vsys" / "PKGBUILD"
        pkgbuild.write_text(pkgbuild.read_text().replace(
            'cp -R --no-preserve=ownership "${srcdir}/lib" "${pkgdir}/usr/"',
            'cp -a "${srcdir}/lib" "${pkgdir}/usr/"',
        ))
        self.assertEqual(self.refusal(self.run_check()), "pkgbuild=ownership-preserved package=vsys")

    def test_ownership_preserving_installer_copy_fails(self) -> None:
        installer = self.repo / "install.sh"
        installer.write_text(installer.read_text().replace(
            'cp -R --no-preserve=ownership "${source_root}/." "$WARDEN_NEW_ROOT/"',
            'cp -Rp "${source_root}/." "$WARDEN_NEW_ROOT/"',
        ))
        self.assertEqual(self.refusal(self.run_check()), "install-sh=ownership-preserved")

    def test_staged_content_must_match_manifest_source(self) -> None:
        stage_script = self.repo / "packaging" / "stage-runtime-files.sh"
        stage_script.write_text(stage_script.read_text().replace(
            'install -Dm"$mode" "$source" "$target"',
            'install -Dm"$mode" "${repo_root}/warden/agent-warden" "$target"',
        ))
        # The first manifest row not sourced from agent-warden is refused;
        # which one that is belongs to the manifest's order.
        self.assertEqual(self.refusal(self.run_check(), prose=False).split()[0], "staged=content-mismatch")


class PackageFunctions(unittest.TestCase):
    """Run each PKGBUILD's package() against a scratch srcdir and pkgdir, so
    no test writes /usr: what lands under pkgdir is what pacman installs."""

    def setUp(self) -> None:
        scratch_root = ROOT / "tmp" / "package-function-tests"
        scratch_root.mkdir(parents=True, exist_ok=True)
        self.scratch = tempfile.TemporaryDirectory(dir=scratch_root)
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)

    def package(self, name: str, srcdir: Path, cwd: Path) -> Path:
        pkgdir = self.root / "pkg"
        script = f'source "{ROOT}/packaging/{name}/PKGBUILD"; package'
        env = {**os.environ, "srcdir": str(srcdir), "pkgdir": str(pkgdir)}
        subprocess.run(["bash", "-euc", script], cwd=cwd, env=env, check=True)
        return pkgdir / "usr"

    def assert_reporters(self, usr: Path) -> None:
        for path in REPORTER_ROWS:
            mode, source = PAYLOAD[path]
            self.assertEqual((usr / path).stat().st_mode & 0o777, mode, path)
            self.assertEqual((usr / path).read_bytes(), (ROOT / source).read_bytes(), path)

    def test_release_package_ships_reporters(self) -> None:
        srcdir = self.root / "src"
        subprocess.run([str(ROOT / "packaging" / "stage-runtime-files.sh"), str(srcdir)], check=True)
        for name in ("vsys", "LICENSE", "README.md"):
            (srcdir / name).write_text("fixture\n")
        self.assert_reporters(self.package("vsys", srcdir, srcdir))

    def test_git_package_ships_reporters(self) -> None:
        srcdir = self.root / "src"
        checkout = srcdir / "vsys-git"
        for path in (MANIFEST, "packaging/stage-runtime-files.sh", *(source for _mode, source in PAYLOAD.values())):
            (checkout / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / path, checkout / path)
        for name in ("vsys", "LICENSE", "README.md"):
            (checkout / name).write_text("fixture\n")
        self.assert_reporters(self.package("vsys-git", srcdir, srcdir))


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
        self.fail_binary_replace = False
        self.fail_old_tree_delete = False
        self.install_umask: int | None = None

    def make_archive(self, shape: str) -> None:
        stage = self.root / f"stage-{shape}"
        stage.mkdir()
        vsys = stage / "vsys"
        vsys.write_text(f"{shape} binary\n")
        vsys.chmod(0o755)
        if shape == "full":
            for archive_path, (mode, source) in PAYLOAD.items():
                target = stage / archive_path
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / source, target)
                target.chmod(mode)
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
        commands.mkdir(exist_ok=True)
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
        if self.fail_binary_replace:
            system_mv = shutil.which("mv", path=os.environ["PATH"])
            if system_mv is None:
                raise AssertionError("mv not found")
            mv = commands / "mv"
            mv.write_text(
                "#!/bin/sh\n"
                "last=\n"
                "previous=\n"
                "for arg do previous=$last; last=$arg; done\n"
                "case \"$previous:$last\" in\n"
                "  */.vsys.new.*:*/bin/vsys) exit 37 ;;\n"
                "esac\n"
                f"exec {system_mv} \"$@\"\n"
            )
            mv.chmod(0o755)
        if self.fail_old_tree_delete:
            system_rm = shutil.which("rm", path=os.environ["PATH"])
            if system_rm is None:
                raise AssertionError("rm not found")
            rm = commands / "rm"
            rm.write_text(
                "#!/bin/sh\n"
                "for arg do\n"
                "  case \"$arg\" in */.vsys.old.*) exit 41 ;; esac\n"
                "done\n"
                f"exec {system_rm} \"$@\"\n"
            )
            rm.chmod(0o755)
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
        preexec_fn = None
        if self.install_umask is not None:
            def set_umask() -> None:
                os.umask(self.install_umask)

            preexec_fn = set_umask
        return subprocess.run(
            ["bash", str(INSTALL)],
            env=env,
            capture_output=True,
            text=True,
            preexec_fn=preexec_fn,
        )

    def lib_root(self) -> Path:
        return self.root / "home" / ".local" / "lib" / "vsys"

    def assert_full_warden_tree_installed(self) -> None:
        root = self.lib_root()
        self.assertTrue((root / "warden" / "install").is_file())
        self.assertTrue(os.access(root / "warden" / "install", os.X_OK))
        self.assertTrue((root / "warden" / "agent-warden").is_file())
        self.assertTrue((root / "warden" / "systemd" / "agent-warden.service").is_file())
        self.assertTrue((root / "data" / "agent-tools.json").is_file())

    def mode(self, path: Path) -> int:
        return path.stat().st_mode & 0o777

    def refusal(self, result: subprocess.CompletedProcess[str]) -> str:
        """The refusal's key=value line. A failing command the installer ran
        can print to stderr first, so the line is found by the installer's
        prefix, which on a refusal only the key line carries."""
        self.assertEqual(result.returncode, 1, result.stderr)
        lines = [line for line in result.stderr.splitlines() if line.startswith("vsys install: ")]
        self.assertEqual(len(lines), 1, result.stderr)
        return lines[0]

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
        self.assertEqual(self.refusal(result), f"vsys install: lib={lib.resolve() / 'vsys'} symlink")
        self.assertEqual(binary.read_text(), "old binary\n")
        self.assertTrue((lib / "vsys").is_symlink())

    def test_full_archive_installs_binary_and_warden_tree(self) -> None:
        self.make_archive("full")
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.bin_dir / "vsys").read_text(), "full binary\n")
        self.assert_full_warden_tree_installed()

    def test_restrictive_umask_keeps_shared_warden_modes(self) -> None:
        self.make_archive("full")
        (self.root / "home" / ".local" / "lib").mkdir(parents=True)
        self.install_umask = 0o077
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        prefix = self.root / "home" / ".local"
        directories = set()
        for archive_path, (mode, _source) in PAYLOAD.items():
            path = prefix / archive_path
            # install.sh installs nothing as root, so it leaves the system
            # files only a package installs.
            if not archive_path.startswith(PAYLOAD_PREFIX):
                with self.subTest(path=path):
                    self.assertFalse(path.exists())
                continue
            with self.subTest(path=path):
                self.assertEqual(self.mode(path), mode)
            directories.update(path.relative_to(self.lib_root()).parents)
        for directory in directories:
            with self.subTest(path=directory):
                self.assertEqual(self.mode(self.lib_root() / directory), 0o755)

    def test_full_archive_replaces_existing_warden_tree(self) -> None:
        self.make_archive("full")
        self.bin_dir.mkdir(parents=True)
        old_binary = self.bin_dir / "vsys"
        old_binary.write_text("old binary\n")
        old_binary.chmod(0o755)
        old_marker = self.lib_root() / "old.txt"
        old_marker.parent.mkdir(parents=True)
        old_marker.write_text("old tree\n")
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(old_binary.read_text(), "full binary\n")
        self.assert_full_warden_tree_installed()
        self.assertFalse(old_marker.exists())

    def test_binary_replace_failure_rolls_back_warden_tree(self) -> None:
        self.make_archive("full")
        self.fail_binary_replace = True
        self.bin_dir.mkdir(parents=True)
        old_binary = self.bin_dir / "vsys"
        old_binary.write_text("old binary\n")
        old_binary.chmod(0o755)
        old_marker = self.lib_root() / "old.txt"
        old_marker.parent.mkdir(parents=True)
        old_marker.write_text("old tree\n")
        result = self.run_install()
        self.assertEqual(self.refusal(result), f"vsys install: binary={old_binary.resolve()} replace-failed")
        self.assertEqual(old_binary.read_text(), "old binary\n")
        self.assertEqual(old_marker.read_text(), "old tree\n")
        self.assertFalse((self.lib_root() / "warden" / "install").exists())

    def test_binary_directory_replace_failure_rolls_back_warden_tree(self) -> None:
        self.make_archive("full")
        binary_dir = self.bin_dir / "vsys"
        binary_dir.mkdir(parents=True)
        old_marker = self.lib_root() / "old.txt"
        old_marker.parent.mkdir(parents=True)
        old_marker.write_text("old tree\n")
        result = self.run_install()
        self.assertEqual(self.refusal(result), f"vsys install: binary={binary_dir.resolve()} replace-failed")
        self.assertTrue(binary_dir.is_dir())
        self.assertEqual(old_marker.read_text(), "old tree\n")
        self.assertFalse((self.lib_root() / "warden" / "install").exists())

    def test_old_tree_delete_failure_is_a_warning_after_commit(self) -> None:
        self.make_archive("full")
        self.fail_old_tree_delete = True
        self.bin_dir.mkdir(parents=True)
        old_binary = self.bin_dir / "vsys"
        old_binary.write_text("old binary\n")
        old_binary.chmod(0o755)
        old_marker = self.lib_root() / "old.txt"
        old_marker.parent.mkdir(parents=True)
        old_marker.write_text("old tree\n")
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("warning=old-tree-left", result.stderr)
        self.assertEqual(old_binary.read_text(), "full binary\n")
        self.assert_full_warden_tree_installed()
        leftovers = list((self.root / "home" / ".local" / "lib").glob(".vsys.old.*"))
        self.assertEqual(len(leftovers), 1)
        self.assertEqual((leftovers[0] / "old.txt").read_text(), "old tree\n")

    def test_legacy_archive_installs_binary_without_warden(self) -> None:
        self.make_archive("legacy")
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.bin_dir / "vsys").read_text(), "legacy binary\n")
        self.assertFalse((self.root / "home" / ".local" / "lib" / "vsys").exists())

    def test_checksum_refusal_leaves_existing_binary(self) -> None:
        self.make_archive("full")
        self.bin_dir.mkdir(parents=True)
        binary = self.bin_dir / "vsys"
        binary.write_text("old binary\n")
        binary.chmod(0o755)
        digest = hashlib.sha256((self.root / self.asset).read_bytes()).hexdigest()
        rows = (
            ("mismatch", f"{'0' * 64}  {self.asset}\n"),
            ("unlisted", f"{digest}  vsys-vfixture-linux-aarch64.tar.gz\n"),
        )
        for key, sums in rows:
            with self.subTest(key=key):
                (self.root / "SHA256SUMS").write_text(sums)
                result = self.run_install()
                self.assertEqual(self.refusal(result), f"vsys install: checksum={self.asset} {key}")
                self.assertEqual(binary.read_text(), "old binary\n")
                self.assertFalse(self.lib_root().exists())

    def test_partial_lib_tree_refuses_before_replacing_binary(self) -> None:
        self.make_archive("partial")
        self.bin_dir.mkdir(parents=True)
        binary = self.bin_dir / "vsys"
        binary.write_text("old binary\n")
        binary.chmod(0o755)
        result = self.run_install()
        self.assertEqual(self.refusal(result), "vsys install: archive=lib/vsys/warden/agent-warden missing")
        self.assertEqual(binary.read_text(), "old binary\n")


if __name__ == "__main__":
    unittest.main()
