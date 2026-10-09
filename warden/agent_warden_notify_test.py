import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

from agent_warden_testlib import WARDEN, WardenMutantMixin, clean_env, load_warden, materialize_warden_script, scratch

sys.dont_write_bytecode = True


class AgentWardenNotifyRules(WardenMutantMixin, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = scratch()
        base = Path(cls.tmp.name)
        cls.env = clean_env({
            "HOME": base / "home",
            "XDG_RUNTIME_DIR": base / "run",
            "MISE_DATA_DIR": base / "mise-data",
        })
        for path in (base / "home", base / "run", base / "mise-data"):
            path.mkdir(parents=True, exist_ok=True)
        cls.w = load_warden(cls.env)
        cls.A = "/user.slice/user-1000.slice/user@1000.service/app.slice/x.scope"

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_notifier_heartbeat_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            heartbeat = base / "run" / "agent-warden" / "notifier"
            heartbeat.parent.mkdir(parents=True)
            rows = []
            for name, mtime, expected in (
                ("fresh", 940.0, True),
                ("stale", 879.0, False),
                ("future outside trust window", 1121.0, False),
            ):
                heartbeat.write_text("")
                os.utime(heartbeat, (mtime, mtime))
                rows.append((name, self.w.notifier_fresh(heartbeat, now=1000.0), expected))
            heartbeat.unlink()
            rows.append(("absent", self.w.notifier_fresh(heartbeat, now=1000.0), False))
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

    def test_notice_handoff_rows(self):
        calls = []
        logs = []
        old_log = self.w.log
        self.w.log = logs.append
        try:
            sender = lambda k, s, b: calls.append((k, s, b)) or True
            # A notice left to the consumer leaves one journal line naming
            # its summary; a sent one leaves none.
            for summary, fresh, expected, logged in (
                ("handoff-summary", True, "consumer", 1),
                ("fallback-summary", False, "sent", 0),
            ):
                with self.subTest(summary=summary):
                    before = len(logs)
                    self.assertEqual(self.w.deliver_notice("moved", summary, "body", fresh, sender), expected)
                    self.assertEqual(len(logs) - before, logged)
                    self.assertEqual(sum(summary in line for line in logs[before:]), logged)
            self.assertEqual(calls, [("moved", "fallback-summary", "body")])
        finally:
            self.w.log = old_log

    def test_episode_dedupe_rows(self):
        calls = []
        logs = []
        old_log = self.w.log
        self.w.log = logs.append
        try:
            sender = lambda k, s, b: calls.append((k, s, b)) or True
            st = self.w.default_state()
            rows = [
                ("first tick sends", "tasks", False, 1000.0, "sent"),
                ("open episode sends once", "tasks", False, 1001.0, "none"),
                ("fresh consumer owns the notice", "memory", True, 1000.0, "consumer"),
                ("stale consumer falls back once", "memory", False, 1001.0, "sent"),
            ]
            for name, kind, fresh, now, expected in rows:
                with self.subTest(name=name):
                    before = len(logs)
                    delivery, _key = self.w.deliver_episode_notice(st, kind, "lane.scope", kind, "body", fresh, now, sender)
                    self.assertEqual(delivery, expected)
                    # Only a notice left to the consumer leaves a journal line.
                    logged = 1 if expected == "consumer" else 0
                    self.assertEqual(len(logs) - before, logged)
                    self.assertEqual(sum(kind in line for line in logs[before:]), logged)
            self.w.clear_episodes(st, {"tasks"})
            self.assertEqual(self.w.deliver_episode_notice(st, "tasks", "lane.scope", "tasks", "body", False, 1002.0, sender)[0], "sent")
            self.assertEqual(calls, [("tasks", "tasks", "body"), ("memory", "memory", "body"), ("tasks", "tasks", "body")])
        finally:
            self.w.log = old_log

    def test_failed_episode_delivery_stays_pending(self):
        calls = []
        st = self.w.default_state()
        sender = lambda k, s, b: calls.append((s, b)) or False
        self.assertEqual(self.w.deliver_episode_notice(st, "tasks", "lane.scope", "near", "body", False, 1000.0, sender)[0], "failed")
        self.assertFalse(st["episodes"]["tasks:lane.scope"].get("notified"))
        self.assertEqual(self.w.deliver_episode_notice(st, "tasks", "lane.scope", "near", "body", False, 1001.0, sender)[0], "failed")
        self.assertEqual(calls, [("near", "body"), ("near", "body")])
        self.assertFalse(st["episodes"]["tasks:lane.scope"].get("notified"))
        self.assertEqual(self.w.deliver_episode_notice(st, "tasks", "lane.scope", "near", "body", False, 1002.0, lambda k, s, b: calls.append((s, b)) or True)[0], "sent")
        self.assertTrue(st["episodes"]["tasks:lane.scope"].get("notified"))

    def test_notify_send_result_rows(self):
        logs = []
        old_run, old_log = self.w.subprocess.run, self.w.log

        class Result:
            def __init__(self, returncode):
                self.returncode = returncode

        try:
            self.w.log = logs.append
            self.w.subprocess.run = lambda *a, **kw: Result(0)
            self.assertTrue(self.w.notify("tasks", "summary", "body"))
            self.w.subprocess.run = lambda *a, **kw: Result(7)
            self.assertFalse(self.w.notify("tasks", "summary", "body"))
            self.assertEqual(logs[-1], "notify-send failed: kind=tasks exit=7 summary=summary")
            self.w.subprocess.run = lambda *a, **kw: (_ for _ in ()).throw(OSError("missing"))
            self.assertFalse(self.w.notify("tasks", "summary", "body"))
            self.assertEqual(logs[-1], "notify-send failed: kind=tasks error=OSError summary=summary")
        finally:
            self.w.subprocess.run, self.w.log = old_run, old_log

    def _run_move_fixture(self, module, state_dir, *, initial_state=None, headrooms=None, move_impl=None, notify_results=None, plan_moves=None, only=None):
        state_dir.mkdir(parents=True, exist_ok=True)
        old = {name: getattr(module, name) for name in (
            "STATE_DIR", "STATE", "LOCK", "scan", "plan", "Bus", "headroom", "move", "notify",
            "notifier_fresh", "enforce_task_caps", "warn_near_cap", "reap_orphans", "time", "only_pids",
        )}
        module.STATE_DIR = state_dir
        module.STATE = state_dir / "state.json"
        module.LOCK = state_dir / "lock"
        if initial_state is not None:
            module.STATE.write_text(json.dumps(initial_state))
        root = module.Proc(10, ppid=1, comm="claude", argv=["claude"], exe="/usr/bin/claude", cgroup=self.A, start=1)
        notifications = []
        headrooms = list(headrooms or [(True, 0, 0)])
        notify_results = list(notify_results if notify_results is not None else [True])

        class Clock:
            @staticmethod
            def time():
                return 1000.0

            @staticmethod
            def process_time():
                return 0.0

            @staticmethod
            def monotonic():
                return 1000.0

            @staticmethod
            def sleep(_seconds):
                return None

        class FakeBus:
            def close(self):
                return None

        def fake_notify(kind, summary, body):
            notifications.append(kind)
            return notify_results.pop(0) if notify_results else True

        moves = [("escaped launch", [root])] if plan_moves is None else plan_moves
        module.scan = lambda: {}
        module.plan = lambda _procs, only=None: (moves, [], [], [])
        module.only_pids = lambda: only
        module.Bus = lambda: FakeBus()
        module.headroom = lambda: headrooms.pop(0)
        module.move = move_impl or (lambda tree, reason, bus: (False, "unit.scope", [], tree))
        module.notify = fake_notify
        module.notifier_fresh = lambda now=None: False
        module.enforce_task_caps = lambda correct: []
        module.warn_near_cap = lambda: ([], set(), True)
        module.reap_orphans = lambda procs, st, correct, only=None: []
        module.time = Clock
        try:
            result = module.run(True)
            state = json.loads(module.STATE.read_text())
            return result, state, notifications
        finally:
            for name, value in old.items():
                setattr(module, name, value)

    def test_run_move_failure_episode_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            initial = self.w.default_state()
            initial["episodes"] = {"move-failure:10:1": {"kind": "move-failure", "scope": "10:1", "since": 900.0, "notified": True}}
            _, state, notifications = self._run_move_fixture(self.w, base / "state-headroom", initial_state=initial, headrooms=[(False, -1, -1)])
            self.assertIn("move-failure:10:1", state["episodes"])
            self.assertEqual(notifications, [])

            def raising_move(_tree, _reason, _bus):
                raise RuntimeError("boom")

            _, state, notifications = self._run_move_fixture(self.w, base / "state-raise", move_impl=raising_move)
            self.assertTrue(state["episodes"]["move-failure:10:1"].get("notified"))
            self.assertEqual(notifications, ["move-failure"])

            _, state, notifications = self._run_move_fixture(self.w, base / "state-retry", notify_results=[False])
            self.assertFalse(state["episodes"]["move-failure:10:1"].get("notified"))
            _, state, notifications = self._run_move_fixture(self.w, base / "state-retry", notify_results=[False])
            self.assertFalse(state["episodes"]["move-failure:10:1"].get("notified"))
            self.assertEqual(notifications, ["move-failure"])

    def test_restricted_run_preserves_episodes(self):
        with scratch() as tmp:
            state_dir = Path(tmp) / "state"
            _, state, notifications = self._run_move_fixture(self.w, state_dir)
            self.assertTrue(state["episodes"]["move-failure:10:1"].get("notified"))
            self.assertEqual(len(notifications), 1)

            _, state, notifications = self._run_move_fixture(self.w, state_dir, plan_moves=[], only={999})
            self.assertIn("move-failure:10:1", state["episodes"])
            self.assertEqual(notifications, [])

            _, state, notifications = self._run_move_fixture(self.w, state_dir)
            self.assertTrue(state["episodes"]["move-failure:10:1"].get("notified"))
            self.assertEqual(notifications, [])

            initial = self.w.default_state()
            initial["episodes"] = {"move-failure:10:1": {"kind": "move-failure", "scope": "10:1", "since": 900.0, "notified": True}}
            other = self.w.Proc(11, ppid=1, comm="claude", argv=["claude"], exe="/usr/bin/claude", cgroup=self.A, start=1)
            _, state, _notifications = self._run_move_fixture(
                self.w, Path(tmp) / "state-restricted-other", initial_state=initial,
                plan_moves=[("escaped launch", [other])], only={11})
            self.assertIn("move-failure:10:1", state["episodes"])

    def test_not_moving_episode_lifetime_rows(self):
        with scratch() as tmp:
            state_dir = Path(tmp) / "state"
            _result, state, notifications = self._run_move_fixture(self.w, state_dir, headrooms=[(False, -1, -1)])
            rec = state["episodes"]["not-moving:agents.slice"]
            self.assertEqual(rec["since"], 1000.0)
            self.assertFalse(rec.get("notified"))
            self.assertEqual(notifications, [])
            _result, state, notifications = self._run_move_fixture(self.w, state_dir, headrooms=[(False, -1, -1)])
            self.assertEqual(state["episodes"]["not-moving:agents.slice"]["since"], 1000.0)
            self.assertEqual(notifications, [])
            _result, state, notifications = self._run_move_fixture(self.w, state_dir, headrooms=[(False, -1, -1)])
            self.assertEqual(notifications, ["not-moving"])
            self.assertTrue(state["episodes"]["not-moving:agents.slice"].get("notified"))

            _result, state, notifications = self._run_move_fixture(self.w, state_dir, plan_moves=[], only={999})
            self.assertIn("not-moving:agents.slice", state["episodes"])
            self.assertEqual(notifications, [])

            for _ in range(3):
                _result, state, notifications = self._run_move_fixture(self.w, state_dir, headrooms=[(False, -1, -1)])
                self.assertIn("not-moving:agents.slice", state["episodes"])
                self.assertEqual(notifications, [])

    def test_move_condition_recovery_clears_episode_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            initial = self.w.default_state()
            initial["episodes"] = {"not-moving:agents.slice": {"kind": "not-moving", "scope": "agents.slice", "since": 900.0, "notified": True}}
            _result, state, notifications = self._run_move_fixture(self.w, base / "state-no-moves", initial_state=initial, plan_moves=[])
            self.assertNotIn("not-moving:agents.slice", state["episodes"])
            self.assertEqual(notifications, [])
            for _ in range(2):
                _result, _state, notifications = self._run_move_fixture(self.w, base / "state-no-moves", headrooms=[(False, -1, -1)])
                self.assertEqual(notifications, [])
            _result, state, notifications = self._run_move_fixture(self.w, base / "state-no-moves", headrooms=[(False, -1, -1)])
            self.assertEqual(notifications, ["not-moving"])
            self.assertTrue(state["episodes"]["not-moving:agents.slice"].get("notified"))

            initial = self.w.default_state()
            initial["episodes"] = {
                "not-moving:agents.slice": {"kind": "not-moving", "scope": "agents.slice", "since": 900.0, "notified": True},
                "move-failure:10:1": {"kind": "move-failure", "scope": "10:1", "since": 900.0, "notified": True},
            }
            _result, state, notifications = self._run_move_fixture(
                self.w, base / "state-success", initial_state=initial,
                move_impl=lambda tree, reason, bus: (True, "unit.scope", tree, []))
            self.assertNotIn("not-moving:agents.slice", state["episodes"])
            self.assertNotIn("move-failure:10:1", state["episodes"])
            self.assertEqual(notifications, ["moved"])
            _result, state, notifications = self._run_move_fixture(self.w, base / "state-success")
            self.assertEqual(notifications, ["move-failure"])
            self.assertTrue(state["episodes"]["move-failure:10:1"].get("notified"))

    def _run_near_cap_fixture(self, module, state_dir, cg_root, *, initial_state=None, listing_raises=False):
        state_dir.mkdir(parents=True, exist_ok=True)
        old = {name: getattr(module, name) for name in (
            "STATE_DIR", "STATE", "LOCK", "CG_ROOT", "scan", "plan", "only_pids", "enforce_task_caps",
            "reap_orphans", "notify", "notifier_fresh", "time",
        )}
        old_iterdir = module.Path.iterdir
        module.STATE_DIR = state_dir
        module.STATE = state_dir / "state.json"
        module.LOCK = state_dir / "lock"
        module.CG_ROOT = cg_root
        if initial_state is not None:
            module.STATE.write_text(json.dumps(initial_state))
        notifications = []
        logs = []

        class Clock:
            @staticmethod
            def time():
                return 1000.0

            @staticmethod
            def process_time():
                return 0.0

        module.scan = lambda: {}
        module.plan = lambda _procs, only=None: ([], [], [], [])
        module.only_pids = lambda: None
        module.enforce_task_caps = lambda correct: []
        module.reap_orphans = lambda procs, st, correct, only=None: []
        module.notify = lambda kind, summary, body: notifications.append(kind) or True
        module.notifier_fresh = lambda now=None: False
        module.time = Clock
        if listing_raises:
            def raising_iterdir(path):
                if path == module.CG_ROOT / module.SLICE:
                    raise OSError("blocked")
                return old_iterdir(path)
            module.Path.iterdir = raising_iterdir
        old_log = module.log
        module.log = logs.append
        try:
            result = module.run(True)
            state = json.loads(module.STATE.read_text())
            return result, state, notifications, logs
        finally:
            module.log = old_log
            module.Path.iterdir = old_iterdir
            for name, value in old.items():
                setattr(module, name, value)

    def write_near_cap_scope(self, root, unit, *, tasks=None, memory=None):
        scope = root / self.w.SLICE / unit
        scope.mkdir(parents=True, exist_ok=True)
        (scope / "pids.current").write_text(str(tasks) if tasks is not None else "bad")
        (scope / "pids.max").write_text(str(self.w.SCOPE_TASKS_MAX))
        (scope / "memory.current").write_text(str(memory) if memory is not None else "0")
        return scope

    def test_near_cap_unknown_keeps_episode_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            state_dir = base / "state"
            cg = base / "cg"
            initial = self.w.default_state()
            initial["episodes"] = {"tasks:lane.scope": {"kind": "tasks", "scope": "lane.scope", "since": 900.0, "notified": True}}
            self.write_near_cap_scope(cg, "lane.scope", tasks=None, memory=0)
            _result, state, notifications, logs = self._run_near_cap_fixture(self.w, state_dir, cg, initial_state=initial)
            self.assertIn("tasks:lane.scope", state["episodes"])
            self.assertEqual(notifications, [])
            self.assertIn("near-cap unreadable: scope=lane.scope kind=tasks", logs)

            scope = cg / self.w.SLICE / "lane.scope"
            for child in scope.iterdir():
                child.unlink()
            scope.rmdir()
            _result, state, _notifications, _logs = self._run_near_cap_fixture(self.w, state_dir, cg)
            self.assertNotIn("tasks:lane.scope", state["episodes"])

            initial = self.w.default_state()
            initial["episodes"] = {"memory:missing.scope": {"kind": "memory", "scope": "missing.scope", "since": 900.0, "notified": True}}
            empty_cg = base / "empty-cg"
            _result, state, _notifications, _logs = self._run_near_cap_fixture(self.w, base / "empty-state", empty_cg, initial_state=initial)
            self.assertNotIn("memory:missing.scope", state["episodes"])

    def test_near_cap_listing_failure_keeps_episode_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            cg = base / "cg"
            (cg / self.w.SLICE).mkdir(parents=True)
            initial = self.w.default_state()
            initial["episodes"] = {
                "tasks:lane.scope": {"kind": "tasks", "scope": "lane.scope", "since": 900.0, "notified": True},
                "memory:lane.scope": {"kind": "memory", "scope": "lane.scope", "since": 900.0, "notified": True},
            }
            _result, state, _notifications, logs = self._run_near_cap_fixture(
                self.w, base / "state-listing", cg, initial_state=initial, listing_raises=True)
            self.assertIn("tasks:lane.scope", state["episodes"])
            self.assertIn("memory:lane.scope", state["episodes"])
            self.assertIn("near-cap unreadable: scope-list", logs)

    def test_status_read_only_subprocess_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"}, path=True)
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            state_dir = Path(env["XDG_RUNTIME_DIR"]) / "agent-warden"
            state_dir.mkdir(parents=True)
            state = state_dir / "state.json"
            body = json.dumps({
                "skips": 7,
                "last_report": 10,
                "last_correct": 20,
                "moves": 1,
                "partial": 2,
                "scan_failures": 3,
                "move_failures": 4,
                "reaped": 5,
                "orphans": {},
                "episodes": {
                    "tasks:lane.scope": {"kind": "tasks", "scope": "lane.scope", "since": 6, "notified": True},
                    "tasks:bad.scope": [],
                    "x": {"kind": "bogus", "scope": "lane.scope", "since": 6, "notified": True},
                },
            }, sort_keys=True).encode()
            state.write_bytes(body)
            before_mtime = state.stat().st_mtime_ns
            result = subprocess.run([sys.executable, str(WARDEN), "--status"], env=env, capture_output=True, text=True)
            after = state.read_bytes()
            after_mtime = state.stat().st_mtime_ns
            lock_exists = (state_dir / "lock").exists()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(after, body)
        self.assertEqual(after_mtime, before_mtime)
        self.assertFalse(lock_exists)
        # The status read keeps only the well-formed episode.
        episodes = {tuple(line.split()[1:3]) for line in result.stdout.splitlines() if line.startswith("  EPISODE ")}
        self.assertEqual(episodes, {("tasks", "lane.scope:")})

    def test_invalid_episode_state_is_dropped_on_tick(self):
        with scratch() as tmp:
            base = Path(tmp)
            old_state = self.w.STATE_DIR, self.w.STATE, self.w.STATUS, self.w.LOCK, self.w.CG_ROOT
            self.w.STATE_DIR = base / "state"
            self.w.STATE = self.w.STATE_DIR / "state.json"
            self.w.STATUS = self.w.STATE_DIR / "status.json"
            self.w.LOCK = self.w.STATE_DIR / "lock"
            self.w.CG_ROOT = base / "cg"
            self.w.STATE_DIR.mkdir(parents=True)
            self.w.STATE.write_text(json.dumps({
                "episodes": {
                    "tasks:lane.scope": {"kind": "tasks", "scope": "lane.scope", "since": 6, "notified": True},
                    "tasks:bad.scope": [],
                    "x": {"kind": "bogus", "scope": "lane.scope", "since": 6, "notified": True},
                    "tasks:wrong.scope": {"kind": "tasks", "scope": "lane.scope", "since": 6, "notified": True},
                }
            }))
            try:
                with self.w.State() as st:
                    self.assertEqual(set(st["episodes"]), {"tasks:lane.scope"})
                stored = json.loads(self.w.STATE.read_text())
                self.assertEqual(set(stored["episodes"]), {"tasks:lane.scope"})
            finally:
                self.w.STATE_DIR, self.w.STATE, self.w.STATUS, self.w.LOCK, self.w.CG_ROOT = old_state

    def test_status_absent_directory_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"}, path=True)
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            result = subprocess.run([sys.executable, str(WARDEN), "--status"], env=env, capture_output=True, text=True)
            run_entries = os.listdir(env["XDG_RUNTIME_DIR"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(run_entries, [])

    def test_near_cap_listing_failure_clear_mutant_fails(self):
        text = WARDEN.read_text()
        old = '    except OSError:\n        return near, unknown, False\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, '    except OSError:\n        return near, unknown, True\n'), "agent_warden_mutant_near_cap_listing_complete")
        with scratch() as tmp:
            base = Path(tmp)
            cg = base / "cg"
            (cg / mutant.SLICE).mkdir(parents=True)
            initial = mutant.default_state()
            initial["episodes"] = {"tasks:lane.scope": {"kind": "tasks", "scope": "lane.scope", "since": 900.0, "notified": True}}
            _result, state, _notifications, _logs = self._run_near_cap_fixture(
                mutant, base / "state", cg, initial_state=initial, listing_raises=True)
        self.assertNotIn("tasks:lane.scope", state["episodes"])

    def test_notifier_fresh_stale_mutant_fails(self):
        text = WARDEN.read_text()
        old = '    return age < NOTIFIER_FRESH_SECONDS and age >= -NOTIFIER_FRESH_SECONDS\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, '    return True\n'), "agent_warden_mutant_notifier_fresh_stale")
        with scratch() as tmp:
            heartbeat = Path(tmp) / "notifier"
            heartbeat.write_text("")
            os.utime(heartbeat, (879.0, 879.0))
            self.assertTrue(mutant.notifier_fresh(heartbeat, now=1000.0))
            heartbeat.unlink()
            self.assertFalse(mutant.notifier_fresh(heartbeat, now=1000.0))

    def test_status_unreadable_state_fails(self):
        with scratch() as tmp:
            base = Path(tmp)
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"}, path=True)
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            state_dir = Path(env["XDG_RUNTIME_DIR"]) / "agent-warden"
            state_dir.mkdir(parents=True)
            (state_dir / "state.json").mkdir()
            result = subprocess.run([sys.executable, str(WARDEN), "--status"], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(result.stderr.splitlines()[0].startswith("agent-warden: state=unreadable "))
        self.assertEqual(result.stdout, "")

    def test_notification_handoff_mutant_fails(self):
        text = WARDEN.read_text()
        old = '    if consumer_fresh:\n        log(f"notice left to consumer: {summary}")\n        return "consumer"\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, old.replace("if consumer_fresh:", "if False:")), "agent_warden_mutant_notifier_handoff")
        calls = []
        mutant.deliver_notice("moved", "summary", "body", True, lambda k, s, b: calls.append((s, b)) or True)
        self.assertEqual(calls, [("summary", "body")])

    def test_episode_dedupe_mutant_fails(self):
        text = WARDEN.read_text()
        old = '    if rec.get("notified"):\n        return "none", key\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, '    if False:\n        return "none", key\n'), "agent_warden_mutant_episode_dedupe")
        calls = []
        st = mutant.default_state()
        mutant.deliver_episode_notice(st, "tasks", "lane.scope", "near", "body", False, 1000.0, lambda k, s, b: calls.append((s, b)) or True)
        mutant.deliver_episode_notice(st, "tasks", "lane.scope", "near", "body", False, 1001.0, lambda k, s, b: calls.append((s, b)) or True)
        self.assertEqual(calls.count(("near", "body")), 2)

    def test_failed_delivery_pending_mutant_fails(self):
        text = WARDEN.read_text()
        old = '        if (sender or notify)(kind, summary, body):\n            mark_episode_notified(st, key)\n            return "sent", key\n        return "failed", key\n'
        new = '        mark_episode_notified(st, key)\n        if (sender or notify)(kind, summary, body):\n            return "sent", key\n        return "failed", key\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, new), "agent_warden_mutant_failed_delivery")
        st = mutant.default_state()
        mutant.deliver_episode_notice(st, "tasks", "lane.scope", "near", "body", False, 1000.0, lambda k, s, b: False)
        self.assertTrue(st["episodes"]["tasks:lane.scope"].get("notified"))

    def test_notify_send_exit_mutant_fails(self):
        text = WARDEN.read_text()
        old = '    if result.returncode != 0:\n        log(f"notify-send failed: kind={kind} exit={result.returncode} summary={summary}")\n        return False\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, old.replace('if result.returncode != 0:', 'if False:')), "agent_warden_mutant_notify_exit")

        class Result:
            returncode = 7

        old_run = mutant.subprocess.run
        mutant.subprocess.run = lambda *a, **kw: Result()
        try:
            self.assertTrue(mutant.notify("tasks", "summary", "body"))
        finally:
            mutant.subprocess.run = old_run

    def test_run_headroom_preserves_move_failure_mutant_fails(self):
        text = WARDEN.read_text()
        old = '                    seen_move_conditions.add(episode_key("move-failure", root_scope))\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, ''), "agent_warden_mutant_move_failure_clear")
        with scratch() as tmp:
            initial = mutant.default_state()
            initial["episodes"] = {"move-failure:10:1": {"kind": "move-failure", "scope": "10:1", "since": 900.0, "notified": True}}
            _, state, _notifications = self._run_move_fixture(mutant, Path(tmp) / "state", initial_state=initial, headrooms=[(False, -1, -1)])
        self.assertNotIn("move-failure:10:1", state["episodes"])

    def test_near_cap_unknown_clear_mutant_fails(self):
        text = WARDEN.read_text()
        old = '                    seen_near.add(episode_key(kind, unit))\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, ''), "agent_warden_mutant_near_cap_unknown_clear")
        with scratch() as tmp:
            base = Path(tmp)
            initial = mutant.default_state()
            initial["episodes"] = {"tasks:lane.scope": {"kind": "tasks", "scope": "lane.scope", "since": 900.0, "notified": True}}
            self.write_near_cap_scope(base / "cg", "lane.scope", tasks=None, memory=0)
            _result, state, _notifications, _logs = self._run_near_cap_fixture(mutant, base / "state", base / "cg", initial_state=initial)
        self.assertNotIn("tasks:lane.scope", state["episodes"])

    def test_not_moving_seen_mutant_fails(self):
        text = WARDEN.read_text()
        old = '                    open_episode(st, "not-moving", SLICE, tick_now)\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, ''), "agent_warden_mutant_not_moving_seen")
        with scratch() as tmp:
            state_dir = Path(tmp) / "state"
            _result, state, notifications = self._run_move_fixture(mutant, state_dir, headrooms=[(False, -1, -1)])
        self.assertNotIn("not-moving:agents.slice", state["episodes"])
        self.assertEqual(notifications, [])

    def test_no_moves_clear_mutant_fails(self):
        text = WARDEN.read_text()
        old = '            if correct and only is None:\n                clear_episodes(st, {"not-moving", "move-failure"})\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, '            if False:\n                clear_episodes(st, {"not-moving", "move-failure"})\n'), "agent_warden_mutant_no_moves_clear")
        with scratch() as tmp:
            initial = mutant.default_state()
            initial["episodes"] = {"not-moving:agents.slice": {"kind": "not-moving", "scope": "agents.slice", "since": 900.0, "notified": True}}
            _result, state, _notifications = self._run_move_fixture(mutant, Path(tmp) / "state", initial_state=initial, plan_moves=[])
        self.assertIn("not-moving:agents.slice", state["episodes"])

    def test_final_selective_clear_mutant_fails(self):
        text = WARDEN.read_text()
        old = '        if move_conditions_evaluated and only is None:\n            clear_episodes(st, {"not-moving", "move-failure"}, seen_move_conditions)\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, ''), "agent_warden_mutant_final_selective_clear")
        with scratch() as tmp:
            initial = mutant.default_state()
            initial["episodes"] = {"move-failure:10:1": {"kind": "move-failure", "scope": "10:1", "since": 900.0, "notified": True}}
            _result, state, _notifications = self._run_move_fixture(
                mutant, Path(tmp) / "state", initial_state=initial,
                move_impl=lambda tree, reason, bus: (True, "unit.scope", tree, []))
        self.assertIn("move-failure:10:1", state["episodes"])

    def test_restricted_run_clear_mutant_fails(self):
        text = WARDEN.read_text()
        old = '            if correct and only is None:\n                clear_episodes(st, {"not-moving", "move-failure"})\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, old.replace(" and only is None", "")), "agent_warden_mutant_restricted_clear")
        with scratch() as tmp:
            state_dir = Path(tmp) / "state"
            self._run_move_fixture(mutant, state_dir)
            _result, state, _notifications = self._run_move_fixture(mutant, state_dir, plan_moves=[], only={999})
        self.assertNotIn("move-failure:10:1", state["episodes"])

    def test_restricted_run_final_clear_mutant_fails(self):
        text = WARDEN.read_text()
        old = '        if move_conditions_evaluated and only is None:\n            clear_episodes(st, {"not-moving", "move-failure"}, seen_move_conditions)\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, old.replace(" and only is None", "")), "agent_warden_mutant_restricted_final_clear")
        with scratch() as tmp:
            initial = mutant.default_state()
            initial["episodes"] = {"move-failure:10:1": {"kind": "move-failure", "scope": "10:1", "since": 900.0, "notified": True}}
            other = mutant.Proc(11, ppid=1, comm="claude", argv=["claude"], exe="/usr/bin/claude", cgroup=self.A, start=1)
            _result, state, _notifications = self._run_move_fixture(
                mutant, Path(tmp) / "state", initial_state=initial,
                plan_moves=[("escaped launch", [other])], only={11})
        self.assertNotIn("move-failure:10:1", state["episodes"])

    def test_selftest_state_dir_mutant_fails(self):
        text = WARDEN.read_text()
        old = '    with tempfile.TemporaryDirectory(prefix="agent-warden-selftest-") as tmp:\n        hb = Path(tmp) / "notifier"\n'
        new = '    hbdir = STATE_DIR / f"selftest-{os.getpid()}"\n    hbdir.mkdir(parents=True, exist_ok=True)\n    with tempfile.TemporaryDirectory(prefix="agent-warden-selftest-") as tmp:\n        hb = hbdir / "notifier"\n'
        self.assertEqual(text.count(old), 1)
        with scratch() as tmp:
            base = Path(tmp)
            mutant = materialize_warden_script(base, text.replace(old, new))
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise", "TMPDIR": base / "scratch"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR", "TMPDIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            result = subprocess.run([sys.executable, str(mutant), "--selftest"], env=env, capture_output=True, text=True)
            run_entries = os.listdir(env["XDG_RUNTIME_DIR"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotEqual(run_entries, [])

    def test_status_unreadable_state_mutant_fails(self):
        text = WARDEN.read_text()
        old = '    except FileNotFoundError:\n        return default_state()\n    except OSError:\n        print(f"agent-warden: state=unreadable {STATE}", file=sys.stderr)\n        raise\n'
        new = '    except OSError:\n        return default_state()\n'
        self.assertEqual(text.count(old), 1)
        with scratch() as tmp:
            base = Path(tmp)
            mutant = materialize_warden_script(base, text.replace(old, new))
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"}, path=True)
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            state_dir = Path(env["XDG_RUNTIME_DIR"]) / "agent-warden"
            state_dir.mkdir(parents=True)
            (state_dir / "state.json").mkdir()
            result = subprocess.run([sys.executable, str(mutant), "--status"], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotEqual(result.stdout, "")

    def test_status_directory_creation_mutant_fails(self):
        text = WARDEN.read_text()
        old = 'def status():\n    try:\n        st = read_state_unlocked()\n'
        self.assertEqual(text.count(old), 1)
        with scratch() as tmp:
            base = Path(tmp)
            mutant = materialize_warden_script(base, text.replace(old, 'def status():\n    STATE_DIR.mkdir(parents=True, exist_ok=True)\n    try:\n        st = read_state_unlocked()\n'))
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"}, path=True)
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            result = subprocess.run([sys.executable, str(mutant), "--status"], env=env, capture_output=True, text=True)
            run_entries = os.listdir(env["XDG_RUNTIME_DIR"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotEqual(run_entries, [])

    def test_status_rewrite_mutant_fails(self):
        text = WARDEN.read_text()
        old = '        st = read_state_unlocked()\n'
        self.assertEqual(text.count(old), 1)
        with scratch() as tmp:
            base = Path(tmp)
            mutant = materialize_warden_script(base, text.replace(old, '        st = read_state_unlocked()\n        STATE.write_text(STATE.read_text() + "\\n")\n'))
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"}, path=True)
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            state_dir = Path(env["XDG_RUNTIME_DIR"]) / "agent-warden"
            state_dir.mkdir(parents=True)
            state = state_dir / "state.json"
            body = json.dumps(self.w.default_state(), sort_keys=True).encode()
            state.write_bytes(body)
            before_mtime = state.stat().st_mtime_ns
            result = subprocess.run([sys.executable, str(mutant), "--status"], env=env, capture_output=True, text=True)
            after = state.read_bytes()
            after_mtime = state.stat().st_mtime_ns
            lock_exists = (state_dir / "lock").exists()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotEqual(after, body)
        self.assertNotEqual(after_mtime, before_mtime)
        self.assertFalse(lock_exists)

    def test_status_read_only_mutant_fails(self):
        text = WARDEN.read_text()
        old = 'def status():\n    try:\n        st = read_state_unlocked()\n    except OSError:\n        return 1\n'
        self.assertEqual(text.count(old), 1)
        with scratch() as tmp:
            base = Path(tmp)
            mutant = materialize_warden_script(base, text.replace(old, 'def status():\n    with State() as st:\n        pass\n'))
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"}, path=True)
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            state_dir = Path(env["XDG_RUNTIME_DIR"]) / "agent-warden"
            state_dir.mkdir(parents=True)
            state = state_dir / "state.json"
            state.write_text(json.dumps(self.w.default_state(), sort_keys=True))
            result = subprocess.run([sys.executable, str(mutant), "--status"], env=env, capture_output=True, text=True)
            lock_exists = (state_dir / "lock").exists()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(lock_exists)

    def test_selftest_subprocess_leaves_no_state_dir(self):
        with scratch() as tmp:
            base = Path(tmp)
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise", "TMPDIR": base / "scratch"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR", "TMPDIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            result = subprocess.run([sys.executable, str(WARDEN), "--selftest"], env=env, capture_output=True, text=True)
            run_entries = os.listdir(env["XDG_RUNTIME_DIR"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(run_entries, [])

