import contextlib
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
WARDEN = ROOT / "warden"
INSTALL = WARDEN / "install"
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
    @classmethod
    def setUpClass(cls):
        cls.installer = load_install()

    def fixture(self, base):
        home = base / "home"
        xdg = base / "xdg"
        run = base / "run"
        stub = base / "bin"
        user_dir = xdg / "systemd" / "user"
        log = base / "systemctl.jsonl"
        for path in (home, xdg, run, stub, user_dir):
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
            "PATH": str(stub),
            "PYTHONDONTWRITEBYTECODE": "1",
            "STUB_LOG": str(log),
            "STUB_USER_DIR": str(user_dir),
        }
        return env, user_dir, log

    def calls(self, log):
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]

    def run_main(self, argv, env):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with Env(env), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = self.installer.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_install_writes_marked_units_and_enables_timer(self):
        with scratch() as tmp:
            env, user_dir, log = self.fixture(Path(tmp))
            code, stdout, stderr = self.run_main(["install"], env)
            self.assertEqual((code, stderr), (0, ""))
            self.assertIn("vsys-warden: installed", stdout)
            for name in self.installer.UNIT_NAMES:
                path = user_dir / name
                text = path.read_text(encoding="utf-8")
                self.assertEqual(text.splitlines()[0], self.installer.MARKER)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            service = (user_dir / "agent-warden.service").read_text(encoding="utf-8")
            self.assertIn(f"ExecStart={WARDEN / 'agent-warden'} --correct", service)
            self.assertNotIn("%h/.local/bin", service)
            self.assertEqual(
                self.calls(log),
                [
                    ["--user", "daemon-reload"],
                    ["--user", "enable", "--now", "agent-warden.timer"],
                ],
            )
            self.assertTrue((user_dir / "timers.target.wants" / "agent-warden.timer").is_symlink())

    def test_install_refuses_foreign_file_and_symlink_before_writing(self):
        with scratch() as tmp:
            env, user_dir, log = self.fixture(Path(tmp))
            service = user_dir / "agent-warden.service"
            timer = user_dir / "agent-warden.timer"
            service.write_text("foreign\n", encoding="utf-8")
            target = user_dir / "target.timer"
            target.write_text("target\n", encoding="utf-8")
            timer.symlink_to(target)
            code, stdout, stderr = self.run_main(["install"], env)
            self.assertEqual(code, 1, stdout)
            self.assertIn(f"foreign: {service}", stderr)
            self.assertIn(f"foreign: {timer}", stderr)
            self.assertEqual(service.read_text(encoding="utf-8"), "foreign\n")
            self.assertTrue(timer.is_symlink())
            self.assertFalse((user_dir / "agents.slice").exists())
            self.assertEqual(self.calls(log), [])

    def test_install_rewrites_its_own_units(self):
        with scratch() as tmp:
            env, user_dir, _ = self.fixture(Path(tmp))
            code, _, stderr = self.run_main(["install"], env)
            self.assertEqual((code, stderr), (0, ""))
            service = user_dir / "agent-warden.service"
            service.write_text(self.installer.MARKER + "\nold\n", encoding="utf-8")
            code, _, stderr = self.run_main(["install"], env)
            self.assertEqual((code, stderr), (0, ""))
            self.assertIn("ExecStart=", service.read_text(encoding="utf-8"))
            self.assertNotIn("\nold\n", service.read_text(encoding="utf-8"))

    def test_uninstall_removes_only_marked_files_and_timer_link(self):
        with scratch() as tmp:
            env, user_dir, log = self.fixture(Path(tmp))
            before = sorted(path.relative_to(user_dir) for path in user_dir.rglob("*"))
            code, _, stderr = self.run_main(["install"], env)
            self.assertEqual((code, stderr), (0, ""))
            code, stdout, stderr = self.run_main(["uninstall"], env)
            self.assertEqual((code, stderr), (0, ""))
            self.assertIn("vsys-warden: uninstalled", stdout)
            after = sorted(path.relative_to(user_dir) for path in user_dir.rglob("*"))
            self.assertEqual(before, after)
            self.assertEqual(
                self.calls(log),
                [
                    ["--user", "daemon-reload"],
                    ["--user", "enable", "--now", "agent-warden.timer"],
                    ["--user", "disable", "--now", "agent-warden.timer"],
                    ["--user", "daemon-reload"],
                ],
            )

    def test_uninstall_leaves_foreign_units_and_is_idempotent(self):
        with scratch() as tmp:
            env, user_dir, log = self.fixture(Path(tmp))
            foreign = user_dir / "agents.slice"
            foreign.write_text("foreign\n", encoding="utf-8")
            code, stdout, stderr = self.run_main(["uninstall"], env)
            self.assertEqual((code, stderr), (0, ""))
            self.assertIn(f"vsys-warden: foreign-left path={foreign}", stdout)
            self.assertIn("vsys-warden: nothing-installed", stdout)
            self.assertEqual(foreign.read_text(encoding="utf-8"), "foreign\n")
            self.assertEqual(self.calls(log), [])

    def test_status_reports_ok_missing_delegation_and_unknown(self):
        with scratch() as tmp:
            base = Path(tmp)
            env, user_dir, _ = self.fixture(base)
            code, _, stderr = self.run_main(["install"], env)
            self.assertEqual((code, stderr), (0, ""))
            full = base / "controllers-full"
            full.write_text("cpu io memory pids\n", encoding="utf-8")
            missing = base / "controllers-missing"
            missing.write_text("io memory pids\n", encoding="utf-8")
            with Env(env), contextlib.redirect_stdout(io.StringIO()) as output:
                code = self.installer.status(user_dir, full)
            self.assertEqual(code, 0)
            text = output.getvalue()
            self.assertIn("file agent-warden.service: installed-by-vsys", text)
            self.assertIn("timer enabled: enabled", text)
            self.assertIn("timer active: active", text)
            self.assertIn("delegation cpu memory pids: complete", text)
            with Env(env), contextlib.redirect_stdout(io.StringIO()) as output:
                code = self.installer.status(user_dir, missing)
            self.assertEqual(code, 1)
            self.assertIn("delegation cpu memory pids: missing cpu", output.getvalue())
            with Env(env), contextlib.redirect_stdout(io.StringIO()) as output:
                code = self.installer.status(user_dir, base / "absent-controllers")
            self.assertEqual(code, 1)
            self.assertIn("delegation cpu memory pids: unknown", output.getvalue())

    def test_execstart_escapes_percent_and_quotes_spaces(self):
        with scratch() as tmp:
            base = Path(tmp)
            fake = base / "ward% en"
            (fake / "systemd").mkdir(parents=True)
            shutil.copy2(WARDEN / "systemd" / "agent-warden.service", fake / "systemd" / "agent-warden.service")
            agent = fake / "agent-warden"
            agent.write_text("#!/bin/sh\n", encoding="utf-8")
            agent.chmod(0o755)
            rendered = self.installer.render_unit(fake, "agent-warden.service")
            self.assertIn('ExecStart="' + str(agent).replace("%", "%%") + '" --correct', rendered)
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
            "if first_line(path) == MARKER:\n        return \"installed-by-vsys\"",
            "if True:\n        return \"installed-by-vsys\"",
            "warden_install_mutant_marker",
        )
        with scratch() as tmp:
            env, user_dir, _ = self.fixture(Path(tmp))
            foreign = user_dir / "agent-warden.service"
            foreign.write_text("foreign\n", encoding="utf-8")
            with Env(env), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = mutant.install(WARDEN, user_dir)
            self.assertEqual(code, 0)
            self.assertNotEqual(foreign.read_text(encoding="utf-8"), "foreign\n")


if __name__ == "__main__":
    unittest.main()
