"""Exercise the planning boundary and failure propagation of application CI."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CI = Path(__file__).with_name("ci.py").resolve()


class ApplicationChecks(unittest.TestCase):
    def setUp(self):
        scratch_root = Path(__file__).resolve().parents[1] / "tmp" / "ci-tests"
        scratch_root.mkdir(parents=True, exist_ok=True)
        self.scratch = tempfile.TemporaryDirectory(dir=scratch_root)
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.commands = self.root / "commands"
        binary = self.root / "bun"
        binary.write_text(
            "#!/bin/sh\n"
            'printf "%s\\n" "$*" >> "$CI_COMMAND_LOG"\n'
            'if [ "$*" = "${CI_FAIL_COMMAND:-}" ]; then exit 23; fi\n'
            'if [ "$*" = "run build" ]; then\n'
            '  mkdir -p dist\n'
            '  for name in ${CI_BUILD_EMITS}; do printf x > "dist/$name"; done\n'
            "fi\n"
        )
        binary.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
            "CI_COMMAND_LOG": str(self.commands),
            "CI_FAIL_COMMAND": "",
            "CI_BUILD_EMITS": "main.js scratch-worker.js",
        }

    def run_ci(self):
        return subprocess.run(
            [sys.executable, str(CI)], cwd=self.root, env=self.env,
            capture_output=True, text=True,
        )

    def package(self, scripts=None):
        if scripts is None:
            scripts = {name: "fixture" for name in ("lint", "typecheck", "test", "build")}
        (self.root / "package.json").write_text(json.dumps({"scripts": scripts}))
        (self.root / "bun.lock").write_text("fixture")

    def make_packaging_check(self, exit_code=0):
        (self.root / "packaging").mkdir()
        scripts = self.root / "scripts"
        scripts.mkdir()
        check = scripts / "package_file_list_check.py"
        check.write_text(
            "import os\n"
            "import sys\n"
            "with open(os.environ['CI_COMMAND_LOG'], 'a') as handle:\n"
            "    handle.write('package check\\n')\n"
            f"sys.exit({exit_code})\n"
        )

    def test_planning_tree_reports_no_application_checks(self):
        result = self.run_ci()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("application checks are not available", result.stdout)
        self.assertFalse(self.commands.exists())

    def test_packaging_check_runs_when_packaging_exists(self):
        self.make_packaging_check()
        result = self.run_ci()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("application checks are not available", result.stdout)
        self.assertEqual(self.commands.read_text().splitlines(), ["package check"])

    def test_failing_packaging_check_fails_ci(self):
        self.make_packaging_check(exit_code=29)
        result = self.run_ci()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.commands.read_text().splitlines(), ["package check"])

    def test_application_without_manifest_fails(self):
        for path in ("src", "bun.lock"):
            with self.subTest(path=path):
                marker = self.root / path
                marker.touch()
                self.assertNotEqual(self.run_ci().returncode, 0)
                marker.unlink()

    def test_missing_or_empty_script_fails(self):
        for check in ("lint", "typecheck", "test", "build"):
            for value in (None, "", " ", False):
                with self.subTest(check=check, value=value):
                    scripts = {name: "fixture" for name in ("lint", "typecheck", "test", "build")}
                    scripts[check] = value
                    self.package(scripts)
                    self.assertNotEqual(self.run_ci().returncode, 0)
                    self.assertFalse(self.commands.exists())

    def test_missing_lockfile_fails(self):
        self.package()
        (self.root / "bun.lock").unlink()
        self.assertNotEqual(self.run_ci().returncode, 0)
        self.assertFalse(self.commands.exists())

    def test_invalid_manifest_fails(self):
        for contents in ("{", "null", "[]", '{"scripts": []}'):
            with self.subTest(contents=contents):
                (self.root / "package.json").write_text(contents)
                self.assertNotEqual(self.run_ci().returncode, 0)
                self.assertFalse(self.commands.exists())

    def make_warden(self, exit_code=0, test_fails=False):
        warden = self.root / "warden"
        warden.mkdir()
        script = warden / "agent-warden"
        script.write_text(
            "#!/usr/bin/env python3\n"
            "import os\n"
            "import sys\n"
            "with open(os.environ['CI_COMMAND_LOG'], 'a') as handle:\n"
            "    handle.write('warden ' + ' '.join(sys.argv[1:]) + '\\n')\n"
            f"sys.exit({exit_code})\n"
        )
        script.chmod(0o755)
        test = warden / "agent_warden_test.py"
        test.write_text(
            "import os\n"
            "import unittest\n"
            "class Fixture(unittest.TestCase):\n"
            "    def test_env(self):\n"
            "        with open(os.environ['CI_COMMAND_LOG'], 'a') as handle:\n"
            "            handle.write('warden unittest\\n')\n"
            "        self.assertEqual(os.environ.get('PYTHONDONTWRITEBYTECODE'), '1')\n"
            f"        self.assertFalse({test_fails!r})\n"
        )

    def test_warden_checks_run_when_warden_exists(self):
        self.package()
        self.make_warden()
        result = self.run_ci()
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = self.commands.read_text().splitlines()
        self.assertEqual(lines[:2], ["warden --selftest", "warden unittest"])
        self.assertEqual(lines[2:], ["install --frozen-lockfile", "run lint", "run typecheck", "run test", "run build"])

    def test_failing_warden_selftest_fails_ci(self):
        self.package()
        self.make_warden(exit_code=19)
        result = self.run_ci()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.commands.read_text().splitlines(), ["warden --selftest"])

    def test_failing_warden_unit_suite_fails_ci(self):
        self.package()
        self.make_warden(test_fails=True)
        result = self.run_ci()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.commands.read_text().splitlines(), ["warden --selftest", "warden unittest"])

    def test_warden_without_agent_warden_fails(self):
        self.package()
        (self.root / "warden").mkdir()
        self.assertNotEqual(self.run_ci().returncode, 0)
        self.assertFalse(self.commands.exists())

    def test_warden_without_test_file_fails(self):
        self.package()
        self.make_warden()
        (self.root / "warden" / "agent_warden_test.py").unlink()
        self.assertNotEqual(self.run_ci().returncode, 0)
        self.assertFalse(self.commands.exists())

    def test_build_missing_an_entry_point_fails(self):
        # The scratch scan thread is a build output of its own. A build that
        # emits only the bundle passes every command it runs.
        for emitted in ("main.js", "scratch-worker.js"):
            with self.subTest(emitted=emitted):
                self.package()
                self.env["CI_BUILD_EMITS"] = emitted
                result = self.run_ci()
                self.assertNotEqual(result.returncode, 0)
                missing = "scratch-worker.js" if emitted == "main.js" else "main.js"
                self.assertIn(f"The build emitted no dist/{missing}", result.stderr)
                self.commands.unlink()
        self.env["CI_BUILD_EMITS"] = "main.js scratch-worker.js"

    def test_check_order_and_each_command_failure(self):
        commands = ["install --frozen-lockfile", "run lint", "run typecheck", "run test", "run build"]
        self.package()
        result = self.run_ci()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.commands.read_text().splitlines(), commands)
        for index, command in enumerate(commands):
            with self.subTest(command=command):
                self.commands.unlink()
                self.env["CI_FAIL_COMMAND"] = command
                self.assertNotEqual(self.run_ci().returncode, 0)
                self.assertEqual(self.commands.read_text().splitlines(), commands[:index + 1])


if __name__ == "__main__":
    unittest.main()
