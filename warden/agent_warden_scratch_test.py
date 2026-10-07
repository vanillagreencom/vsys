import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from agent_warden_testlib import WARDEN, WardenRulesCase, scratch

sys.dont_write_bytecode = True


class AgentWardenScratchRules(WardenRulesCase):
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
        # os.path.join (this candidate path's source) never does. The
        # unreadable environment can belong to a worker that inherited
        # TMPDIR before its launcher exited, regardless of its current scope.
        user = "/user.slice/user-1000.slice/user@1000.service"
        app = f"{user}/app.slice/x.scope"
        nested = f"{user}/agents.slice/agent-warden-555-1.scope"
        build = f"{user}/agents.slice/agent-warden-build-555-1.scope"
        other = f"{user}/agents.slice/agent-confine-300-400.scope"
        manager = (700, 1, "systemd", f"{user}/init.scope", None)
        rows = [
            ("a live process's TMPDIR resolves here",
             [(555, 1, "bash", nested, "TMPDIR={moved}")], [], "in-use"),
            ("a live process's TMPDIR names an unrelated sibling",
             [(555, 1, "bash", nested, "TMPDIR={moved}0")], [], "free"),
            ("a live process's TMPDIR has a doubled separator",
             [(555, 1, "bash", nested, "TMPDIR={scratch}//agent-confine-100-200")], [], "in-use"),
            ("an unreadable desktop daemon outside agents.slice",
             [manager, (701, 700, "ssh-agent", app, None)], [], "unknown"),
            ("an unreadable child of an agent shell whose TMPDIR names it",
             [(556, 555, "op", nested, None), (555, 1, "bash", nested, "TMPDIR={moved}")], [], "in-use"),
            ("an orphaned unreadable daemon in another live agents.slice scope",
             [manager, (800, 700, "op", other, None)], ["agent-confine-300-400.scope"], "unknown"),
            ("an unreadable child alone in a moved scope whose agent parents are gone",
             [manager, (556, 700, "op", nested, None)], [], "unknown"),
            ("an unreadable child alone in a moved build scope whose agent parents are gone",
             [manager, (556, 700, "op", build, None)], [], "unknown"),
        ]
        for name, members, live_scopes, status in rows:
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

                        self.w.read = flaky_read
                        try:
                            self.assertEqual(self.w._scratch_in_use(str(moved), procs), status)
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
                worker = module.Proc(700, ppid=1, comm="bun", argv=["bun", "worker.js"],
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
        old = "            unknown = True\n"
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, "            unknown = False\n"),
                                  "agent_warden_mutant_unknown_scratch")
        with self.assertRaises(AssertionError):
            self.assertEqual(self._detached_worker_scratch(mutant), ([], True))

    def test_reap_scratch_dirs_tmpdir_liveness_mutant_fails(self):
        text = WARDEN.read_text()
        old = (
            '        if status == "in-use":\n'
            '            log(f"scratch {name}: scope gone but a live process still has TMPDIR here; not reaping")\n'
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
                    mutant.reap_scratch_dirs(True, {555: None}, set())
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
                    removed = self.w.reap_scratch_dirs(True, {555: None}, set())
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
