import contextlib
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
REAL_WARDEN = ROOT / "warden"
INSTALL = REAL_WARDEN / "install"
SCRATCH_ROOT = ROOT / "tmp" / "warden-install-tests"


def scratch():
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=SCRATCH_ROOT)


def load_install(path=INSTALL, name="warden_install_under_test"):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    if spec is None:
        raise RuntimeError("warden/install import spec unavailable")
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class Env:
    def __init__(self, values):
        self.values = values
        self.old = None

    def __enter__(self):
        self.old = os.environ.copy()
        os.environ.clear()
        os.environ.update(self.values)

    def __exit__(self, exc_type, exc, tb):
        os.environ.clear()
        os.environ.update(self.old)


class WardenInstallTest(unittest.TestCase):
    def make_warden(self, base, *, with_data=True, data=b'{"tools":["claude"]}\n'):
        package = base / "package"
        warden = package / "warden"
        (warden / "systemd").mkdir(parents=True)
        shutil.copy2(INSTALL, warden / "install")
        shutil.copy2(REAL_WARDEN / "systemd" / "agent-warden.service", warden / "systemd" / "agent-warden.service")
        shutil.copy2(REAL_WARDEN / "systemd" / "agent-warden.timer", warden / "systemd" / "agent-warden.timer")
        shutil.copy2(REAL_WARDEN / "systemd" / "agents.slice", warden / "systemd" / "agents.slice")
        agent = warden / "agent-warden"
        agent.write_text("#!/bin/sh\n", encoding="utf-8")
        agent.chmod(0o755)
        if with_data:
            data_path = package / "data" / "agent-tools.json"
            data_path.parent.mkdir(parents=True)
            data_path.write_bytes(data)
        return load_install(warden / "install", f"warden_install_under_test_{id(base)}"), warden, data

    def fixture(self, base, *, with_data=True, data=b'{"tools":["claude"]}\n'):
        home = base / "home"
        xdg = base / "xdg"
        data_home = base / "data-home"
        stub = base / "bin"
        user_dir = xdg / "systemd" / "user"
        log = base / "systemctl.jsonl"
        for path in (home, xdg, data_home, stub, user_dir):
            path.mkdir(parents=True, exist_ok=True)
        systemctl = stub / "systemctl"
        systemctl.write_text(
            "#!" + sys.executable + "\n"
            "import json, os, pathlib, sys\n"
            "args = sys.argv[1:]\n"
            "log = pathlib.Path(os.environ['STUB_LOG'])\n"
            "user_dir = pathlib.Path(os.environ['STUB_USER_DIR'])\n"
            "with log.open('a', encoding='utf-8') as handle:\n"
            "    handle.write(json.dumps(args) + '\\n')\n"
            "wants = user_dir / 'timers.target.wants'\n"
            "link = wants / 'agent-warden.timer'\n"
            "timer = user_dir / 'agent-warden.timer'\n"
            "if args == ['--user', 'daemon-reload']:\n"
            "    raise SystemExit(0)\n"
            "if args == ['--user', 'enable', '--now', 'agent-warden.timer']:\n"
            "    wants.mkdir(parents=True, exist_ok=True)\n"
            "    if link.exists() or link.is_symlink():\n"
            "        link.unlink()\n"
            "    link.symlink_to(timer)\n"
            "    raise SystemExit(0)\n"
            "if args == ['--user', 'disable', '--now', 'agent-warden.timer']:\n"
            "    if link.exists() or link.is_symlink():\n"
            "        link.unlink()\n"
            "    raise SystemExit(0)\n"
            "if args == ['--user', 'stop', 'agent-warden.service']:\n"
            "    raise SystemExit(0)\n"
            "if args == ['--user', 'is-enabled', 'agent-warden.timer']:\n"
            "    print('enabled' if link.is_symlink() else 'disabled')\n"
            "    raise SystemExit(0 if link.is_symlink() else 1)\n"
            "if args == ['--user', 'is-active', 'agent-warden.timer']:\n"
            "    value = os.environ.get('STUB_ACTIVE', 'active')\n"
            "    print(value)\n"
            "    raise SystemExit(0 if value == 'active' else 3)\n"
            "if args == ['--user', 'show', 'agent-warden.timer', '-p', 'LastTriggerUSec', '--value']:\n"
            "    print(os.environ.get('STUB_LAST_TRIGGER', 'Mon 2026-09-28 01:02:03 PDT'))\n"
            "    raise SystemExit(0)\n"
            "if args == ['--user', 'show', 'agent-warden.service', '-p', 'Result', '--value']:\n"
            "    if 'STUB_RESULT_STDERR' in os.environ:\n"
            "        print(os.environ['STUB_RESULT_STDERR'], file=sys.stderr)\n"
            "        raise SystemExit(1)\n"
            "    print(os.environ.get('STUB_RESULT', 'success'))\n"
            "    raise SystemExit(0)\n"
            "print('unexpected systemctl args: ' + repr(args), file=sys.stderr)\n"
            "raise SystemExit(99)\n",
            encoding="utf-8",
        )
        systemctl.chmod(0o755)
        env = {
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(xdg),
            "XDG_DATA_HOME": str(data_home),
            "PATH": str(stub),
            "PYTHONDONTWRITEBYTECODE": "1",
            "STUB_LOG": str(log),
            "STUB_USER_DIR": str(user_dir),
        }
        installer, warden, source_data = self.make_warden(base, with_data=with_data, data=data)
        return installer, warden, source_data, env, user_dir, data_home / "vsys" / "agent-tools.json", log

    def calls(self, log):
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]

    def run_main(self, installer, argv, env):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with Env(env), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = installer.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_install_writes_marked_units_data_and_enables_timer(self):
        with scratch() as tmp:
            installer, warden, source_data, env, user_dir, data_target, log = self.fixture(Path(tmp))
            local = Path(env["HOME"]) / ".config" / "vsys" / "agent-tools.json"
            local.parent.mkdir(parents=True)
            local.write_text("local\n", encoding="utf-8")
            code, stdout, stderr = self.run_main(installer, ["install"], env)
            self.assertEqual((code, stderr), (0, ""))
            self.assertIn("vsys-warden: installed", stdout)
            source_hash = hashlib.sha256(source_data).hexdigest()
            for name in installer.UNIT_NAMES:
                path = user_dir / name
                text = path.read_text(encoding="utf-8")
                self.assertEqual(text.splitlines()[0], installer.MARKER)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            service = (user_dir / "agent-warden.service").read_text(encoding="utf-8")
            self.assertEqual(service.splitlines()[1], installer.DATA_MARKER_PREFIX + source_hash)
            self.assertIn(f"ExecStart={warden / 'agent-warden'} --correct", service)
            self.assertNotIn("%h/.local/bin", service)
            self.assertEqual(data_target.read_bytes(), source_data)
            self.assertEqual(stat.S_IMODE(data_target.stat().st_mode), 0o644)
            self.assertEqual(local.read_text(encoding="utf-8"), "local\n")
            self.assertEqual(
                self.calls(log),
                [
                    ["--user", "daemon-reload"],
                    ["--user", "enable", "--now", "agent-warden.timer"],
                ],
            )
            self.assertTrue((user_dir / "timers.target.wants" / "agent-warden.timer").is_symlink())

    def test_install_refuses_missing_agent_tools_before_writing(self):
        with scratch() as tmp:
            installer, _, _, env, user_dir, data_target, log = self.fixture(Path(tmp), with_data=False)
            code, stdout, stderr = self.run_main(installer, ["install"], env)
            self.assertEqual(code, 1, stdout)
            self.assertIn("vsys-warden: agent-tools=missing", stderr)
            self.assertFalse(data_target.exists())
            self.assertFalse((user_dir / "agent-warden.service").exists())
            self.assertEqual(self.calls(log), [])

    def test_install_refuses_foreign_file_symlink_and_data_before_writing(self):
        with scratch() as tmp:
            installer, _, _, env, user_dir, data_target, log = self.fixture(Path(tmp))
            service = user_dir / "agent-warden.service"
            timer = user_dir / "agent-warden.timer"
            service.write_text("foreign\n", encoding="utf-8")
            target = user_dir / "target.timer"
            target.write_text("target\n", encoding="utf-8")
            timer.symlink_to(target)
            data_target.parent.mkdir(parents=True)
            data_target.write_text("foreign data\n", encoding="utf-8")
            code, stdout, stderr = self.run_main(installer, ["install"], env)
            self.assertEqual(code, 1, stdout)
            self.assertIn(f"foreign: {service}", stderr)
            self.assertIn(f"foreign: {timer}", stderr)
            self.assertIn(f"foreign: {data_target}", stderr)
            self.assertEqual(service.read_text(encoding="utf-8"), "foreign\n")
            self.assertTrue(timer.is_symlink())
            self.assertEqual(data_target.read_text(encoding="utf-8"), "foreign data\n")
            self.assertFalse((user_dir / "agents.slice").exists())
            self.assertEqual(self.calls(log), [])

    def test_install_refuses_folded_stow_directory_symlinks_before_writing(self):
        rows = [
            "systemd",
            "systemd-user",
            "data-dir",
        ]
        for row in rows:
            with self.subTest(row=row), scratch() as tmp:
                base = Path(tmp)
                installer, _, _, env, user_dir, data_target, log = self.fixture(base)
                if row == "systemd":
                    shutil.rmtree(user_dir.parent)
                    folded = base / "folded-systemd"
                    folded.mkdir()
                    user_dir.parent.symlink_to(folded)
                    expected = user_dir.parent
                elif row == "systemd-user":
                    shutil.rmtree(user_dir)
                    folded = base / "folded-user"
                    folded.mkdir()
                    user_dir.symlink_to(folded)
                    expected = user_dir
                else:
                    folded = base / "folded-vsys"
                    folded.mkdir()
                    data_target.parent.symlink_to(folded)
                    expected = data_target.parent
                code, stdout, stderr = self.run_main(installer, ["install"], env)
                self.assertEqual(code, 1, stdout)
                self.assertIn("vsys-warden: symlink-dir action=install", stderr)
                self.assertIn(f"symlink: {expected}", stderr)
                self.assertFalse((user_dir / "agent-warden.service").exists())
                self.assertFalse(data_target.exists())
                self.assertEqual(self.calls(log), [])

    @unittest.skipIf(os.geteuid() == 0, "chmod unreadable rows require non-root")
    def test_unreadable_unit_reports_unknown_and_is_left_in_place(self):
        with scratch() as tmp:
            installer, _, _, env, user_dir, _, log = self.fixture(Path(tmp))
            service = user_dir / "agent-warden.service"
            service.write_text(installer.MARKER + "\n", encoding="utf-8")
            service.chmod(0)
            try:
                code, stdout, stderr = self.run_main(installer, ["install"], env)
                self.assertEqual(code, 1, stdout)
                self.assertIn("vsys-warden: unknown-units action=install", stderr)
                self.assertIn(f"unknown: {service}", stderr)
                self.assertEqual(self.calls(log), [])
                with Env(env), contextlib.redirect_stdout(io.StringIO()) as output:
                    code = installer.status(user_dir, Path(tmp) / "controllers")
                self.assertEqual(code, 1)
                self.assertIn("file agent-warden.service: unknown", output.getvalue())
                log.unlink(missing_ok=True)
                code, stdout, stderr = self.run_main(installer, ["uninstall"], env)
                self.assertEqual((code, stderr), (0, ""))
                self.assertIn(f"vsys-warden: unknown-left path={service}", stdout)
                self.assertTrue(service.exists())
                self.assertEqual(self.calls(log), [])
            finally:
                service.chmod(0o644)

    @unittest.skipIf(os.geteuid() == 0, "chmod unreadable rows require non-root")
    def test_unreadable_data_reports_unknown_and_is_left_in_place(self):
        with scratch() as tmp:
            installer, _, _, env, user_dir, data_target, log = self.fixture(Path(tmp))
            data_target.parent.mkdir(parents=True)
            data_target.write_text("owned maybe\n", encoding="utf-8")
            data_target.chmod(0)
            try:
                code, stdout, stderr = self.run_main(installer, ["install"], env)
                self.assertEqual(code, 1, stdout)
                self.assertIn("vsys-warden: unknown-data action=install", stderr)
                self.assertIn(f"unknown: {data_target}", stderr)
                self.assertEqual(self.calls(log), [])
                with Env(env), contextlib.redirect_stdout(io.StringIO()) as output:
                    code = installer.status(user_dir, Path(tmp) / "controllers")
                self.assertEqual(code, 1)
                self.assertIn("file agent-tools.json: unknown", output.getvalue())
                log.unlink(missing_ok=True)
                code, stdout, stderr = self.run_main(installer, ["uninstall"], env)
                self.assertEqual((code, stderr), (0, ""))
                self.assertIn(f"vsys-warden: unknown-left path={data_target}", stdout)
                self.assertTrue(data_target.exists())
                self.assertEqual(self.calls(log), [])
            finally:
                data_target.chmod(0o644)

    def test_install_rewrites_its_own_units_and_data(self):
        with scratch() as tmp:
            installer, warden, _, env, user_dir, data_target, _ = self.fixture(Path(tmp))
            code, _, stderr = self.run_main(installer, ["install"], env)
            self.assertEqual((code, stderr), (0, ""))
            next_data = b'{"tools":["codex"]}\n'
            (warden / ".." / "data" / "agent-tools.json").write_bytes(next_data)
            service = user_dir / "agent-warden.service"
            service.write_text(service.read_text(encoding="utf-8") + "old\n", encoding="utf-8")
            code, _, stderr = self.run_main(installer, ["install"], env)
            self.assertEqual((code, stderr), (0, ""))
            self.assertEqual(data_target.read_bytes(), next_data)
            text = service.read_text(encoding="utf-8")
            markers = [line for line in text.splitlines() if line.startswith(installer.DATA_MARKER_PREFIX)]
            self.assertEqual(
                set(markers),
                {
                    installer.DATA_MARKER_PREFIX + hashlib.sha256(b'{"tools":["claude"]}\n').hexdigest(),
                    installer.DATA_MARKER_PREFIX + hashlib.sha256(next_data).hexdigest(),
                },
            )
            self.assertNotIn("\nold\n", text)
            code, _, stderr = self.run_main(installer, ["install"], env)
            self.assertEqual((code, stderr), (0, ""))
            markers = [line for line in service.read_text(encoding="utf-8").splitlines() if line.startswith(installer.DATA_MARKER_PREFIX)]
            self.assertEqual(markers, [installer.DATA_MARKER_PREFIX + hashlib.sha256(next_data).hexdigest()])

    def test_install_retry_succeeds_after_data_write_failure(self):
        with scratch() as tmp:
            installer, warden, source_data, env, user_dir, data_target, log = self.fixture(Path(tmp))
            original = installer.atomic_write_bytes

            def fail_once(path, data):
                raise OSError("injected data write failure")

            installer.atomic_write_bytes = fail_once
            try:
                with Env(env), self.assertRaises(OSError):
                    installer.install(warden, user_dir)
            finally:
                installer.atomic_write_bytes = original
            service = user_dir / "agent-warden.service"
            self.assertTrue(service.exists())
            self.assertEqual(service.read_text(encoding="utf-8").splitlines()[0], installer.MARKER)
            self.assertFalse(data_target.exists())
            self.assertEqual(self.calls(log), [])
            with Env(env), contextlib.redirect_stdout(io.StringIO()):
                code = installer.install(warden, user_dir)
            self.assertEqual(code, 0)
            self.assertEqual(data_target.read_bytes(), source_data)
            self.assertEqual(
                self.calls(log),
                [
                    ["--user", "daemon-reload"],
                    ["--user", "enable", "--now", "agent-warden.timer"],
                ],
            )

    def test_upgrade_retry_succeeds_after_data_write_failure_and_uninstall_removes_data(self):
        with scratch() as tmp:
            installer, warden, _, env, user_dir, data_target, log = self.fixture(Path(tmp))
            code, _, stderr = self.run_main(installer, ["install"], env)
            self.assertEqual((code, stderr), (0, ""))
            old_data = data_target.read_bytes()
            new_data = b'{"tools":["codex"]}\n'
            (warden / ".." / "data" / "agent-tools.json").write_bytes(new_data)
            original = installer.atomic_write_bytes

            def fail_once(path, data):
                raise OSError("injected data write failure")

            installer.atomic_write_bytes = fail_once
            try:
                with Env(env), self.assertRaises(OSError):
                    installer.install(warden, user_dir)
            finally:
                installer.atomic_write_bytes = original
            self.assertEqual(data_target.read_bytes(), old_data)
            service = user_dir / "agent-warden.service"
            markers = [line for line in service.read_text(encoding="utf-8").splitlines() if line.startswith(installer.DATA_MARKER_PREFIX)]
            self.assertEqual(
                set(markers),
                {
                    installer.DATA_MARKER_PREFIX + hashlib.sha256(old_data).hexdigest(),
                    installer.DATA_MARKER_PREFIX + hashlib.sha256(new_data).hexdigest(),
                },
            )
            with Env(env), contextlib.redirect_stdout(io.StringIO()):
                code = installer.install(warden, user_dir)
            self.assertEqual(code, 0)
            self.assertEqual(data_target.read_bytes(), new_data)
            with Env(env), contextlib.redirect_stdout(io.StringIO()):
                code = installer.uninstall(user_dir)
            self.assertEqual(code, 0)
            self.assertFalse(data_target.exists())
            self.assertEqual(
                self.calls(log),
                [
                    ["--user", "daemon-reload"],
                    ["--user", "enable", "--now", "agent-warden.timer"],
                    ["--user", "daemon-reload"],
                    ["--user", "enable", "--now", "agent-warden.timer"],
                    ["--user", "disable", "--now", "agent-warden.timer"],
                    ["--user", "stop", "agent-warden.service"],
                    ["--user", "daemon-reload"],
                ],
            )

    def test_uninstall_refuses_folded_stow_directory_symlinks_before_classifying(self):
        rows = [
            "systemd",
            "systemd-user",
            "data-dir",
        ]
        for row in rows:
            with self.subTest(row=row), scratch() as tmp:
                base = Path(tmp)
                installer, _, _, env, user_dir, data_target, log = self.fixture(base)
                if row == "systemd":
                    shutil.rmtree(user_dir.parent)
                    folded = base / "folded-systemd"
                    (folded / "user").mkdir(parents=True)
                    user_dir.parent.symlink_to(folded)
                    protected = user_dir / "agent-warden.service"
                    expected = user_dir.parent
                elif row == "systemd-user":
                    shutil.rmtree(user_dir)
                    folded = base / "folded-user"
                    folded.mkdir()
                    user_dir.symlink_to(folded)
                    protected = user_dir / "agent-warden.service"
                    expected = user_dir
                else:
                    folded = base / "folded-vsys"
                    folded.mkdir()
                    data_target.parent.symlink_to(folded)
                    protected = data_target
                    expected = data_target.parent
                protected.write_text("protected\n", encoding="utf-8")
                code, stdout, stderr = self.run_main(installer, ["uninstall"], env)
                self.assertEqual(code, 1, stdout)
                self.assertIn("vsys-warden: symlink-dir action=uninstall", stderr)
                self.assertIn(f"symlink: {expected}", stderr)
                self.assertEqual(protected.read_text(encoding="utf-8"), "protected\n")
                self.assertEqual(self.calls(log), [])

    def test_uninstall_removes_marked_files_data_and_leaves_local_config(self):
        with scratch() as tmp:
            installer, _, _, env, user_dir, data_target, log = self.fixture(Path(tmp))
            local = Path(env["HOME"]) / ".config" / "vsys" / "agent-tools.json"
            local.parent.mkdir(parents=True)
            local.write_text("local\n", encoding="utf-8")
            before = sorted(path.relative_to(user_dir) for path in user_dir.rglob("*"))
            code, _, stderr = self.run_main(installer, ["install"], env)
            self.assertEqual((code, stderr), (0, ""))
            code, stdout, stderr = self.run_main(installer, ["uninstall"], env)
            self.assertEqual((code, stderr), (0, ""))
            self.assertIn("vsys-warden: uninstalled", stdout)
            after = sorted(path.relative_to(user_dir) for path in user_dir.rglob("*"))
            self.assertEqual(before, after)
            self.assertFalse(data_target.exists())
            self.assertEqual(local.read_text(encoding="utf-8"), "local\n")
            self.assertEqual(
                self.calls(log),
                [
                    ["--user", "daemon-reload"],
                    ["--user", "enable", "--now", "agent-warden.timer"],
                    ["--user", "disable", "--now", "agent-warden.timer"],
                    ["--user", "stop", "agent-warden.service"],
                    ["--user", "daemon-reload"],
                ],
            )

    def test_uninstall_leaves_foreign_units_and_data_and_is_idempotent(self):
        with scratch() as tmp:
            installer, _, _, env, user_dir, data_target, log = self.fixture(Path(tmp))
            foreign = user_dir / "agents.slice"
            foreign.write_text("foreign\n", encoding="utf-8")
            data_target.parent.mkdir(parents=True)
            data_target.write_text("foreign data\n", encoding="utf-8")
            code, stdout, stderr = self.run_main(installer, ["uninstall"], env)
            self.assertEqual((code, stderr), (0, ""))
            self.assertIn(f"vsys-warden: foreign-left path={foreign}", stdout)
            self.assertIn(f"vsys-warden: foreign-left path={data_target}", stdout)
            self.assertIn("vsys-warden: nothing-installed", stdout)
            self.assertEqual(foreign.read_text(encoding="utf-8"), "foreign\n")
            self.assertEqual(data_target.read_text(encoding="utf-8"), "foreign data\n")
            self.assertEqual(self.calls(log), [])

    def test_uninstall_keeps_enable_link_when_timer_is_foreign(self):
        with scratch() as tmp:
            installer, _, _, env, user_dir, data_target, log = self.fixture(Path(tmp))
            code, _, stderr = self.run_main(installer, ["install"], env)
            self.assertEqual((code, stderr), (0, ""))
            timer = user_dir / "agent-warden.timer"
            timer.write_text("foreign timer\n", encoding="utf-8")
            link = user_dir / "timers.target.wants" / "agent-warden.timer"
            self.assertTrue(link.is_symlink())
            code, stdout, stderr = self.run_main(installer, ["uninstall"], env)
            self.assertEqual((code, stderr), (0, ""))
            self.assertIn(f"vsys-warden: foreign-left path={timer}", stdout)
            self.assertFalse((user_dir / "agent-warden.service").exists())
            self.assertFalse((user_dir / "agents.slice").exists())
            self.assertEqual(timer.read_text(encoding="utf-8"), "foreign timer\n")
            self.assertTrue(link.is_symlink())
            self.assertFalse(data_target.exists())
            self.assertEqual(
                self.calls(log),
                [
                    ["--user", "daemon-reload"],
                    ["--user", "enable", "--now", "agent-warden.timer"],
                    ["--user", "stop", "agent-warden.service"],
                    ["--user", "daemon-reload"],
                ],
            )

    def test_uninstall_stops_marked_service_without_marked_timer(self):
        with scratch() as tmp:
            installer, _, _, env, user_dir, _, log = self.fixture(Path(tmp))
            service = user_dir / "agent-warden.service"
            service.write_text(installer.MARKER + "\n[Service]\n", encoding="utf-8")
            code, stdout, stderr = self.run_main(installer, ["uninstall"], env)
            self.assertEqual((code, stderr), (0, ""))
            self.assertIn("vsys-warden: uninstalled", stdout)
            self.assertFalse(service.exists())
            self.assertEqual(
                self.calls(log),
                [
                    ["--user", "stop", "agent-warden.service"],
                    ["--user", "daemon-reload"],
                ],
            )

    def test_status_reports_ok_missing_delegation_and_unknown(self):
        with scratch() as tmp:
            base = Path(tmp)
            installer, _, _, env, user_dir, _, _ = self.fixture(base)
            code, _, stderr = self.run_main(installer, ["install"], env)
            self.assertEqual((code, stderr), (0, ""))
            full = base / "controllers-full"
            full.write_text("cpu io memory pids\n", encoding="utf-8")
            missing = base / "controllers-missing"
            missing.write_text("io memory pids\n", encoding="utf-8")
            with Env(env), contextlib.redirect_stdout(io.StringIO()) as output:
                code = installer.status(user_dir, full)
            self.assertEqual(code, 0)
            text = output.getvalue()
            self.assertIn("file agent-warden.service: installed-by-vsys", text)
            self.assertIn("file agent-tools.json: installed-by-vsys", text)
            self.assertIn("timer enabled: enabled", text)
            self.assertIn("timer active: active", text)
            self.assertIn("delegation cpu memory pids: complete", text)
            failed = {**env, "STUB_RESULT": "exit-code"}
            with Env(failed), contextlib.redirect_stdout(io.StringIO()) as output:
                code = installer.status(user_dir, full)
            self.assertEqual(code, 1)
            self.assertIn("service result: exit-code", output.getvalue())
            stderr_only = {**env, "STUB_RESULT_STDERR": "dbus failed"}
            with Env(stderr_only), contextlib.redirect_stdout(io.StringIO()) as output:
                code = installer.status(user_dir, full)
            self.assertEqual(code, 1)
            self.assertIn("service result: unknown", output.getvalue())
            with Env(env), contextlib.redirect_stdout(io.StringIO()) as output:
                code = installer.status(user_dir, missing)
            self.assertEqual(code, 1)
            self.assertIn("delegation cpu memory pids: missing cpu", output.getvalue())
            with Env(env), contextlib.redirect_stdout(io.StringIO()) as output:
                code = installer.status(user_dir, base / "absent-controllers")
            self.assertEqual(code, 1)
            self.assertIn("delegation cpu memory pids: unknown", output.getvalue())

    def test_execstart_escapes_percent_spaces_and_apostrophes(self):
        with scratch() as tmp:
            base = Path(tmp)
            installer = load_install()
            rows = [
                (base / "ward% en", str(base / "ward%% en" / "agent-warden")),
                (base / "oneil's", str(base / "oneil's" / "agent-warden")),
                (base / "cash$ dir", str(base / "cash$$ dir" / "agent-warden")),
            ]
            for fake, escaped_agent in rows:
                with self.subTest(fake=fake):
                    (fake / "systemd").mkdir(parents=True)
                    shutil.copy2(REAL_WARDEN / "systemd" / "agent-warden.service", fake / "systemd" / "agent-warden.service")
                    agent = fake / "agent-warden"
                    agent.write_text("#!/bin/sh\n", encoding="utf-8")
                    agent.chmod(0o755)
                    rendered = installer.render_unit(fake, "agent-warden.service", {"0" * 64})
                    self.assertIn('ExecStart="' + escaped_agent + '" --correct', rendered)
                    self.assertIn(installer.DATA_MARKER_PREFIX + "0" * 64, rendered)
                    self.assertNotIn("@WARDEN_DIR@", rendered)

    def load_mutant(self, old, new, name):
        text = INSTALL.read_text(encoding="utf-8")
        self.assertEqual(text.count(old), 1)
        tmp = scratch()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "install"
        path.write_text(text.replace(old, new), encoding="utf-8")
        path.chmod(0o755)
        return load_install(path, name)

    def test_foreign_refusal_mutant_control(self):
        mutant = self.load_mutant(
            "if line == MARKER:\n        return \"installed-by-vsys\"",
            "if True:\n        return \"installed-by-vsys\"",
            "warden_install_mutant_marker",
        )
        with scratch() as tmp:
            _, warden, _, env, user_dir, _, _ = self.fixture(Path(tmp))
            foreign = user_dir / "agent-warden.service"
            foreign.write_text("foreign\n", encoding="utf-8")
            with Env(env), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = mutant.install(warden, user_dir)
            self.assertEqual(code, 0)
            self.assertNotEqual(foreign.read_text(encoding="utf-8"), "foreign\n")


if __name__ == "__main__":
    unittest.main()
