import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import unittest

from agent_warden_testlib import BASE_PATH, ROOT, clean_env, load_warden, scratch

sys.dont_write_bytecode = True


class AgentConfineRules(unittest.TestCase):
    def _confine_env(self, base, bin_dir):
        env = clean_env({
            "HOME": base / "home",
            "XDG_CACHE_HOME": base / "cache",
            "XDG_RUNTIME_DIR": base / "run",
            "PATH": str(bin_dir) + os.pathsep + BASE_PATH,
        })
        for key in ("HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"):
            Path(env[key]).mkdir(parents=True, exist_ok=True)
        return env

    def test_agent_confine_tmpdir_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            bin_dir = base / "bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "systemd-run").write_text("#!/bin/sh\nexit 1\n")
            (bin_dir / "systemctl").write_text("#!/bin/sh\nexit 99\n")
            (bin_dir / "grep").write_text("#!/bin/sh\nexit 1\n")
            for path in bin_dir.iterdir():
                path.chmod(0o755)
            env = self._confine_env(base, bin_dir)
            # A known inherited value, so a regression that cleared TMPDIR
            # instead of passing it through is distinguishable from the
            # correct behavior: an absent TMPDIR= line alone cannot tell the
            # two apart, since clean_env() never sets TMPDIR either.
            inherited = str(base / "inherited-tmp")
            Path(inherited).mkdir()
            env["TMPDIR"] = inherited
            result = subprocess.run([str(ROOT / "warden" / "agent-confine"), "env"], env=env, capture_output=True, text=True)
            default_tmpdir = str(Path(env["XDG_CACHE_HOME"]) / "agents" / "tmp")
            created = Path(default_tmpdir).is_dir()
        rows = [
            ("outside-slice branch succeeds with systemd-run unavailable", result.returncode, 0),
            # No scope is created here (no user manager), so TMPDIR stays whatever
            # was inherited rather than resetting to the shared parent (VSY-79).
            ("outside-slice branch passes its inherited TMPDIR through unchanged",
             f"TMPDIR={inherited}" in result.stdout.splitlines(), True),
            ("outside-slice branch creates no scratch directory", created, False),
        ]
        for name, actual, expected_value in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected_value)

    def test_agent_confine_tmpdir_nested_plain_lineage_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            bin_dir = base / "bin"
            bin_dir.mkdir(parents=True)
            launcher = base / "agent-confine"
            shutil.copy2(ROOT / "warden" / "agent-confine", launcher)
            helper = base / "agent-confine-lineage-capped"
            helper.write_text("#!/bin/sh\nexit 3\n")
            (bin_dir / "grep").write_text("#!/bin/sh\nexit 0\n")
            (bin_dir / "systemd-run").write_text("#!/bin/sh\nexit 1\n")
            (bin_dir / "systemctl").write_text("#!/bin/sh\nexit 99\n")
            for path in [launcher, helper, *bin_dir.iterdir()]:
                path.chmod(0o755)
            env = self._confine_env(base, bin_dir)
            inherited = str(base / "inherited-tmp")
            Path(inherited).mkdir()
            env["TMPDIR"] = inherited
            result = subprocess.run([str(launcher), "env"], env=env, capture_output=True, text=True)
            default_tmpdir = str(Path(env["XDG_CACHE_HOME"]) / "agents" / "tmp")
            created = Path(default_tmpdir).is_dir()
        rows = [
            ("nested plain-lineage branch succeeds with systemd-run unavailable", result.returncode, 0),
            # The lineage is plain (falls through) but systemd-run itself is
            # unavailable here, so this also lands in the no-new-scope fallback.
            ("nested plain-lineage branch passes its inherited TMPDIR through unchanged",
             f"TMPDIR={inherited}" in result.stdout.splitlines(), True),
            ("nested plain-lineage branch creates no scratch directory", created, False),
        ]
        for name, actual, expected_value in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected_value)

    def run_nested_launcher(self, status, launcher_text=None):
        with scratch() as tmp:
            base = Path(tmp)
            bin_dir = base / "bin"
            bin_dir.mkdir(parents=True)
            launcher = base / "agent-confine"
            if launcher_text is None:
                shutil.copy2(ROOT / "warden" / "agent-confine", launcher)
            else:
                launcher.write_text(launcher_text)
            helper = base / "agent-confine-lineage-capped"
            helper.write_text(f"#!/bin/sh\nexit {status}\n")
            log = base / "systemd-run.log"
            (bin_dir / "grep").write_text("#!/bin/sh\nexit 0\n")
            (bin_dir / "systemctl").write_text("#!/bin/sh\nexit 99\n")
            systemd_run = "\n".join([
                "#!/bin/sh",
                f"printf '%s\\n' \"$*\" >> {log}",
                'case " $* " in',
                '*" --unit=agent-confine-"*)',
                '  while [ $# -gt 0 ]; do',
                '    if [ "$1" = env ]; then shift; exec env "$@"; fi',
                '    shift',
                '  done',
                '  exit 99;;',
                '*) exit 0;;',
                'esac',
            ]) + "\n"
            (bin_dir / "systemd-run").write_text(systemd_run)
            for path in [launcher, helper, *bin_dir.iterdir()]:
                path.chmod(0o755)
            env = self._confine_env(base, bin_dir)
            inherited = str(base / "inherited-tmp")
            Path(inherited).mkdir()
            env["TMPDIR"] = inherited
            result = subprocess.run([str(launcher), "env"], env=env, capture_output=True, text=True)
            expected = str(Path(env["XDG_CACHE_HOME"]) / "agents" / "tmp")
            lines = log.read_text().splitlines() if log.exists() else []
            # Read before the scratch dir this `with` block owns is cleaned up.
            unit_match = re.search(r"--unit=(agent-confine-\d+-\d+)", lines[-1]) if lines else None
            scratch_created = unit_match is not None and Path(expected, unit_match.group(1)).is_dir()
        return result, expected, lines, scratch_created, inherited

    def test_agent_confine_nested_helper_statuses_launch(self):
        rows = [
            (1, 0),
            (3, 2),
        ]
        for status, systemd_runs in rows:
            with self.subTest(status=status):
                result, expected, lines, scratch_created, inherited = self.run_nested_launcher(status)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(lines), systemd_runs)
                out_lines = result.stdout.splitlines()
                if status == 3:
                    # A new sibling scope is created here, so this is the one
                    # path that sets TMPDIR, keyed to that scope's own --unit.
                    self.assertIn("--scope", lines[-1])
                    self.assertIn("-p CPUWeight=99", lines[-1])
                    self.assertIn("-p TasksMax=8192", lines[-1])
                    self.assertIn("-p MemoryHigh=64G", lines[-1])
                    unit_match = re.search(r"--unit=(agent-confine-\d+-\d+)", lines[-1])
                    self.assertIsNotNone(unit_match)
                    self.assertIn(f"TMPDIR={expected}/{unit_match.group(1)}", out_lines)
                    self.assertTrue(scratch_created)
                else:
                    # A capped (or unknown) lineage starts no new scope, so
                    # TMPDIR stays whatever the parent process already set it
                    # to for its own scope rather than resetting it (VSY-79).
                    # A known inherited value here (not just an absent
                    # TMPDIR=) catches a regression that clears it instead of
                    # passing it through.
                    self.assertIn(f"TMPDIR={inherited}", out_lines)

    def test_agent_confine_nested_status_three_mutant_fails(self):
        text = (ROOT / "warden" / "agent-confine").read_text()
        old = '3) : ;;'
        new = '3) exec env "${CAPS[@]}" "$@" ;;'
        self.assertEqual(text.count(old), 1)
        result, _expected, lines, scratch_created, inherited = self.run_nested_launcher(3, text.replace(old, new))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(len(lines), 2)
        # The mutant treats a plain (status 3) lineage as if it were capped, so
        # it never reaches the scope-creating exec and only passes through
        # whatever TMPDIR it inherited.
        self.assertIn(f"TMPDIR={inherited}", result.stdout.splitlines())
        self.assertFalse(scratch_created)

    def test_agent_confine_scratch_mkdir_failure_keeps_inherited_tmpdir(self):
        with scratch() as tmp:
            base = Path(tmp)
            bin_dir = base / "bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "grep").write_text("#!/bin/sh\nexit 1\n")
            (bin_dir / "systemctl").write_text("#!/bin/sh\nexit 99\n")
            systemd_run = "\n".join([
                "#!/bin/sh",
                'case " $* " in',
                '*" --unit=agent-confine-"*)',
                '  while [ $# -gt 0 ]; do',
                '    if [ "$1" = env ]; then shift; exec env "$@"; fi',
                '    shift',
                '  done',
                '  exit 99;;',
                '*) exit 0;;',
                'esac',
            ]) + "\n"
            (bin_dir / "systemd-run").write_text(systemd_run)
            for path in bin_dir.iterdir():
                path.chmod(0o755)
            env = self._confine_env(base, bin_dir)
            inherited = str(base / "inherited-tmp")
            Path(inherited).mkdir()
            env["TMPDIR"] = inherited
            default_tmpdir = Path(env["XDG_CACHE_HOME"]) / "agents" / "tmp"
            default_tmpdir.mkdir(parents=True)
            default_tmpdir.chmod(0o500)  # r-x: mkdir of the per-scope leaf fails
            try:
                result = subprocess.run([str(ROOT / "warden" / "agent-confine"), "env"], env=env, capture_output=True, text=True)
            finally:
                default_tmpdir.chmod(0o700)
        rows = [
            ("exits 0 even when the per-scope scratch directory cannot be created", result.returncode, 0),
            ("warns that TMPDIR is unavailable", "TMPDIR unavailable" in result.stderr, True),
            ("keeps the inherited TMPDIR when the per-scope directory could not be created",
             f"TMPDIR={inherited}" in result.stdout.splitlines(), True),
        ]
        for name, actual, expected_value in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected_value)

    def _run_collision_launcher(self, script_text, fixed_unit):
        with scratch() as tmp:
            base = Path(tmp)
            bin_dir = base / "bin"
            bin_dir.mkdir(parents=True)
            launcher = base / "agent-confine"
            launcher.write_text(script_text)
            (bin_dir / "grep").write_text("#!/bin/sh\nexit 1\n")
            (bin_dir / "systemctl").write_text("#!/bin/sh\nexit 99\n")
            systemd_run = "\n".join([
                "#!/bin/sh",
                'case " $* " in',
                '*" --unit=agent-confine-"*)',
                '  while [ $# -gt 0 ]; do',
                '    if [ "$1" = env ]; then shift; exec env "$@"; fi',
                '    shift',
                '  done',
                '  exit 99;;',
                '*) exit 0;;',
                'esac',
            ]) + "\n"
            (bin_dir / "systemd-run").write_text(systemd_run)
            for path in [launcher, *bin_dir.iterdir()]:
                path.chmod(0o755)
            env = self._confine_env(base, bin_dir)
            inherited = str(base / "inherited-tmp")
            Path(inherited).mkdir()
            env["TMPDIR"] = inherited
            default_tmpdir = str(Path(env["XDG_CACHE_HOME"]) / "agents" / "tmp")
            # Pre-create the exact scratch directory a second lane with this
            # fixed unit name would land in, as if an earlier lane still owns
            # it (a $$/$RANDOM collision) or left it behind.
            colliding = Path(default_tmpdir, fixed_unit)
            colliding.mkdir(parents=True)
            marker = colliding / "marker"
            marker.write_text("pre-existing lane's scratch")
            result = subprocess.run([str(launcher), "env"], env=env, capture_output=True, text=True)
            marker_untouched = marker.exists() and marker.read_text() == "pre-existing lane's scratch"
        return result, inherited, default_tmpdir, marker_untouched

    def test_agent_confine_scratch_collision_keeps_inherited_tmpdir(self):
        text = (ROOT / "warden" / "agent-confine").read_text()
        unit_old = 'agent_confine_unit="agent-confine-$$-${RANDOM}"'
        self.assertEqual(text.count(unit_old), 1)
        fixed_unit = "agent-confine-900-111"
        deterministic = text.replace(unit_old, f'agent_confine_unit="{fixed_unit}"')
        result, inherited, _default_tmpdir, marker_untouched = self._run_collision_launcher(deterministic, fixed_unit)
        rows = [
            ("exits 0 even with a scratch-directory name collision", result.returncode, 0),
            ("warns that TMPDIR is unavailable", "TMPDIR unavailable" in result.stderr, True),
            ("keeps the inherited TMPDIR instead of the colliding directory",
             f"TMPDIR={inherited}" in result.stdout.splitlines(), True),
            ("the pre-existing lane's marker file is untouched", marker_untouched, True),
        ]
        for name, actual, expected_value in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected_value)

    def test_agent_confine_scratch_collision_mutant_fails(self):
        text = (ROOT / "warden" / "agent-confine").read_text()
        mkdir_old = 'mkdir -m 700 -- "$agent_confine_scratch"'
        self.assertEqual(text.count(mkdir_old), 1)
        mutated = text.replace(mkdir_old, 'mkdir -p -m 700 -- "$agent_confine_scratch"')
        unit_old = 'agent_confine_unit="agent-confine-$$-${RANDOM}"'
        self.assertEqual(mutated.count(unit_old), 1)
        fixed_unit = "agent-confine-900-111"
        deterministic = mutated.replace(unit_old, f'agent_confine_unit="{fixed_unit}"')
        result, _inherited, default_tmpdir, _marker_untouched = self._run_collision_launcher(deterministic, fixed_unit)
        # With -p restored, the mkdir succeeds silently on the pre-existing
        # directory instead of refusing: the mutant hands this lane another
        # lane's scratch directory as its own TMPDIR.
        self.assertIn(f"TMPDIR={default_tmpdir}/{fixed_unit}", result.stdout.splitlines())

    def test_agent_confine_and_warden_scratch_parent_agree(self):
        # agent-confine (bash) and agent-warden (python) each compute the
        # default scratch-parent path independently. Comparing their actual
        # runtime outputs under the same environment, rather than pinning
        # each formula against a separately hand-written expected string,
        # catches a future edit to one formula alone.
        with scratch() as tmp:
            base = Path(tmp)
            bin_dir = base / "bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "grep").write_text("#!/bin/sh\nexit 1\n")
            (bin_dir / "systemctl").write_text("#!/bin/sh\nexit 99\n")
            systemd_run = "\n".join([
                "#!/bin/sh",
                'case " $* " in',
                '*" --unit=agent-confine-"*)',
                '  while [ $# -gt 0 ]; do',
                '    if [ "$1" = env ]; then shift; exec env "$@"; fi',
                '    shift',
                '  done',
                '  exit 99;;',
                '*) exit 0;;',
                'esac',
            ]) + "\n"
            (bin_dir / "systemd-run").write_text(systemd_run)
            for path in bin_dir.iterdir():
                path.chmod(0o755)
            env = self._confine_env(base, bin_dir)
            result = subprocess.run([str(ROOT / "warden" / "agent-confine"), "env"], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            tmpdir_line = next((line for line in result.stdout.splitlines() if line.startswith("TMPDIR=")), None)
            self.assertIsNotNone(tmpdir_line)
            emitted_parent = tmpdir_line[len("TMPDIR="):].rsplit("/", 1)[0]
            warden_for_env = load_warden(dict(env), "agent_warden_scratch_parity")
        self.assertEqual(emitted_parent, warden_for_env.AGENT_TMPDIR_PARENT)

    def test_agent_confine_two_lanes_get_independent_scratch(self):
        with scratch() as tmp:
            base = Path(tmp)
            bin_dir = base / "bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "grep").write_text("#!/bin/sh\nexit 1\n")
            (bin_dir / "systemctl").write_text("#!/bin/sh\nexit 99\n")
            systemd_run = "\n".join([
                "#!/bin/sh",
                'case " $* " in',
                '*" --unit=agent-confine-"*)',
                '  while [ $# -gt 0 ]; do',
                '    if [ "$1" = env ]; then shift; exec env "$@"; fi',
                '    shift',
                '  done',
                '  exit 99;;',
                '*) exit 0;;',
                'esac',
            ]) + "\n"
            (bin_dir / "systemd-run").write_text(systemd_run)
            for path in bin_dir.iterdir():
                path.chmod(0o755)
            env = self._confine_env(base, bin_dir)
            launcher = str(ROOT / "warden" / "agent-confine")

            def tmpdir_of(result):
                for line in result.stdout.splitlines():
                    if line.startswith("TMPDIR="):
                        return line[len("TMPDIR="):]
                return None

            first = subprocess.run([launcher, "env"], env=env, capture_output=True, text=True)
            second = subprocess.run([launcher, "env"], env=env, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            first_tmpdir, second_tmpdir = tmpdir_of(first), tmpdir_of(second)
            default_tmpdir = str(Path(env["XDG_CACHE_HOME"]) / "agents" / "tmp")
            rows = [
                ("first lane's TMPDIR is a subdirectory under AGENT_TMPDIR",
                 first_tmpdir is not None and first_tmpdir.startswith(default_tmpdir + "/"), True),
                ("second lane's TMPDIR is a subdirectory under AGENT_TMPDIR",
                 second_tmpdir is not None and second_tmpdir.startswith(default_tmpdir + "/"), True),
                ("the two lanes read different TMPDIRs under AGENT_TMPDIR", first_tmpdir != second_tmpdir, True),
            ]
            for name, actual, expected in rows:
                with self.subTest(name=name):
                    self.assertEqual(actual, expected)
            (Path(first_tmpdir) / "first-file").write_text("first")
            (Path(second_tmpdir) / "second-file").write_text("second")
            # rm -rf "$TMPDIR" in one agent leaves the other agent's files (VSY-79).
            shutil.rmtree(first_tmpdir)
            self.assertFalse(Path(first_tmpdir).exists())
            self.assertTrue((Path(second_tmpdir) / "second-file").is_file())

    def test_agent_confine_nested_capped_keeps_parents_tmpdir(self):
        with scratch() as tmp:
            base = Path(tmp)
            bin_dir = base / "bin"
            bin_dir.mkdir(parents=True)
            launcher = base / "agent-confine"
            shutil.copy2(ROOT / "warden" / "agent-confine", launcher)
            helper = base / "agent-confine-lineage-capped"
            helper.write_text("#!/bin/sh\nexit 0\n")  # capped lineage
            (bin_dir / "grep").write_text("#!/bin/sh\nexit 0\n")  # already inside agents.slice
            (bin_dir / "systemd-run").write_text("#!/bin/sh\nexit 1\n")  # must never run
            (bin_dir / "systemctl").write_text("#!/bin/sh\nexit 99\n")
            for path in [launcher, helper, *bin_dir.iterdir()]:
                path.chmod(0o755)
            env = self._confine_env(base, bin_dir)
            parents_scratch = base / "scratch" / "agent-confine-900-111"
            parents_scratch.mkdir(parents=True)
            env["TMPDIR"] = str(parents_scratch)
            result = subprocess.run([str(launcher), "env"], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"TMPDIR={parents_scratch}", result.stdout.splitlines())

    def test_agent_confine_systemd_run_uses_cpu_weight_99(self):
        with scratch() as tmp:
            base = Path(tmp)
            bin_dir = base / "bin"
            bin_dir.mkdir(parents=True)
            log = base / "systemd-run.log"
            (bin_dir / "grep").write_text("#!/bin/sh\nexit 1\n")
            (bin_dir / "systemctl").write_text("#!/bin/sh\nexit 99\n")
            (bin_dir / "systemd-run").write_text(
                "#!/bin/sh\n"
                f"printf '%s\\n' \"$*\" >> {log}\n"
                "exit 0\n"
            )
            for path in bin_dir.iterdir():
                path.chmod(0o755)
            env = self._confine_env(base, bin_dir)
            result = subprocess.run([str(ROOT / "warden" / "agent-confine"), "echo", "ok"], env=env, capture_output=True, text=True)
            lines = log.read_text().splitlines()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreaterEqual(len(lines), 2)
        self.assertIn("-p CPUWeight=99", lines[-1])


if __name__ == "__main__":
    unittest.main()
