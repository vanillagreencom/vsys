"""Exercise the required inputs and failure propagation of the check contract."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CI = Path(__file__).with_name("ci.py").resolve()
sys.path.insert(0, str(CI.parent))
# The runner owns its own check list and artifact names; a second copy here
# would pass while the two drifted apart.
from ci import ARTIFACTS, CHECKS  # noqa: E402

emits = " ".join(ARTIFACTS)
# What the fixture suites and package check log, in the order ci.py runs them.
PRELUDE = ["scripts unittest", "warden unittest", "package check"]


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
            '  for name in ${CI_BUILD_EMITS}; do mkdir -p "${name%/*}"; printf x > "$name"; done\n'
            '  for name in ${CI_BUILD_EMPTY:-}; do mkdir -p "${name%/*}"; : > "$name"; done\n'
            "fi\n"
        )
        binary.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
            "CI_COMMAND_LOG": str(self.commands),
            "CI_FAIL_COMMAND": "",
            "CI_BUILD_EMITS": emits,
        }
        # Every suite the contract runs is present and passes. Each stand-in
        # logs one line and fails when CI_FAIL_COMMAND names it. No packaging/
        # is made: the real package check owns that directory, and ci.py must
        # run the check without looking for it.
        self.suite("scripts/ci_fixture_test.py", "scripts unittest")
        self.suite("warden/agent_warden_test.py", "warden unittest")
        (self.root / "scripts" / "package_file_list_check.py").write_text(
            "import os\n"
            "import sys\n"
            "with open(os.environ['CI_COMMAND_LOG'], 'a') as handle:\n"
            "    handle.write('package check\\n')\n"
            "if os.environ['CI_FAIL_COMMAND'] == 'package check':\n"
            "    sys.exit(29)\n"
        )

    def suite(self, path, line):
        test = self.root / path
        test.parent.mkdir(exist_ok=True)
        test.write_text(
            "import os\n"
            "import unittest\n"
            "class Fixture(unittest.TestCase):\n"
            "    def test_env(self):\n"
            "        with open(os.environ['CI_COMMAND_LOG'], 'a') as handle:\n"
            f"            handle.write('{line}\\n')\n"
            "        self.assertEqual(os.environ.get('PYTHONDONTWRITEBYTECODE'), '1')\n"
            f"        self.assertNotEqual(os.environ['CI_FAIL_COMMAND'], '{line}')\n"
        )

    def run_ci(self):
        return subprocess.run(
            [sys.executable, str(CI)], cwd=self.root, env=self.env,
            capture_output=True, text=True,
        )

    def assertRefused(self, result, line):
        """The run failed on the refusal whose key=value line is `line`, and
        the error annotation after it carries the refusal's prose."""
        self.assertNotEqual(result.returncode, 0)
        lines = result.stderr.splitlines()
        self.assertIn(line, lines)
        after = lines[lines.index(line) + 1:]
        self.assertTrue(after, result.stderr)
        annotation = after[0]
        self.assertTrue(annotation.startswith("::error::"), annotation)
        self.assertNotIn(annotation.partition(": ")[2], ("", line))

    def logged(self):
        return self.commands.read_text().splitlines() if self.commands.exists() else []

    def package(self, scripts=None):
        if scripts is None:
            scripts = {name: "fixture" for name in CHECKS}
        (self.root / "package.json").write_text(json.dumps({"scripts": scripts}))
        (self.root / "bun.lock").write_text("fixture")

    def test_missing_input_fails(self):
        # Each row renames one input of an otherwise complete tree; the log
        # shows how far the run got before it failed, and a row the runner
        # refuses itself names its refusal line.
        suite_missing = "suite=missing path=warden/agent_warden_test.py"
        rows = (
            ("scripts", [], None),
            # Discovery of a directory with no suite left in it fails too.
            ("scripts/ci_fixture_test.py", [], None),
            ("warden", [], suite_missing),
            # Discovery passes a warden tree that still holds another suite,
            # so only the named-file check stops this one.
            ("warden/agent_warden_test.py", [], suite_missing),
            ("package.json", PRELUDE, None),
        )
        self.suite("warden/neighbour_test.py", "warden neighbour")
        for path, expected, refusal in rows:
            with self.subTest(path=path):
                self.package()
                source = self.root / path
                renamed = source.with_name(source.name + ".renamed")
                source.rename(renamed)
                try:
                    result = self.run_ci()
                    self.assertNotEqual(result.returncode, 0)
                    if refusal is not None:
                        self.assertRefused(result, refusal)
                    self.assertEqual([line for line in self.logged() if line != "warden neighbour"], expected)
                finally:
                    renamed.rename(source)
                    self.commands.unlink(missing_ok=True)

    def test_contract_holds_the_required_checks_and_every_worker(self):
        # Every other expectation here is derived from these two. Dropping a
        # required check leaves the thing it gates unmeasured with the rest of
        # the suite green, and smoke reads the bundle build just wrote.
        required = {"lint", "typecheck", "test", "build", "smoke", "bench:scratch", "bench:writes"}
        self.assertLessEqual(required, set(CHECKS))
        self.assertLess(CHECKS.index("build"), CHECKS.index("smoke"))
        # Each worker thread is a bundle entry point of its own, found here
        # from the source tree rather than from a second list.
        source = CI.parents[1] / "src"
        workers = [path.relative_to(source).with_suffix(".js") for path in source.rglob("*-worker.ts")]
        self.assertGreater(len(workers), 0)
        self.assertLessEqual({"dist/main.js", *(f"dist/{path}" for path in workers)}, set(ARTIFACTS))

    def test_missing_or_empty_script_fails(self):
        for check in CHECKS:
            for value in (None, "", " ", False):
                with self.subTest(check=check, value=value):
                    scripts = {name: "fixture" for name in CHECKS}
                    scripts[check] = value
                    self.package(scripts)
                    # The named check is the only invalid entry, so a subtest
                    # that passes on another check's absence is not a pass.
                    self.assertRefused(self.run_ci(), f"script=missing check={check}")
                    self.assertEqual(self.logged(), PRELUDE)
                    self.commands.unlink()

    def test_missing_lockfile_fails(self):
        self.package()
        (self.root / "bun.lock").unlink()
        self.assertRefused(self.run_ci(), "lockfile=missing path=bun.lock")
        self.assertEqual(self.logged(), PRELUDE)

    def test_invalid_manifest_fails(self):
        for contents in ("{", "null", "[]", '{"scripts": []}'):
            with self.subTest(contents=contents):
                (self.root / "package.json").write_text(contents)
                self.assertNotEqual(self.run_ci().returncode, 0)
                self.assertEqual(self.logged(), PRELUDE)
                self.commands.unlink()

    def test_build_missing_an_entry_point_fails(self):
        # Each worker thread is a build output of its own. A build that emits
        # only the bundle passes every command it runs.
        for emitted in ARTIFACTS:
            with self.subTest(emitted=emitted):
                self.package()
                self.env["CI_BUILD_EMITS"] = emitted
                missing = next(
                    name for name in ARTIFACTS if name != emitted
                )
                self.assertRefused(self.run_ci(), f"artifact=missing path={missing}")
                self.commands.unlink()
        self.env["CI_BUILD_EMITS"] = emits

    def test_build_emitting_an_empty_entry_point_fails(self):
        # A build that writes an entry point and leaves it empty has shipped
        # nothing to run, though the file is there.
        for name in ARTIFACTS:
            with self.subTest(name=name):
                self.package()
                self.env["CI_BUILD_EMPTY"] = name
                self.assertRefused(self.run_ci(), f"artifact=empty path={name}")
                self.commands.unlink()
        del self.env["CI_BUILD_EMPTY"]

    def test_check_order_and_each_command_failure(self):
        commands = [*PRELUDE, "install --frozen-lockfile", *(f"run {check}" for check in CHECKS)]
        self.package()
        result = self.run_ci()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.logged(), commands)
        for index, command in enumerate(commands):
            with self.subTest(command=command):
                self.commands.unlink()
                self.env["CI_FAIL_COMMAND"] = command
                self.assertNotEqual(self.run_ci().returncode, 0)
                self.assertEqual(self.logged(), commands[:index + 1])


if __name__ == "__main__":
    unittest.main()
