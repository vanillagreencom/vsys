import json
import os
from pathlib import Path
import random
import re
import resource
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_warden_testlib import WARDEN, WardenRulesCase, load_warden, materialize_warden_script, scratch

sys.dont_write_bytecode = True

# A pid standing in for a live process whose /proc reads a test fakes: this
# test process, so the reaper's /proc/<pid> check finds it running.
LIVE = os.getpid()
# Above the largest pid_max the kernel allows (2**22), so no process has it.
GONE = 2**22 + 1


class AgentWardenScratchRules(WardenRulesCase):
    def test_current_directory_guard_mutants_fail(self):
        text = WARDEN.read_text()
        rows = [
            ("membership", 'cwd = os.readlink(f"/proc/{pid}/cwd")', 'cwd = "/unrelated"', "in-use"),
            ("unreadable", "if (tmpdir is None or cwd is None) and", "if tmpdir is None and", "unknown"),
        ]
        worker = self.P(LIVE, 1, "bun", ["bun"], cg=self._cg("agent-warden-1-2.scope"))
        for name, old, replacement, expected in rows:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                self.assertEqual(text.count(old), 1)
                path = materialize_warden_script(Path(tmp), text.replace(old, replacement))
                mutant = load_warden(self.env, f"agent_warden_mutant_cwd_{name}", path)
                with patch.object(mutant, "_proc_tmpdir", return_value=""), \
                        patch.object(mutant.os, "readlink", return_value=tmp,
                                     side_effect=PermissionError("cwd unreadable") if expected == "unknown" else None):
                    with self.assertRaises(AssertionError):
                        self.assertEqual(mutant._scratch_in_use(tmp, mutant._scratch_holders({LIVE: worker})), expected)

    def test_worker_current_directory_keeps_scratch(self):
        rows = [
            ("same", "", "{lane}", "in-use"),
            ("descendant", "", "{lane}/work", "in-use"),
            ("sibling", "", "{lane}0", "free"),
            ("unreadable", "", None, "unknown"),
            ("cwd confirms unreadable environment", None, "{lane}", "in-use"),
            ("tmpdir confirms unreadable cwd", "{lane}", None, "in-use"),
        ]
        worker = self.P(LIVE, 1, "bun", ["bun"], cg=self._cg("worker.scope"))
        for name, tmpdir, cwd, status in rows:
            with self.subTest(name=name), scratch() as tmp:
                base = Path(tmp)
                (base / "cg" / self.w.SLICE / "worker.scope").mkdir(parents=True)
                lane = base / "scratch" / "agent-confine-300-400"
                (lane / "work").mkdir(parents=True)
                os.utime(lane, (0, 0))
                environ = None if tmpdir is None else f"TMPDIR={tmpdir.format(lane=lane)}\0"
                cwd = None if cwd is None else cwd.format(lane=lane)
                real_read = self.w.read

                def read(path, default=None):
                    return environ if str(path) == f"/proc/{LIVE}/environ" else real_read(path, default)

                with patch.object(self.w, "CG_ROOT", base / "cg"), \
                        patch.object(self.w, "AGENT_TMPDIR_PARENT", str(base / "scratch")), \
                        patch.object(self.w, "read", side_effect=read), patch.object(self.w, "log"), \
                        patch.object(self.w.os, "readlink", return_value=cwd,
                                     side_effect=PermissionError("cwd unreadable") if cwd is None else None), \
                        patch.object(self.w.shutil, "rmtree") as remove:
                    self.assertEqual(self.w._scratch_in_use(str(lane), self.w._scratch_holders({LIVE: worker})), status)
                    removed = self.w.reap_scratch_dirs(True, {LIVE: worker}, set())
                if status == "free":
                    remove.assert_called_once()
                    self.assertEqual(removed, [lane.name])
                else:
                    remove.assert_not_called()
                    self.assertEqual(removed, [])

    def test_reap_scratch_dirs_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            old_cg, old_parent = self.w.CG_ROOT, self.w.AGENT_TMPDIR_PARENT
            self.w.CG_ROOT = base / "cg"
            self.w.AGENT_TMPDIR_PARENT = str(base / "scratch")
            try:
                agent_slice = self.w.CG_ROOT / self.w.SLICE
                agent_slice.mkdir(parents=True)
                (agent_slice / "agent-confine-100-200.scope").mkdir()
                scratch_dir = Path(self.w.AGENT_TMPDIR_PARENT)
                scratch_dir.mkdir(parents=True)
                live = scratch_dir / "agent-confine-100-200"
                live.mkdir()
                (live / "f").write_text("x")
                gone = scratch_dir / "agent-confine-300-400"
                gone.mkdir()
                (gone / "f").write_text("x")
                old = time.time() - self.w.SCRATCH_GRACE - 1
                os.utime(gone, (old, old))
                unrelated = scratch_dir / "not-a-scope-dir"
                unrelated.mkdir()
                logs = []
                old_log = self.w.log
                self.w.log = logs.append
                try:
                    self.assertEqual(self.w.reap_scratch_dirs(False, {}, set()), [])
                finally:
                    self.w.log = old_log
                report_rows = [
                    ("report mode removes nothing", [live.is_dir(), gone.is_dir(), unrelated.is_dir()], [True, True, True]),
                    ("report mode logs the gone scope", any("agent-confine-300-400" in line and "would remove" in line for line in logs), True),
                    ("report mode never logs the live scope", any("agent-confine-100-200" in line for line in logs), False),
                ]
                for name, actual, expected in report_rows:
                    with self.subTest(name=name):
                        self.assertEqual(actual, expected)
                removed = self.w.reap_scratch_dirs(True, {}, set())
                correct_rows = [
                    ("a live scope's directory survives", live.is_dir(), True),
                    ("a gone scope's directory is removed", gone.exists(), False),
                    ("an unrelated directory is left alone", unrelated.is_dir(), True),
                    ("removed reports the gone scope only", removed, ["agent-confine-300-400"]),
                ]
                for name, actual, expected in correct_rows:
                    with self.subTest(name=name):
                        self.assertEqual(actual, expected)
            finally:
                self.w.CG_ROOT, self.w.AGENT_TMPDIR_PARENT = old_cg, old_parent

    def _reap_failing_twice(self, w):
        """Two run() ticks over a gone scope's folder whose removal keeps
        failing. Each tick opens and closes State, so only state.json carries
        the logged failure from the first tick to the second, as it does
        between the timer's oneshot runs."""
        with scratch() as tmp:
            base = Path(tmp)
            old_state = self.point_status_state(w, base)
            old_parent = w.AGENT_TMPDIR_PARENT
            w.AGENT_TMPDIR_PARENT = str(base / "scratch")
            try:
                (w.CG_ROOT / w.SLICE).mkdir(parents=True)
                scratch_dir = Path(w.AGENT_TMPDIR_PARENT)
                scratch_dir.mkdir(parents=True)
                fails = scratch_dir / "agent-confine-500-600"
                fails.mkdir()
                also_gone = scratch_dir / "agent-confine-700-800"
                also_gone.mkdir()
                old = time.time() - w.SCRATCH_GRACE - 1
                os.utime(fails, (old, old))
                os.utime(also_gone, (old, old))
                logs = []
                stubbed = ("log", "scan", "plan", "reap_orphans", "enforce_task_caps", "warn_near_cap")
                saved = {name: getattr(w, name) for name in stubbed}
                old_rmtree = w.shutil.rmtree

                def flaky_rmtree(path, *a, **kw):
                    if str(path) == str(fails):
                        raise OSError("boom")
                    return old_rmtree(path, *a, **kw)

                w.log = logs.append
                w.scan = lambda: {}
                w.plan = lambda procs, only=None: ([], [], [], [])
                w.reap_orphans = lambda procs, st, correct, only=None: ([], [])
                w.enforce_task_caps = lambda correct: []
                w.warn_near_cap = lambda: ([], set(), True)
                w.shutil.rmtree = flaky_rmtree
                try:
                    exits = [w.run(True), w.run(True)]
                finally:
                    for name, value in saved.items():
                        setattr(w, name, value)
                    w.shutil.rmtree = old_rmtree
                persisted = json.loads(w.STATE.read_text())["scratch_failed"]
                return (exits, fails.is_dir(), also_gone.exists(), persisted,
                        sum("name=agent-confine-500-600" in line for line in logs))
            finally:
                w.AGENT_TMPDIR_PARENT = old_parent
                self.restore_status_state(w, old_state)

    def test_reap_scratch_dirs_rmtree_failure_rows(self):
        # The failing folder survives, the other gone scope is still removed,
        # and the failure is logged once over two ticks. With the once-only
        # guard removed, or with run() no longer writing the logged names
        # back to the state file, it is logged at every tick.
        text = WARDEN.read_text()
        guard = "            if name not in failed:\n"
        writeback = "                st[\"scratch_failed\"] = sorted(scratch_failed)\n"
        for line in (guard, writeback):
            self.assertEqual(text.count(line), 1)
        no_guard = self.load_mutant(text.replace(guard, "            if True:\n"), "agent_warden_mutant_scratch_log_once")
        no_writeback = self.load_mutant(text.replace(writeback, ""), "agent_warden_mutant_scratch_writeback")
        rows = [
            ("the warden logs the failure once", self.w, ["agent-confine-500-600"], 1),
            ("with the guard removed it logs at every tick", no_guard, ["agent-confine-500-600"], 2),
            ("with the state writeback removed it logs at every tick", no_writeback, [], 2),
        ]
        for name, w, persisted, logged in rows:
            with self.subTest(name=name):
                self.assertEqual(self._reap_failing_twice(w), ([0, 0], True, False, persisted, logged))

    def _reap_read_only(self, w):
        """Reap a gone scope's folder holding a mode-555 directory, as an
        agent's tui-fixtures leave it."""
        with scratch() as tmp:
            base = Path(tmp)
            old_cg, old_parent = w.CG_ROOT, w.AGENT_TMPDIR_PARENT
            w.CG_ROOT = base / "cg"
            w.AGENT_TMPDIR_PARENT = str(base / "scratch")
            try:
                (w.CG_ROOT / w.SLICE).mkdir(parents=True)
                gone = Path(w.AGENT_TMPDIR_PARENT) / "agent-confine-300-400"
                updates = gone / "vgsh-smoke.x" / "tui-fixtures" / "vgs.updates"
                updates.mkdir(parents=True)
                (updates / "f").write_text("x")
                updates.chmod(0o555)
                old = time.time() - w.SCRATCH_GRACE - 1
                os.utime(gone, (old, old))
                failed = set()
                removed = w.reap_scratch_dirs(True, {}, failed)
                return removed, gone.exists(), failed
            finally:
                w.CG_ROOT, w.AGENT_TMPDIR_PARENT = old_cg, old_parent

    def test_reap_scratch_dirs_read_only_directory_rows(self):
        text = WARDEN.read_text()
        retry = "        os.chmod(parent, stat.S_IMODE(st.st_mode) | stat.S_IRWXU)\n        func(path)\n"
        self.assertEqual(text.count(retry), 1)
        mutant = self.load_mutant(text.replace(retry, "        raise exc\n"), "agent_warden_mutant_scratch_read_only")
        rows = [
            ("the reaper removes the folder", self.w, (["agent-confine-300-400"], False, set())),
            ("with the retry removed the folder stays", mutant, ([], True, {"agent-confine-300-400"})),
        ]
        for name, w, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(self._reap_read_only(w), expected)

    def test_reap_scratch_dirs_liveness_mutant_fails(self):
        text = WARDEN.read_text()
        old = '        if f"{name}.scope" in live_units:\n            continue\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, ""), "agent_warden_mutant_scratch_liveness")
        with scratch() as tmp:
            base = Path(tmp)
            old_cg, old_parent = mutant.CG_ROOT, mutant.AGENT_TMPDIR_PARENT
            mutant.CG_ROOT = base / "cg"
            mutant.AGENT_TMPDIR_PARENT = str(base / "scratch")
            try:
                agent_slice = mutant.CG_ROOT / mutant.SLICE
                agent_slice.mkdir(parents=True)
                (agent_slice / "agent-confine-100-200.scope").mkdir()
                scratch_dir = Path(mutant.AGENT_TMPDIR_PARENT)
                scratch_dir.mkdir(parents=True)
                live = scratch_dir / "agent-confine-100-200"
                live.mkdir()
                old_mtime = time.time() - mutant.SCRATCH_GRACE - 1
                os.utime(live, (old_mtime, old_mtime))
                mutant.reap_scratch_dirs(True, {}, set())
                self.assertFalse(live.is_dir())
            finally:
                mutant.CG_ROOT, mutant.AGENT_TMPDIR_PARENT = old_cg, old_parent

    def test_reap_scratch_dirs_grace_protects_startup_race(self):
        # agent-confine creates the scratch directory, then execs systemd-run
        # to register the scope; a tick landing between those two steps sees
        # no matching scope yet. A freshly-created directory must survive one
        # reap tick regardless of scope_units(), not just when its scope
        # happens to already be registered.
        with scratch() as tmp:
            base = Path(tmp)
            old_cg, old_parent = self.w.CG_ROOT, self.w.AGENT_TMPDIR_PARENT
            self.w.CG_ROOT = base / "cg"
            self.w.AGENT_TMPDIR_PARENT = str(base / "scratch")
            try:
                agent_slice = self.w.CG_ROOT / self.w.SLICE
                agent_slice.mkdir(parents=True)
                scratch_dir = Path(self.w.AGENT_TMPDIR_PARENT)
                scratch_dir.mkdir(parents=True)
                fresh = scratch_dir / "agent-confine-900-111"
                fresh.mkdir()  # no matching scope yet, and not backdated
                removed = self.w.reap_scratch_dirs(True, {}, set())
                self.assertTrue(fresh.is_dir())
                self.assertEqual(removed, [])
            finally:
                self.w.CG_ROOT, self.w.AGENT_TMPDIR_PARENT = old_cg, old_parent

    def test_reap_scratch_dirs_grace_mutant_fails(self):
        text = WARDEN.read_text()
        old = "        if age < SCRATCH_GRACE:\n"
        self.assertEqual(text.count(old), 1)
        new = "        if False:\n"
        mutant = self.load_mutant(text.replace(old, new), "agent_warden_mutant_scratch_grace")
        with scratch() as tmp:
            base = Path(tmp)
            old_cg, old_parent = mutant.CG_ROOT, mutant.AGENT_TMPDIR_PARENT
            mutant.CG_ROOT = base / "cg"
            mutant.AGENT_TMPDIR_PARENT = str(base / "scratch")
            try:
                agent_slice = mutant.CG_ROOT / mutant.SLICE
                agent_slice.mkdir(parents=True)
                scratch_dir = Path(mutant.AGENT_TMPDIR_PARENT)
                scratch_dir.mkdir(parents=True)
                fresh = scratch_dir / "agent-confine-900-111"
                fresh.mkdir()
                mutant.reap_scratch_dirs(True, {}, set())
                self.assertFalse(fresh.is_dir())
            finally:
                mutant.CG_ROOT, mutant.AGENT_TMPDIR_PARENT = old_cg, old_parent

    def test_reap_scratch_dirs_refuses_on_unreadable_scope_list(self):
        # scope_units() failing to list agents.slice at all must never read as
        # "every scope is gone": that would delete every live lane's scratch
        # through the exact cross-lane destruction this issue fixes.
        with scratch() as tmp:
            base = Path(tmp)
            old_cg, old_parent = self.w.CG_ROOT, self.w.AGENT_TMPDIR_PARENT
            # CG_ROOT / SLICE itself does not exist, so base.iterdir() raises
            # FileNotFoundError (an OSError subclass): scope_units() returns
            # None rather than treating a missing directory as an empty one.
            self.w.CG_ROOT = base / "cg-missing"
            self.w.AGENT_TMPDIR_PARENT = str(base / "scratch")
            try:
                scratch_dir = Path(self.w.AGENT_TMPDIR_PARENT)
                scratch_dir.mkdir(parents=True)
                live = scratch_dir / "agent-confine-900-111"
                live.mkdir()
                old_mtime = time.time() - self.w.SCRATCH_GRACE - 1
                os.utime(live, (old_mtime, old_mtime))
                logs = []
                old_log = self.w.log
                self.w.log = logs.append
                try:
                    self.assertIsNone(self.w.scope_units())
                    removed = self.w.reap_scratch_dirs(True, {}, set())
                finally:
                    self.w.log = old_log
                self.assertEqual(removed, [])
                self.assertTrue(live.is_dir())
                self.assertTrue(any("unreadable" in line for line in logs))
            finally:
                self.w.CG_ROOT, self.w.AGENT_TMPDIR_PARENT = old_cg, old_parent

    def test_reap_scratch_dirs_fail_open_mutant_fails(self):
        text = WARDEN.read_text()
        old = (
            "    live_units = scope_units()\n"
            "    if live_units is None:\n"
            "        log(\"scratch reap: agents.slice scope list unreadable; not reaping this tick\")\n"
            "        return []\n"
            "    live_units = set(live_units)\n"
        )
        self.assertEqual(text.count(old), 1)
        new = "    live_units = set(scope_units() or {})\n"
        mutant = self.load_mutant(text.replace(old, new), "agent_warden_mutant_scratch_fail_open")
        with scratch() as tmp:
            base = Path(tmp)
            old_cg, old_parent = mutant.CG_ROOT, mutant.AGENT_TMPDIR_PARENT
            mutant.CG_ROOT = base / "cg-missing"
            mutant.AGENT_TMPDIR_PARENT = str(base / "scratch")
            try:
                scratch_dir = Path(mutant.AGENT_TMPDIR_PARENT)
                scratch_dir.mkdir(parents=True)
                live = scratch_dir / "agent-confine-900-111"
                live.mkdir()
                old_mtime = time.time() - mutant.SCRATCH_GRACE - 1
                os.utime(live, (old_mtime, old_mtime))
                mutant.reap_scratch_dirs(True, {}, set())
                self.assertFalse(live.is_dir())
            finally:
                mutant.CG_ROOT, mutant.AGENT_TMPDIR_PARENT = old_cg, old_parent

    def _zombie(self):
        """A real child that has exited and is not yet reaped, as a short
        job in agents.slice is between its exit and its parent's wait."""
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        self.addCleanup(proc.wait)
        deadline = time.monotonic() + 5
        while self.w.read(f"/proc/{proc.pid}/stat", "").rpartition(")")[2].split()[:1] != ["Z"]:
            if time.monotonic() >= deadline:
                self.fail("the child did not exit in time")
            time.sleep(0.01)
        return proc.pid

    def test_reap_scratch_dirs_tmpdir_liveness_rows(self):
        # move() (the "nested session" plan() branch) relocates a process's
        # cgroup membership only; it never rewrites TMPDIR. A moved child can
        # still be using a scratch directory after the parent scope it was
        # created under is gone and garbage-collected. Each row is one
        # snapshot of live pids with their environ (None: unreadable, as a
        # non-dumpable program's is even to its own user) and the scopes
        # still live under agents.slice. The sibling row proves the match
        # needs a separator: "agent-confine-100-2000" is not inside
        # "agent-confine-100-200". The doubled-separator row proves the match
        # survives a trailing slash on AGENT_TMPDIR, which agent-confine's
        # bash concatenation ("$AGENT_EFFECTIVE_TMPDIR/$unit") doubles while
        # os.path.join (this candidate path's source) never does. An
        # unreadable process is ignored only in a desktop unit: init.scope,
        # or an app.slice unit that is neither a systemd-run transient
        # (run-*) nor a contained job unit. Every other one counts, a live
        # lane scope whose own folder exists included: the launcher keeps the
        # inherited TMPDIR when its mkdir meets a folder of the same name,
        # and every launch keeps the inherited current directory. The
        # unreadable process in a row that tests its unit is LIVE, so it
        # never reads as exited. A row's optional last field lists the pids
        # whose current directory cannot be read.
        user = "/user.slice/user-1000.slice/user@1000.service"
        desktop = [("systemd", f"{user}/init.scope"),
                   ("ssh-agent", f"{user}/app.slice/ssh-agent.service"),
                   ("gpg-agent", f"{user}/app.slice/gpg-agent.service"),
                   ("1Password-Brows", f"{user}/app.slice/app-org.chromium.Chromium-9.scope"),
                   ("Hyprland-app", f"{user}/app.slice/app-graphical.slice/app-foot-7.scope")]
        undesktop = [("a raw systemd-run scope in app.slice", f"{user}/app.slice/run-u42.scope"),
                     ("a systemd-run service in app.slice", f"{user}/app.slice/run-u43.service"),
                     ("a login session scope", "/user.slice/user-1000.slice/session-2.scope"),
                     ("app.slice with no unit", f"{user}/app.slice"),
                     ("the root cgroup", "/")]
        job = f"{user}/app.slice/orch-validate.service"
        nested = f"{user}/agents.slice/agent-warden-555-1.scope"
        build = f"{user}/agents.slice/agent-warden-build-555-1.scope"
        other = f"{user}/agents.slice/agent-confine-300-400.scope"
        manager = (700, 1, "systemd", f"{user}/init.scope", None)
        zombie = self._zombie()
        rows = [
            ("a live process's TMPDIR resolves here",
             [(555, 1, "bash", nested, "TMPDIR={moved}")], [], [], "in-use"),
            ("a live process's TMPDIR names an unrelated sibling",
             [(555, 1, "bash", nested, "TMPDIR={moved}0")], [], [], "free"),
            ("a live process's TMPDIR has a doubled separator",
             [(555, 1, "bash", nested, "TMPDIR={scratch}//agent-confine-100-200")], [], [], "in-use"),
            ("a live process's TMPDIR follows other keys ending in TMPDIR",
             [(555, 1, "bash", nested, "AGENT_TMPDIR={scratch}\0TMUX_TMPDIR=/tmp\0TMPDIR={moved}")], [], [], "in-use"),
            *((f"an unreadable {comm} in its desktop unit",
               [(LIVE, 1, comm, cg, None)], [], [], "free") for comm, cg in desktop),
            *((f"an unreadable worker in {kind}",
               [(LIVE, 1, "bun", cg, None)], [], [], "unknown") for kind, cg in undesktop),
            ("an unreadable process in a contained job unit outside agents.slice",
             [manager, (LIVE, 700, "op", job, None)], [], [], "unknown"),
            ("an unreadable child of an agent shell whose TMPDIR names it",
             [(556, 555, "op", nested, None), (555, 1, "bash", nested, "TMPDIR={moved}")], [], [], "in-use"),
            ("an unreadable process in a live lane scope with its same-name folder, whose TMPDIR the "
             "launcher's collision fallback inherited",
             [manager, (LIVE, 700, "op", other, None)], ["agent-confine-300-400.scope"],
             ["agent-confine-300-400"], "unknown"),
            ("an unreadable current directory in a live lane scope with its own folder as TMPDIR",
             [manager, (LIVE, 700, "op", other, "TMPDIR={scratch}/agent-confine-300-400")],
             ["agent-confine-300-400.scope"], ["agent-confine-300-400"], "unknown", {LIVE}),
            ("an orphaned unreadable daemon in another live lane scope with no folder",
             [manager, (LIVE, 700, "op", other, None)], ["agent-confine-300-400.scope"], [], "unknown"),
            ("an unreadable child alone in a moved scope whose agent parents are gone",
             [manager, (LIVE, 700, "op", nested, None)], [], [], "unknown"),
            ("an unreadable process in a moved scope that has exited since the scan",
             [manager, (GONE, 700, "op", nested, None)], [], [], "free"),
            ("an unreadable zombie in a moved scope",
             [manager, (zombie, 700, "bash", nested, None)], [], [], "free"),
            ("an unreadable child alone in a moved build scope whose agent parents are gone",
             [manager, (LIVE, 700, "op", build, None)], [], [], "unknown"),
        ]
        for name, members, live_scopes, folders, status, *unread_cwd in rows:
            with self.subTest(name=name):
                with scratch() as tmp:
                    base = Path(tmp)
                    old_cg, old_parent = self.w.CG_ROOT, self.w.AGENT_TMPDIR_PARENT
                    self.w.CG_ROOT = base / "cg"
                    self.w.AGENT_TMPDIR_PARENT = str(base / "scratch")
                    try:
                        agent_slice = self.w.CG_ROOT / self.w.SLICE
                        agent_slice.mkdir(parents=True)
                        for scope in live_scopes:
                            (agent_slice / scope).mkdir()
                        # the parent's original scope is gone: no matching
                        # agent-confine-100-200.scope under agents.slice
                        scratch_dir = Path(self.w.AGENT_TMPDIR_PARENT)
                        scratch_dir.mkdir(parents=True)
                        moved = scratch_dir / "agent-confine-100-200"
                        moved.mkdir()
                        for folder in folders:
                            (scratch_dir / folder).mkdir()
                        old_mtime = time.time() - self.w.SCRATCH_GRACE - 1
                        os.utime(moved, (old_mtime, old_mtime))
                        procs = {pid: self.P(pid, ppid, comm, [comm], cg=cg)
                                 for pid, ppid, comm, cg, _ in members}
                        environs = {
                            f"/proc/{pid}/environ":
                                None if env is None
                                else env.format(moved=moved, scratch=scratch_dir) + "\0OTHER=1\0"
                            for pid, _, _, _, env in members}
                        old_read = self.w.read

                        def flaky_read(path, default=None, environs=environs):
                            if str(path) in environs:
                                # read() swallows OSError (permission denied,
                                # process gone) into default
                                found = environs[str(path)]
                                return default if found is None else found
                            return old_read(path, default)

                        unread = {f"/proc/{pid}/cwd" for pid in (unread_cwd[0] if unread_cwd else ())}

                        def readlink(path, *args, unread=unread, **kwargs):
                            if str(path) in unread:
                                raise PermissionError(13, "Permission denied", str(path))
                            return "/unrelated"

                        self.w.read = flaky_read
                        try:
                            with patch.object(self.w.os, "readlink", side_effect=readlink):
                                self.assertEqual(self.w._scratch_in_use(str(moved), self.w._scratch_holders(procs)), status)
                                removed = self.w.reap_scratch_dirs(True, procs, set())
                        finally:
                            self.w.read = old_read
                        if status == "free":
                            self.assertFalse(moved.is_dir())
                            self.assertEqual(removed, ["agent-confine-100-200"])
                        else:
                            self.assertTrue(moved.is_dir())
                            self.assertEqual(removed, [])
                    finally:
                        self.w.CG_ROOT, self.w.AGENT_TMPDIR_PARENT = old_cg, old_parent

    def _detached_worker_scratch(self, module):
        with scratch() as tmp:
            base = Path(tmp)
            with patch.object(module, "CG_ROOT", base / "cg"), \
                    patch.object(module, "AGENT_TMPDIR_PARENT", str(base / "scratch")):
                scope = module.CG_ROOT / module.SLICE / "limited-worker.scope"
                scope.mkdir(parents=True)
                (scope / "pids.max").write_text("32")
                (scope / "memory.max").write_text(str(1024**3))
                active = Path(module.AGENT_TMPDIR_PARENT) / "agent-confine-100-200"
                active.mkdir(parents=True)
                marker = active / "worker-output"
                marker.write_text("active")
                now = 1000.0
                expired = now - module.SCRATCH_GRACE - 1
                os.utime(active, (expired, expired))
                worker = module.Proc(LIVE, ppid=1, comm="bun", argv=["bun", "worker.js"],
                                     exe="/usr/bin/bun", cgroup=f"/agents.slice/{scope.name}",
                                     start=900, marked=True, tty=0)
                with patch.object(module.time, "time", return_value=now), \
                        patch.object(module, "_proc_tmpdir", return_value=None), \
                        patch.object(module, "log"):
                    removed = module.reap_scratch_dirs(True, {worker.pid: worker}, set())
                return removed, marker.exists()

    def test_unreadable_detached_worker_keeps_active_scratch(self):
        self.assertEqual(self._detached_worker_scratch(self.w), ([], True))

    def test_unreadable_worker_scratch_mutant_fails(self):
        text = WARDEN.read_text()
        old = "            unknown.append(pid)\n"
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, "            pass\n"),
                                  "agent_warden_mutant_unknown_scratch")
        with self.assertRaises(AssertionError):
            self.assertEqual(self._detached_worker_scratch(mutant), ([], True))

    def _scratch_reads(self, module, gone):
        """One reap over `gone` scratch directories whose scopes are gone and
        whose grace has passed, beside one still in its grace, with two live
        pids in a warden move scope: LIVE's environment is unreadable, as a
        non-dumpable process's is, so every gone directory reads as unknown
        and none stops the scan early. Returns the reads per /proc file and the names
        removed."""
        with scratch() as tmp:
            base = Path(tmp)
            with patch.object(module, "CG_ROOT", base / "cg"), \
                    patch.object(module, "AGENT_TMPDIR_PARENT", str(base / "scratch")):
                (module.CG_ROOT / module.SLICE).mkdir(parents=True)
                parent = Path(module.AGENT_TMPDIR_PARENT)
                parent.mkdir()
                now = 1000.0
                expired = now - module.SCRATCH_GRACE - 1
                for index in range(gone):
                    directory = parent / f"agent-confine-{300 + index}-400"
                    directory.mkdir()
                    os.utime(directory, (expired, expired))
                fresh = parent / "agent-confine-900-111"
                fresh.mkdir()
                os.utime(fresh, (now, now))
                environs = {f"/proc/{LIVE}/environ": None, "/proc/701/environ": "TMPDIR=/unrelated\0"}
                reads = {}
                real_read, real_readlink = module.read, os.readlink

                def counted_read(path, default=None):
                    if str(path) not in environs:
                        return real_read(path, default)
                    reads[str(path)] = reads.get(str(path), 0) + 1
                    found = environs[str(path)]
                    return default if found is None else found

                def counted_readlink(path, *args, **kwargs):
                    if not str(path).startswith("/proc/"):
                        return real_readlink(path, *args, **kwargs)
                    reads[str(path)] = reads.get(str(path), 0) + 1
                    return "/unrelated"

                with patch.object(module.time, "time", return_value=now), \
                        patch.object(module, "read", side_effect=counted_read), \
                        patch.object(module.os, "readlink", side_effect=counted_readlink), \
                        patch.object(module, "log"):
                    procs = {pid: self.P(pid, 1, "op", ["op"], cg=self._cg("agent-warden-1-2.scope")) for pid in (LIVE, 701)}
                    removed = module.reap_scratch_dirs(True, procs, set())
                return reads, removed

    def test_reap_scratch_dirs_reads_each_process_once(self):
        # Each live pid's environment and current directory are read once
        # per pass, whatever the number of gone directories: on the owner's
        # machine 933 gone directories each rescanned about 970 processes,
        # 24 s of CPU per tick (VSY-216). A pass with no gone directory
        # past its grace reads no process at all.
        once = {f"/proc/{LIVE}/environ": 1, "/proc/701/environ": 1, f"/proc/{LIVE}/cwd": 1, "/proc/701/cwd": 1}
        rows = [
            ("three gone directories, each unknown", 3, (once, [])),
            ("no gone directory past its grace", 0, ({}, [])),
        ]
        for name, gone, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(self._scratch_reads(self.w, gone), expected)

    def test_reap_scratch_dirs_per_directory_read_mutant_fails(self):
        text = WARDEN.read_text()
        old = "        if holders is None:\n            holders = _scratch_holders(procs)\n"
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, "        holders = _scratch_holders(procs)\n"),
                                  "agent_warden_mutant_scratch_reads")
        reads, removed = self._scratch_reads(mutant, 3)
        self.assertEqual(removed, [])
        self.assertEqual(reads[f"/proc/{LIVE}/environ"], 3)

    def test_worker_entering_a_later_directory_during_a_removal_keeps_it(self):
        # A known worker with no TMPDIR changes its current directory into
        # the next gone directory while the warden removes the one before
        # it. The pass's first holder read predates that move, so the
        # directory must be read again before its own removal.
        with scratch() as tmp:
            base = Path(tmp)
            (base / "cg" / self.w.SLICE).mkdir(parents=True)
            first = base / "scratch" / "agent-confine-300-400"
            later = base / "scratch" / "agent-confine-301-400"
            for directory in (first, later):
                directory.mkdir(parents=True)
                os.utime(directory, (0, 0))
            cwd = ["/unrelated"]
            real_read, real_readlink, real_rmtree = self.w.read, os.readlink, self.w.shutil.rmtree

            def read(path, default=None):
                return "HOME=/home\0" if str(path) == "/proc/700/environ" else real_read(path, default)

            def readlink(path, *args, **kwargs):
                return cwd[0] if str(path) == "/proc/700/cwd" else real_readlink(path, *args, **kwargs)

            def rmtree(path, *args, **kwargs):
                if path == str(first):
                    cwd[0] = str(later)
                real_rmtree(path, *args, **kwargs)

            with patch.object(self.w, "CG_ROOT", base / "cg"), \
                    patch.object(self.w, "AGENT_TMPDIR_PARENT", str(base / "scratch")), \
                    patch.object(self.w, "read", side_effect=read), patch.object(self.w, "log"), \
                    patch.object(self.w.os, "readlink", side_effect=readlink), \
                    patch.object(self.w.shutil, "rmtree", side_effect=rmtree):
                removed = self.w.reap_scratch_dirs(True, {700: None}, set())
            self.assertEqual(removed, [first.name])
            self.assertFalse(first.exists())
            self.assertTrue(later.is_dir())

    def test_reap_scratch_dirs_tmpdir_liveness_mutant_fails(self):
        text = WARDEN.read_text()
        old = (
            '        if status == "in-use":\n'
            '            log(f"scratch {name}: scope gone but a live process still uses this directory; not reaping")\n'
            '            continue\n'
        )
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, ""), "agent_warden_mutant_scratch_tmpdir_liveness")
        with scratch() as tmp:
            base = Path(tmp)
            old_cg, old_parent = mutant.CG_ROOT, mutant.AGENT_TMPDIR_PARENT
            mutant.CG_ROOT = base / "cg"
            mutant.AGENT_TMPDIR_PARENT = str(base / "scratch")
            try:
                agent_slice = mutant.CG_ROOT / mutant.SLICE
                agent_slice.mkdir(parents=True)
                scratch_dir = Path(mutant.AGENT_TMPDIR_PARENT)
                scratch_dir.mkdir(parents=True)
                moved = scratch_dir / "agent-confine-100-200"
                moved.mkdir()
                old_mtime = time.time() - mutant.SCRATCH_GRACE - 1
                os.utime(moved, (old_mtime, old_mtime))
                old_read = mutant.read

                def flaky_read(path, default=None):
                    if str(path) == "/proc/555/environ":
                        return f"TMPDIR={moved}\0OTHER=1\0"
                    return old_read(path, default)

                mutant.read = flaky_read
                try:
                    mutant.reap_scratch_dirs(True, {555: self.P(555, 1, "bash", ["bash"])}, set())
                finally:
                    mutant.read = old_read
                self.assertFalse(moved.is_dir())
            finally:
                mutant.CG_ROOT, mutant.AGENT_TMPDIR_PARENT = old_cg, old_parent

    def test_reap_scratch_dirs_tmpdir_symlinked_parent(self):
        # A lexical normalize (os.path.normpath) is not enough: AGENT_TMPDIR
        # can reach its scratch parent through a symlink (a symlinked HOME or
        # XDG_CACHE_HOME), which gives the candidate path and a live
        # process's real TMPDIR two lexically different spellings of the
        # same directory. Only os.path.realpath, which also resolves
        # symlinks, unifies them.
        with scratch() as tmp:
            base = Path(tmp)
            old_cg, old_parent = self.w.CG_ROOT, self.w.AGENT_TMPDIR_PARENT
            self.w.CG_ROOT = base / "cg"
            real_dir = base / "real-scratch"
            real_dir.mkdir(parents=True)
            linked_dir = base / "scratch"
            linked_dir.symlink_to(real_dir, target_is_directory=True)
            self.w.AGENT_TMPDIR_PARENT = str(linked_dir)
            try:
                agent_slice = self.w.CG_ROOT / self.w.SLICE
                agent_slice.mkdir(parents=True)
                # created through the symlinked parent, as agent-confine's
                # own mkdir -m 700 -- "$agent_confine_scratch" would
                moved = linked_dir / "agent-confine-100-200"
                moved.mkdir()
                old_mtime = time.time() - self.w.SCRATCH_GRACE - 1
                os.utime(moved, (old_mtime, old_mtime))
                old_read = self.w.read
                # the live pid's real TMPDIR, spelled through the real
                # (unsymlinked) directory -- a different string than the
                # candidate path os.path.join(AGENT_TMPDIR_PARENT, name)
                # builds from the symlinked AGENT_TMPDIR_PARENT
                real_tmpdir = real_dir / "agent-confine-100-200"

                def flaky_read(path, default=None):
                    if str(path) == "/proc/555/environ":
                        return f"TMPDIR={real_tmpdir}\0OTHER=1\0"
                    return old_read(path, default)

                self.w.read = flaky_read
                try:
                    removed = self.w.reap_scratch_dirs(True, {555: self.P(555, 1, "bash", ["bash"])}, set())
                finally:
                    self.w.read = old_read
                self.assertTrue(moved.is_dir())
                self.assertEqual(removed, [])
            finally:
                self.w.CG_ROOT, self.w.AGENT_TMPDIR_PARENT = old_cg, old_parent

    def test_run_reaps_scratch_with_a_fresh_scan_not_plan_procs(self):
        # run() takes one scan() snapshot up front for plan()'s move
        # decisions (move() itself does not run until much later in the
        # tick). Passing that same early snapshot to reap_scratch_dirs
        # reopens the staleness gap the liveness check exists to close: a
        # process that starts between the snapshot and the reap call --  a
        # prior tick's moved worker spawning a new child, say -- is simply
        # absent from it, which _scratch_in_use cannot tell apart from "no
        # such process". The call site must take a fresh snapshot instead.
        text = WARDEN.read_text()
        self.assertEqual(text.count("reap_scratch_dirs(correct, scan(), scratch_failed)\n"), 1)
        self.assertEqual(text.count("reap_scratch_dirs(correct, procs, scratch_failed)\n"), 0)

    def test_reap_scratch_dirs_stale_snapshot_misses_a_new_live_pid(self):
        # Behavioral proof, against a real subprocess and its real
        # /proc/<pid>/environ rather than a faked pid: a snapshot that does
        # not include that process's pid (as if taken before it started)
        # lets its directory be reaped out from under it; a snapshot that
        # does include it (as scan() would, once the process has started --
        # proven below -- which is what the fixed run() call site passes)
        # keeps the directory. This is the mechanism
        # test_run_reaps_scratch_with_a_fresh_scan_not_plan_procs proves the
        # call site relies on. The two procs dicts here are {} and
        # {pid: None} rather than a full self.w.scan() of this shared
        # machine's whole process list, which would make the "unknown"
        # branch (an unrelated live pid's environ read losing a race against
        # that pid exiting) nondeterministic and unrelated to what this test
        # is proving.
        with scratch() as tmp:
            base = Path(tmp)
            old_cg, old_parent = self.w.CG_ROOT, self.w.AGENT_TMPDIR_PARENT
            self.w.CG_ROOT = base / "cg"
            self.w.AGENT_TMPDIR_PARENT = str(base / "scratch")
            try:
                agent_slice = self.w.CG_ROOT / self.w.SLICE
                agent_slice.mkdir(parents=True)
                scratch_dir = Path(self.w.AGENT_TMPDIR_PARENT)
                scratch_dir.mkdir(parents=True)
                moved = scratch_dir / "agent-confine-100-200"
                moved.mkdir()
                old_mtime = time.time() - self.w.SCRATCH_GRACE - 1
                os.utime(moved, (old_mtime, old_mtime))

                stale = {}  # as if taken before the process below started
                env = {**os.environ, "TMPDIR": str(moved)}
                proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)"], env=env)
                try:
                    # Real wait: the child needs to exec before its environ
                    # reflects the new process image rather than the parent's.
                    environ_path = f"/proc/{proc.pid}/environ"
                    deadline = time.monotonic() + 5
                    while True:
                        content = self.w.read(environ_path, "")
                        if f"TMPDIR={moved}" in content.split("\0"):
                            break
                        if time.monotonic() >= deadline:
                            self.fail("subprocess did not exec in time for its environ to carry TMPDIR")
                        time.sleep(0.02)
                    # scan() itself -- what the fixed run() call site uses --
                    # really does see the process once it has started.
                    self.assertIn(proc.pid, self.w.scan())
                    fresh = {proc.pid: None}

                    removed = self.w.reap_scratch_dirs(True, stale, set())
                    self.assertEqual(removed, ["agent-confine-100-200"])
                    self.assertFalse(moved.is_dir())

                    moved.mkdir()
                    os.utime(moved, (old_mtime, old_mtime))
                    removed = self.w.reap_scratch_dirs(True, fresh, set())
                    self.assertEqual(removed, [])
                    self.assertTrue(moved.is_dir())
                finally:
                    proc.terminate()
                    proc.wait(timeout=5)
            finally:
                self.w.CG_ROOT, self.w.AGENT_TMPDIR_PARENT = old_cg, old_parent

    def _non_dumpable_process(self):
        """A real process that cleared its dumpable flag, as ssh-agent,
        gpg-agent and the 1Password helpers do: its environment and current
        directory cannot be read even by its own user."""
        code = ("import ctypes, sys, time; ctypes.CDLL(None).prctl(4, 0, 0, 0, 0); "
                "sys.stdout.write('ready\\n'); sys.stdout.flush(); time.sleep(30)")
        proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
        self.addCleanup(proc.wait, 5)
        self.addCleanup(proc.terminate)
        self.assertEqual(proc.stdout.readline(), "ready\n")
        proc.stdout.close()
        if self.w._proc_tmpdir(proc.pid) is not None:
            self.skipTest("this runner can read a non-dumpable process's environment (CAP_SYS_PTRACE)")
        return proc.pid

    def test_unreadable_process_holds_scratch_only_through_its_cgroup(self):
        # A non-dumpable desktop process kept every gone folder on the
        # owner's machine: 932 of 933 each tick, one journal line each per
        # run (VSY-218). Its cgroup is a desktop unit, which no lane starts,
        # so the folders go. A contained job unit in app.slice is not one: a
        # lane started it, so it keeps both and says so in one line per run,
        # not one per folder.
        pid = self._non_dumpable_process()
        user = f"/user.slice/user-{self.w.UID}.slice/user@{self.w.UID}.service"
        rows = [
            ("a desktop daemon", f"{user}/app.slice/ssh-agent.service",
             ["agent-confine-300-400", "agent-confine-301-400"], 0),
            ("a contained job unit", f"{user}/app.slice/orch-validate.service", [], 1),
        ]
        for name, cgroup, removed, kept_lines in rows:
            with self.subTest(name=name), scratch() as tmp:
                base = Path(tmp)
                (base / "cg" / self.w.SLICE).mkdir(parents=True)
                for folder in ("agent-confine-300-400", "agent-confine-301-400"):
                    (base / "scratch" / folder).mkdir(parents=True)
                    os.utime(base / "scratch" / folder, (0, 0))
                daemon = self.P(pid, 1, "ssh-agent", ["ssh-agent"], cg=cgroup)
                logs = []
                with patch.object(self.w, "CG_ROOT", base / "cg"), \
                        patch.object(self.w, "AGENT_TMPDIR_PARENT", str(base / "scratch")), \
                        patch.object(self.w, "log", side_effect=logs.append):
                    self.assertEqual(self.w.reap_scratch_dirs(True, {pid: daemon}, set()), removed)
                self.assertEqual(len(logs), len(removed) + kept_lines)
                self.assertEqual(sum(str(pid) in line for line in logs), kept_lines)

    def test_reap_scratch_dirs_sweeps_the_old_default_parent(self):
        # AGENT_TMPDIR moved to ~/dev/.scratch/agents and left 2,474 folders
        # under agent-confine's default ${XDG_CACHE_HOME}/agents/tmp, which the
        # warden never listed (VSY-218). Both parents take the same rule: a
        # live scope's folder stays, and a tied unreadable process keeps both
        # gone folders.
        with scratch() as tmp:
            base = Path(tmp)
            env = {**self.env, "AGENT_TMPDIR": str(base / "scratch"), "XDG_CACHE_HOME": str(base / "cache")}
            w = load_warden(env, "agent_warden_old_parent")
            old_parent, new_parent = base / "cache" / "agents" / "tmp", base / "scratch"
            moved = self.P(LIVE, 1, "op", ["op"], cg=self._cg("agent-warden-1-2.scope"))
            rows = [
                ("no process holds them", {}, ["agent-confine-301-400", "agent-confine-300-400"]),
                ("an unreadable process in a move scope", {LIVE: moved}, []),
            ]
            for name, procs, removed in rows:
                with self.subTest(name=name):
                    (base / "cg" / w.SLICE / "agent-confine-100-200.scope").mkdir(parents=True, exist_ok=True)
                    folders = [old_parent / "agent-confine-100-200", old_parent / "agent-confine-300-400",
                               new_parent / "agent-confine-301-400"]
                    for folder in folders:
                        folder.mkdir(parents=True, exist_ok=True)
                        os.utime(folder, (0, 0))
                    with patch.object(w, "CG_ROOT", base / "cg"), patch.object(w, "log"), \
                            patch.object(w, "_proc_tmpdir", return_value=None):
                        self.assertEqual(w.reap_scratch_dirs(True, procs, set()), removed)
                    self.assertEqual([folder.name for folder in folders if folder.is_dir()],
                                     [folder.name for folder in folders if folder.name not in removed])

    def _capped_passes(self, passes, cap, failing=(), sample=None):
        """Runs `passes` correct-mode reaps over three gone folders past
        their grace with the cap at `cap`. A folder in `failing` cannot be
        removed. Returns the names each pass removed, every removal attempt
        in order, and the number of holder reads."""
        names = ["agent-confine-300-400", "agent-confine-301-400", "agent-confine-302-400"]
        attempts, reads = [], [0]
        real_holders = self.w._scratch_holders

        def rmtree(path, *args, **kwargs):
            attempts.append(os.path.basename(path))
            if os.path.basename(path) in failing:
                raise PermissionError(13, "Permission denied", path)
            os.rmdir(path)

        def holders(procs):
            reads[0] += 1
            return real_holders(procs)

        with scratch() as tmp:
            base = Path(tmp)
            (base / "cg" / self.w.SLICE).mkdir(parents=True)
            for name in names:
                (base / "scratch" / name).mkdir(parents=True)
                os.utime(base / "scratch" / name, (0, 0))
            with patch.object(self.w, "CG_ROOT", base / "cg"), \
                    patch.object(self.w, "AGENT_TMPDIR_PARENT", str(base / "scratch")), \
                    patch.object(self.w, "SCRATCH_REMOVALS_PER_PASS", cap), \
                    patch.object(self.w.shutil, "rmtree", side_effect=rmtree), \
                    patch.object(self.w, "_scratch_holders", side_effect=holders), \
                    patch.object(self.w.random, "sample", side_effect=sample or self.w.random.sample), \
                    patch.object(self.w, "log"):
                removed = [self.w.reap_scratch_dirs(True, {}, set()) for _ in range(passes)]
        return names, removed, attempts, reads[0]

    def test_reap_scratch_dirs_caps_removals_per_pass(self):
        # Each removal re-reads every process first. The owner's backlog of
        # about 3,500 folders would take about 50 s in one pass, past the
        # service's 25 s timeout, so a pass stops at its cap and the next
        # pass takes the rest.
        names, removed, _, _ = self._capped_passes(2, 2)
        self.assertEqual([len(names) for names in removed], [2, 1])
        self.assertEqual(sorted(removed[0] + removed[1]), names)

    def test_reap_scratch_dirs_caps_failed_attempts_per_pass(self):
        # A folder that cannot be removed (an agent's read-only fixture
        # outside its owner's reach) still costs its process re-read, so the
        # cap counts attempts, not successes: three failing folders under a
        # cap of 2 take two attempts and three reads, the pass's first read
        # and one before each attempt.
        _, removed, attempts, reads = self._capped_passes(
            1, 2, failing={"agent-confine-300-400", "agent-confine-301-400", "agent-confine-302-400"})
        self.assertEqual(removed, [[]])
        self.assertEqual(len(attempts), 2)
        self.assertEqual(reads, 3)

    def test_reap_scratch_dirs_failing_folders_do_not_starve_the_rest(self):
        # Two folders that keep failing sort ahead of a removable one. With
        # a cap of 1, a pass that always took the first free folder would
        # attempt the same failing one forever; a pass picks at random, so
        # the removable folder goes within a few passes.
        failing = {"agent-confine-300-400", "agent-confine-301-400"}
        _, removed, attempts, _ = self._capped_passes(
            8, 1, failing=failing, sample=random.Random(0).sample)
        self.assertEqual(len(attempts), 8)
        self.assertIn(["agent-confine-302-400"], removed)

    def _report_pass(self, folders):
        """CPU seconds and folders walked for one --report pass of the whole
        script, this machine's real process list included, over `folders`
        gone folders in a private parent. CG_ROOT points at a private
        agents.slice so no live scope is read, and PATH is empty so no
        notice can be sent. The walk is counted as lstat calls on a path
        directly under that parent."""
        driver = (
            "import importlib.machinery, importlib.util, os, sys\n"
            "from pathlib import Path\n"
            "loader = importlib.machinery.SourceFileLoader('agent_warden_cpu', sys.argv[1])\n"
            "module = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))\n"
            "loader.exec_module(module)\n"
            "module.CG_ROOT = Path(sys.argv[2])\n"
            "walked, real_lstat = [0], os.lstat\n"
            "def lstat(path, *args, **kwargs):\n"
            "    walked[0] += os.path.dirname(os.fspath(path)) == sys.argv[3]\n"
            "    return real_lstat(path, *args, **kwargs)\n"
            "os.lstat = lstat\n"
            "code = module.main(['agent-warden', '--report'])\n"
            "sys.stderr.write(f'walked={walked[0]}\\n')\n"
            "sys.exit(code)\n"
        )
        with scratch() as tmp:
            base = Path(tmp)
            for directory in ("home", "run", "cache", "bin", "cg/agents.slice", "scratch"):
                (base / directory).mkdir(parents=True)
            for index in range(folders):
                folder = base / "scratch" / f"agent-confine-{9000000 + index}-1"
                folder.mkdir()
                os.utime(folder, (0, 0))
            env = {"HOME": str(base / "home"), "XDG_RUNTIME_DIR": str(base / "run"),
                   "XDG_CACHE_HOME": str(base / "cache"), "AGENT_TMPDIR": str(base / "scratch"),
                   "PATH": str(base / "bin"), "PYTHONDONTWRITEBYTECODE": "1"}
            before = resource.getrusage(resource.RUSAGE_CHILDREN)
            result = subprocess.run([sys.executable, "-c", driver, str(WARDEN), str(base / "cg"),
                                     os.path.realpath(base / "scratch")],
                                    env=env, capture_output=True, text=True, timeout=60)
            after = resource.getrusage(resource.RUSAGE_CHILDREN)
        self.assertEqual(result.returncode, 0, result.stderr)
        walked = int(re.search(r"^walked=(\d+)$", result.stderr, re.M).group(1))
        return (after.ru_utime - before.ru_utime) + (after.ru_stime - before.ru_stime), walked

    def test_report_pass_cost_per_gone_folder_stays_small(self):
        # The pass with no folder pays interpreter start, import and the
        # /proc scans; the difference is the reaper's own walk over 5,000
        # folders, about 0.04 s. The fastest of three passes each keeps
        # machine load out of both sides. VSY-216's regression, every
        # process re-read for every folder, costs seconds here.
        idle, loaded = ([self._report_pass(folders) for _ in range(3)] for folders in (0, 5000))
        self.assertEqual([walked for _, walked in idle + loaded], [0, 0, 0, 5000, 5000, 5000])
        self.assertLess(min(cpu for cpu, _ in loaded) - min(cpu for cpu, _ in idle), 0.1)

    def test_scope_units_skips_one_vanished_entry(self):
        # scope_units() must not discard scopes it already read just because
        # one entry disappeared mid-scan (a scope stopping during the scan).
        with scratch() as tmp:
            base = Path(tmp)
            old_cg = self.w.CG_ROOT
            self.w.CG_ROOT = base / "cg"
            try:
                agent_slice = self.w.CG_ROOT / self.w.SLICE
                agent_slice.mkdir(parents=True)
                (agent_slice / "steady.scope").mkdir()
                (agent_slice / "vanishing.scope").mkdir()
                old_read = self.w.read

                def flaky_read(path, default=None):
                    if str(path).endswith("vanishing.scope/pids.max"):
                        raise OSError("vanished mid-scan")
                    return old_read(path, default)

                self.w.read = flaky_read
                try:
                    units = self.w.scope_units()
                finally:
                    self.w.read = old_read
                self.assertIsNotNone(units)
                self.assertIn("steady.scope", units)
                self.assertNotIn("vanishing.scope", units)
            finally:
                self.w.CG_ROOT = old_cg

    def test_scope_units_vanished_entry_mutant_fails(self):
        text = WARDEN.read_text()
        old = (
            '    out = {}\n'
            '    for d in entries:\n'
            '        try:\n'
            '            if d.is_dir() and d.name.endswith(".scope"):\n'
            '                out[d.name] = (read(d / "pids.max", "") or "").strip()\n'
            '        except OSError:\n'
            '            continue\n'
            '    return out\n'
        )
        self.assertEqual(text.count(old), 1)
        new = (
            '    out = {}\n'
            '    for d in entries:\n'
            '        if d.is_dir() and d.name.endswith(".scope"):\n'
            '            out[d.name] = (read(d / "pids.max", "") or "").strip()\n'
            '    return out\n'
        )
        mutant = self.load_mutant(text.replace(old, new), "agent_warden_mutant_scope_units_entry")
        with scratch() as tmp:
            base = Path(tmp)
            old_cg = mutant.CG_ROOT
            mutant.CG_ROOT = base / "cg"
            try:
                agent_slice = mutant.CG_ROOT / mutant.SLICE
                agent_slice.mkdir(parents=True)
                (agent_slice / "steady.scope").mkdir()
                (agent_slice / "vanishing.scope").mkdir()
                old_read = mutant.read

                def flaky_read(path, default=None):
                    if str(path).endswith("vanishing.scope/pids.max"):
                        raise OSError("vanished mid-scan")
                    return old_read(path, default)

                mutant.read = flaky_read
                try:
                    with self.assertRaises(OSError):
                        mutant.scope_units()
                finally:
                    mutant.read = old_read
            finally:
                mutant.CG_ROOT = old_cg


if __name__ == "__main__":
    unittest.main()
