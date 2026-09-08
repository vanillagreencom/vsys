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
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.commands = self.root / "commands"
        binary = self.root / "bun"
        binary.write_text(
            "#!/bin/sh\n"
            'printf "%s\\n" "$*" >> "$CI_COMMAND_LOG"\n'
            'if [ "$*" = "${CI_FAIL_COMMAND:-}" ]; then exit 23; fi\n'
        )
        binary.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
            "CI_COMMAND_LOG": str(self.commands),
            "CI_FAIL_COMMAND": "",
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

    def test_planning_tree_reports_no_application_checks(self):
        result = self.run_ci()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("application checks are not available", result.stdout)
        self.assertFalse(self.commands.exists())

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
