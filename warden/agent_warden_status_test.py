import contextlib
import io
import json
import os
from pathlib import Path
import re
import unittest
from unittest.mock import patch

from agent_warden_testlib import ROOT, WARDEN, WardenMutantMixin, WardenStateMixin, clean_env, default_tool_exe, load_warden, scratch


class AgentWardenStatusRules(WardenMutantMixin, WardenStateMixin, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = scratch()
        root = Path(cls.tmp.name)
        cls.env = clean_env({
            "HOME": root / "home",
            "XDG_RUNTIME_DIR": root / "run",
            "MISE_DATA_DIR": root / "mise-data",
        })
        for path in (root / "home", root / "run", root / "mise-data"):
            path.mkdir(parents=True, exist_ok=True)
        cls.w = load_warden(cls.env, "agent_warden_status_under_test")
        cls.A = "/user.slice/user-1000.slice/user@1000.service/app.slice/x.scope"
        cls.S = "/user.slice/user-1000.slice/user@1000.service/agents.slice/lane.scope"

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def P(self, pid, ppid, comm, argv, cg=None, exe=None, start=1, marked=False, tty=0):
        if exe is None:
            exe = default_tool_exe(self.w, comm)
        return self.w.Proc(pid, ppid=ppid, comm=comm, argv=argv, exe=exe, cgroup=cg or self.A, start=start, marked=marked, tty=tty)

    def _cg(self, unit):
        return f"/user.slice/user-{self.w.UID}.slice/user@{self.w.UID}.service/{self.w.SLICE}/{unit}"

    def write_status_cgroup(self, module, *, scope="agent-warden-1-2.scope", lane_memory="24"):
        slice_dir = module.CG_ROOT / module.SLICE
        lane = slice_dir / scope
        lane.mkdir(parents=True, exist_ok=True)
        values = {
            slice_dir: {
                "memory.current": "38",
                "memory.stat": "inactive_file 0\nfile_dirty 0\nfile_writeback 0\n",
                "memory.high": "64",
                "memory.max": "80",
                "pids.current": "300",
                "pids.max": "16384",
            },
            lane: {
                "memory.current": lane_memory,
                "memory.stat": "inactive_file 0\nfile_dirty 0\nfile_writeback 0\n",
                "memory.high": "64",
                "pids.current": "120",
                "pids.max": "8192",
            },
        }
        for directory, files in values.items():
            for name, value in files.items():
                (directory / name).write_text(value)
        return lane

    def status_writer_is_atomic(self, module):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(module, base)
            try:
                first = module.status_fixture_docs()["calm"]
                second = module.status_fixture_docs()["near-limit"]
                module.write_status(first)
                before_inode = module.STATUS.stat().st_ino
                observed = []
                old_replace = module.os.replace

                def spy_replace(src, dst):
                    observed.append(json.loads(Path(dst).read_text()))
                    old_replace(src, dst)

                module.os.replace = spy_replace
                old_umask = os.umask(0o077)
                try:
                    module.write_status(second)
                finally:
                    os.umask(old_umask)
                    module.os.replace = old_replace
                after = module.STATUS.stat()
                return (
                    observed == [first]
                    and after.st_ino != before_inode
                    and (after.st_mode & 0o777) == 0o644
                    and json.loads(module.STATUS.read_text()) == second
                    and not list(module.STATE_DIR.glob("status.tmp.*"))
                )
            finally:
                self.restore_status_state(module, old)

    def test_status_interval_env_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            rows = [
                ("0", 30),
                ("-5", 30),
                ("nan", 30),
                ("inf", 30),
                ("abc", 30),
                ("2.5", 2.5),
            ]
            for raw, expected in rows:
                with self.subTest(raw=raw):
                    safe = raw.replace("-", "neg").replace(".", "_")
                    env = clean_env({"HOME": base / f"home-{safe}", "XDG_RUNTIME_DIR": base / f"run-{safe}", "MISE_DATA_DIR": base / f"mise-{safe}", "AGENT_WARDEN_INTERVAL": raw})
                    for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                        Path(env[key]).mkdir(parents=True, exist_ok=True)
                    loaded = load_warden(env, "agent_warden_interval_" + safe)
                    self.assertEqual(loaded.STATUS_INTERVAL, expected)
        with scratch() as tmp:
            base = Path(tmp)
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            loaded = load_warden(env, "agent_warden_interval_allow_nan")
            old = self.point_status_state(loaded, base)
            try:
                with self.assertRaises(ValueError):
                    loaded.write_status({"bad": float("nan")})
            finally:
                self.restore_status_state(loaded, old)

    def test_status_writer_uses_rename_and_mode(self):
        self.assertTrue(self.status_writer_is_atomic(self.w))

    def test_memory_notice_reports_scope_soft_cap(self):
        with scratch() as tmp:
            old = self.point_status_state(self.w, Path(tmp))
            try:
                lane = self.write_status_cgroup(self.w, lane_memory=str(48 * 1024**3))
                for raw, expected in ((str(128 * 1024**3), [48, 128]), ("max", [48]),
                                      ("invalid", [48]), (None, [48])):
                    with self.subTest(raw=raw):
                        limit = lane / "memory.high"
                        if raw is None:
                            limit.unlink()
                        else:
                            limit.write_text(raw)
                        near, unknown, complete = self.w.warn_near_cap()
                        self.assertTrue(complete)
                        self.assertEqual(unknown, set())
                        notice = next(text for unit, kind, text in near
                                      if unit == lane.name and kind == "memory")
                        self.assertEqual([int(value) for value in re.findall(r"\b\d+\b", notice)], expected)
            finally:
                self.restore_status_state(self.w, old)

    def test_lane_near_judges_each_scope_against_its_own_limit(self):
        # agent-confine sets each scope's limits from the launching shell; AGENT_SCOPE_MEM_HIGH=infinity
        # and a raw systemd-run scope leave a limit at max.
        w, gib = self.w, 1024**3
        rows = [
            # name, tasks, pids.max, memory, memory.high, near
            ("both limited, at three quarters", 6144, "8192", 48 * gib, str(64 * gib), ["tasks", "memory"]),
            ("tasks unlimited", 6144, "max", 48 * gib, str(64 * gib), ["memory"]),
            ("both unlimited", 6144, "max", 48 * gib, "max", []),
            ("higher limits", 6144, "32768", 48 * gib, str(128 * gib), []),
            ("lower limits", 768, "1024", 6 * gib, str(8 * gib), ["tasks", "memory"]),
            ("just below lower limits", 767, "1024", 6 * gib - 1, str(8 * gib), []),
            ("limits unreadable", w.SCOPE_TASKS_WARN, "invalid", w.SCOPE_MEM_WARN, "invalid", ["tasks", "memory"]),
        ]
        with scratch() as tmp:
            old = self.point_status_state(w, Path(tmp))
            try:
                lane = self.write_status_cgroup(w)
                for name, tasks, tasks_max, memory, memory_high, expected in rows:
                    with self.subTest(name=name):
                        for file, value in (("pids.current", tasks), ("pids.max", tasks_max),
                                            ("memory.current", memory), ("memory.high", memory_high)):
                            (lane / file).write_text(str(value))
                        self.assertEqual([row["near"] for row in w.lane_statuses()], [expected])
            finally:
                self.restore_status_state(w, old)

    def test_memory_judgments_count_working_memory(self):
        # Past memory.high the kernel reclaims clean inactive file cache before it throttles, so
        # every memory judgment counts memory.current less inactive_file, file_dirty and
        # file_writeback kept. Each row writes one reading to the slice and to the lane; the
        # slice's slowdown point and the lane's memory.high are 64 GiB, the slice's memory.max
        # 80 GiB. The items table in test_status_items_rows holds each item's wording and actions.
        w, gib = self.w, 1024**3
        scope = "agent-warden-100-200.scope"
        rows = [
            # name, memory.current GiB, memory.stat counters GiB or None for an unread file,
            # working memory GiB or None, item kinds, headroom(), near-cap notice numbers or None for unread
            ("cache past the slowdown point and the lane's three quarters", 70,
             {"inactive_file": 60, "file_dirty": 0, "file_writeback": 0}, 10, [], (True, 10 * gib, 80 * gib), []),
            ("working memory past the slowdown point and the lane's three quarters", 70,
             {"inactive_file": 1, "file_dirty": 0, "file_writeback": 0}, 69, ["slowdown", "near-limit"],
             (True, 69 * gib, 80 * gib), [69, 64]),
            ("cache past the headroom guard", 75,
             {"inactive_file": 70, "file_dirty": 0, "file_writeback": 0}, 5, [], (True, 5 * gib, 80 * gib), []),
            ("working memory past the headroom guard", 75,
             {"inactive_file": 1, "file_dirty": 0, "file_writeback": 0}, 74, ["memory-full", "near-limit"],
             (False, 74 * gib, 80 * gib), [74, 64]),
            ("inactive cache dirty, past the headroom guard", 75,
             {"inactive_file": 12, "file_dirty": 12, "file_writeback": 0}, 75, ["memory-full", "near-limit"],
             (False, 75 * gib, 80 * gib), [75, 64]),
            ("inactive cache under writeback, past the headroom guard", 75,
             {"inactive_file": 12, "file_dirty": 0, "file_writeback": 12}, 75, ["memory-full", "near-limit"],
             (False, 75 * gib, 80 * gib), [75, 64]),
            ("memory.stat unread", 70, None, None, ["memory-unread"], (False, -1, -1), None),
            ("memory.stat without file_writeback", 70, {"inactive_file": 60, "file_dirty": 0}, None,
             ["memory-unread"], (False, -1, -1), None),
        ]
        agent = self.P(100, 1, "claude", ["claude"], self._cg(scope), start=200)
        with scratch() as tmp, patch.object(w, "_worktree_label", return_value="vsy-276"):
            old = self.point_status_state(w, Path(tmp))
            try:
                lane = self.write_status_cgroup(w, scope=scope)
                slice_dir = lane.parent
                for d in (slice_dir, lane):
                    (d / "memory.high").write_text(str(64 * gib))
                (slice_dir / "memory.max").write_text(str(80 * gib))
                for name, current, stat, working, kinds, headroom, notice in rows:
                    with self.subTest(name=name):
                        for d in (slice_dir, lane):
                            (d / "memory.current").write_text(str(current * gib))
                            (d / "memory.stat").unlink(missing_ok=True)
                            if stat is not None:
                                (d / "memory.stat").write_text(
                                    f"anon {gib}\nfile {(current - 1) * gib}\n"
                                    + "".join(f"{key} {value * gib}\n" for key, value in stat.items()))
                        doc = w.status_document("correct", {"_state_readable": True}, slice_reading=w.slice_status(),
                                                lanes=w.lane_statuses({agent.pid: agent}), reap=True, moves=[],
                                                waiting=[], orphans_status=[], contained=[], now=1)
                        self.assertEqual(w.status_errors(doc), [])
                        figure = None if working is None else working * gib
                        self.assertEqual((doc["slice"]["memory"], doc["lanes"][0]["memory"]), (figure, figure))
                        self.assertEqual([item["kind"] for item in doc["items"]], kinds)
                        self.assertEqual(w.headroom(), headroom)
                        near, unknown, complete = w.warn_near_cap()
                        self.assertTrue(complete)
                        self.assertEqual(unknown, set() if notice is not None else {(scope, "memory")})
                        self.assertEqual([[int(value) for value in re.findall(r"\b\d+\b", text)]
                                          for unit, kind, text in near if kind == "memory"],
                                         [notice] if notice else [])
            finally:
                self.restore_status_state(w, old)

    def test_text_status_preserves_counter_knowledge(self):
        with scratch() as tmp:
            old = self.point_status_state(self.w, Path(tmp))
            try:
                self.w.STATE_DIR.mkdir()
                rows = (
                    ("fresh", None, False, 0),
                    ("zero", "valid", False, 0),
                    ("counted", "valid", False, 7),
                    ("unknown", "unknown", False, None),
                    ("recovered", "invalid JSON", True, None),
                    ("malformed", "invalid JSON", False, None),
                    ("truncated", '{"moves":', False, None),
                    ("invalid object", '{"moves": "wrong"}', False, None),
                    ("invalid shape", "[]", False, None),
                )
                for name, raw, recovered, count in rows:
                    with self.subTest(name=name):
                        st = self.w.default_state()
                        for _, internal in self.w.STATUS_COUNTER_KEYS_PUBLIC:
                            st[internal] = count if count is not None else 0
                        st["counters_unknown"] = raw == "unknown"
                        if raw is None:
                            self.w.STATE.unlink(missing_ok=True)
                        else:
                            self.w.STATE.write_text(json.dumps(st) if raw in ("valid", "unknown") else raw)
                        if recovered:
                            with self.w.State():
                                pass
                            self.assertTrue(self.w.read_state_unlocked()["counters_unknown"])
                        before = self.w.STATE.read_bytes() if self.w.STATE.exists() else None
                        counters = self.w.status_counters(self.w.read_state_unlocked())
                        self.assertEqual(set(counters.values()), {count})
                        for _ in range(2):
                            output = io.StringIO()
                            with patch.object(self.w, "scan", return_value={}), \
                                    patch.object(self.w, "notifier_fresh", return_value=False), \
                                    contextlib.redirect_stdout(output):
                                self.assertEqual(self.w.status(), 0)
                            values = [int(value) for value in re.findall(r"\b\d+\b", output.getvalue().splitlines()[0])]
                            self.assertEqual(values, [] if count is None else [count] * len(counters))
                            after = self.w.STATE.read_bytes() if self.w.STATE.exists() else None
                            self.assertEqual(after, before)
            finally:
                self.restore_status_state(self.w, old)

    def test_failed_state_read_zero_mutants_fail(self):
        text = WARDEN.read_text()
        rows = (
            ("invalid object", '    if raw is None:\n        raise ValueError("invalid state")\n',
             '    if raw is None:\n        return default_state()\n'),
            ("malformed", '    except Exception:  # noqa: BLE001\n        return {**default_state(), "counters_unknown": True}\n',
             '    except Exception:  # noqa: BLE001\n        return default_state()\n'),
        )
        for name, old, replacement in rows:
            with self.subTest(name=name):
                self.assertEqual(text.count(old), 1)
                mutant = self.load_mutant(text.replace(old, replacement), "agent_warden_failed_state_zero")
                case = AgentWardenStatusRules("test_text_status_preserves_counter_knowledge")
                result = unittest.TestResult()
                with patch.object(AgentWardenStatusRules, "w", mutant):
                    case.run(result)
                self.assertEqual(result.errors, [])
                self.assertTrue(any(test.params.get("name") == name for test, _ in result.failures))

    def test_status_writer_handles_short_writes(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            old_write = self.w.os.write
            calls = []
            def short_write(fd, data):
                calls.append(len(data))
                return old_write(fd, data[:1])
            self.w.os.write = short_write
            try:
                doc = self.w.status_fixture_docs()["holding-off"]
                self.w.write_status(doc)
                self.assertEqual(json.loads(self.w.STATUS.read_text()), doc)
                self.assertGreater(len(calls), 1)
            finally:
                self.w.os.write = old_write
                self.restore_status_state(self.w, old)

    def test_status_writer_cleans_temp_on_replace_failure(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            old_replace = self.w.os.replace
            self.w.os.replace = lambda src, dst: (_ for _ in ()).throw(OSError("replace failed"))
            try:
                with self.assertRaises(OSError):
                    self.w.write_status(self.w.status_fixture_docs()["calm"])
                self.assertEqual(list(self.w.STATE_DIR.glob("status.tmp.*")), [])
            finally:
                self.w.os.replace = old_replace
                self.restore_status_state(self.w, old)

    def test_status_writer_in_place_mutant_fails(self):
        text = WARDEN.read_text()
        old = "    os.replace(tmp, STATUS)\n"
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, "    STATUS.write_bytes(data)\n"), "agent_warden_mutant_status_in_place")
        self.assertFalse(self.status_writer_is_atomic(mutant))

    def test_unreadable_status_counters_stay_null(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            try:
                lane = self.w.CG_ROOT / self.w.SLICE / "agent-warden-1-2.scope"
                lane.mkdir(parents=True)
                doc = self.w.status_document("report", {"_state_readable": True},
                                             slice_reading=self.w.slice_status(), lanes=self.w.lane_statuses(),
                                             reap=False, moves=[], waiting=[], orphans_status=[], contained=[], now=1)
                self.assertIsNone(doc["slice"]["memory"])
                self.assertIsNone(doc["slice"]["tasks"])
                self.assertIsNone(doc["lanes"][0]["tasks"])
                self.assertIsNone(doc["lanes"][0]["memory"])
                self.assertNotEqual(doc["slice"]["memory"], 0)
                self.w.STATE_DIR.mkdir(parents=True, exist_ok=True)
                for bad_state in (
                    "{",
                    "[]",
                    json.dumps({"moves": "wrong"}),
                    json.dumps({"moves": -1}),
                    json.dumps({"events": {}}),
                    json.dumps({"events": [{}]}),
                    json.dumps({"events": [{"id": 1, "time": 1, "kind": [], "scope": None, "pid": None, "processes": None, "near": None}]}),
                    json.dumps({"event_seq": "1"}),
                    json.dumps({"near_open": [1]}),
                    json.dumps({"scratch_failed": [1]}),
                ):
                    with self.subTest(bad_state=bad_state):
                        self.w.STATE.write_text(bad_state)
                        with self.w.State() as st:
                            counters = self.w.status_counters(st)
                            st.setdefault("events", []).append({"test": True})
                        self.assertEqual(counters, {"moves": None, "partial": None, "reaped": None, "moveFailures": None, "scanFailures": None, "skips": None})
                        self.assertEqual(self.w.DEFAULT_STATE["events"], [])
                self.w.STATE.unlink(missing_ok=True)
                self.w.STATUS.unlink(missing_ok=True)
                with self.w.State() as st:
                    self.assertEqual(self.w.status_counters(st), {"moves": 0, "partial": 0, "reaped": 0, "moveFailures": 0, "scanFailures": 0, "skips": 0})
                self.w.STATE.unlink(missing_ok=True)
                self.w.STATUS.write_text(json.dumps({"schema": "1.0", "counters": {"moves": 7, "partial": 6, "reaped": 5, "moveFailures": 4, "scanFailures": 3, "skips": 2}}))
                with self.w.State() as st:
                    self.assertEqual(self.w.status_counters(st), {"moves": 7, "partial": 6, "reaped": 5, "moveFailures": 4, "scanFailures": 3, "skips": 2})
                self.assertEqual(json.loads(self.w.STATE.read_text())["moves"], 7)
                self.w.STATE.unlink(missing_ok=True)
                self.w.STATUS.write_text(json.dumps({"schema": "1.0", "counters": {"moves": None, "partial": None, "reaped": None, "moveFailures": None, "scanFailures": None, "skips": None}}))
                with self.w.State() as st:
                    self.assertEqual(self.w.status_counters(st), {"moves": None, "partial": None, "reaped": None, "moveFailures": None, "scanFailures": None, "skips": None})
                stored = json.loads(self.w.STATE.read_text())
                self.assertTrue(stored["counters_unknown"])
                self.w.STATE.unlink(missing_ok=True)
                self.w.STATUS.write_text(json.dumps({"schema": "1.0", "counters": {"moves": -1, "partial": 0, "reaped": 0, "moveFailures": 0, "scanFailures": 0, "skips": 0}}))
                with self.w.State() as st:
                    self.assertEqual(self.w.status_counters(st), {"moves": None, "partial": None, "reaped": None, "moveFailures": None, "scanFailures": None, "skips": None})
                with self.w.State() as st:
                    self.assertEqual(self.w.status_counters(st), {"moves": None, "partial": None, "reaped": None, "moveFailures": None, "scanFailures": None, "skips": None})
                self.w.STATE.unlink(missing_ok=True)
                self.w.STATUS.write_text(json.dumps({"schema": "2.0", "events": [
                    {"id": 9000, "time": 1, "kind": "moved", "scope": None, "pid": None, "processes": None, "near": None},
                ], "counters": {"moves": 7, "partial": 6, "reaped": 5, "moveFailures": 4, "scanFailures": 3, "skips": 2}}))
                with self.w.State() as st:
                    self.assertEqual(st["events"], [])
                    self.assertEqual(self.w.status_counters(st), {"moves": None, "partial": None, "reaped": None, "moveFailures": None, "scanFailures": None, "skips": None})
                    self.assertEqual(self.w.emit_event(st, "moved", now=1)["id"], 1000)
                mgr = 4000
                unit = "agent-confine-counter-unknown.scope"
                (self.w.CG_ROOT / self.w.SLICE / unit).mkdir(parents=True)
                recs = {mgr: self.P(mgr, 1, "systemd", ["/usr/lib/systemd/systemd", "--user"], "/user.slice"),
                        8000: self.P(8000, mgr, "bun", ["bun"], self._cg(unit), exe="/usr/bin/bun")}
                with self.w.State() as st:
                    _, rows = self.w.reap_orphans(recs, st, True)
                    first = rows[0]["since"]
                with self.w.State() as st:
                    _, rows = self.w.reap_orphans(recs, st, True)
                    self.assertEqual(rows[0]["since"], first)
            finally:
                self.restore_status_state(self.w, old)


    def test_status_slice_stat_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            old_stat = Path.stat
            try:
                slice_dir = self.w.CG_ROOT / self.w.SLICE
                slice_dir.mkdir(parents=True)

                def blocked_stat(path, *args, **kwargs):
                    if path == slice_dir:
                        raise PermissionError("blocked")
                    return old_stat(path, *args, **kwargs)

                Path.stat = blocked_stat
                self.assertEqual(self.w.slice_status(), {"memory": None, "high": None, "max": None, "tasks": None, "tasksMax": None, "headroomOk": None})
                self.assertIsNone(self.w.lane_statuses())
                def missing_stat(path, *args, **kwargs):
                    if path == slice_dir:
                        raise FileNotFoundError("missing")
                    return old_stat(path, *args, **kwargs)

                Path.stat = missing_stat
                self.assertIsNone(self.w.slice_status())
                self.assertEqual(self.w.lane_statuses(), [])
            finally:
                Path.stat = old_stat
                self.restore_status_state(self.w, old)

    def test_status_lane_entry_stat_error_stays_unknown(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            old_stat = Path.stat
            try:
                lane = self.write_status_cgroup(self.w)

                def checked_stat(path, *args, **kwargs):
                    if path == lane:
                        raise PermissionError("blocked")
                    return old_stat(path, *args, **kwargs)

                Path.stat = checked_stat
                self.assertIsNone(self.w.lane_statuses())
                def missing_stat(path, *args, **kwargs):
                    if path == lane:
                        raise FileNotFoundError("missing")
                    return old_stat(path, *args, **kwargs)

                Path.stat = missing_stat
                self.assertEqual(self.w.lane_statuses(), [])
            finally:
                Path.stat = old_stat
                self.restore_status_state(self.w, old)

    def test_unreadable_lane_listing_stays_null(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            old_iterdir = Path.iterdir
            try:
                slice_dir = self.w.CG_ROOT / self.w.SLICE
                slice_dir.mkdir(parents=True)

                def checked_iterdir(path):
                    if path == slice_dir:
                        raise OSError("blocked")
                    return old_iterdir(path)

                Path.iterdir = checked_iterdir
                lanes = self.w.lane_statuses()
                doc = self.w.status_document("report", {"_state_readable": True},
                                             slice_reading=self.w.slice_status(), lanes=lanes,
                                             reap=False, moves=[], waiting=[], orphans_status=[], contained=[], now=1)
                self.assertIsNone(doc["lanes"])
                self.assertFalse(self.w.status_errors(doc))
            finally:
                Path.iterdir = old_iterdir
                self.restore_status_state(self.w, old)

    def test_orphan_reap_exception_status_is_null(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            old_scan, old_plan, old_reap = self.w.scan, self.w.plan, self.w.reap_orphans
            root = self.P(9100, 1, "claude", ["claude"], self.A, start=7)
            self.w.scan = lambda: {root.pid: root}
            self.w.plan = lambda procs, only=None: ([], [], [], [])
            self.w.reap_orphans = lambda procs, st, correct, only=None: (_ for _ in ()).throw(RuntimeError("orphan boom"))
            try:
                result = self.w.run(False)
                doc = json.loads(self.w.STATUS.read_text())
            finally:
                self.w.scan, self.w.plan, self.w.reap_orphans = old_scan, old_plan, old_reap
                self.restore_status_state(self.w, old)
        self.assertEqual(result, 0)
        self.assertIsNone(doc["orphans"])
        self.assertFalse(self.w.status_errors(doc))

    def test_failed_scan_tick_writes_error_status(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            self.write_status_cgroup(self.w)
            old_scan = self.w.scan
            self.w.scan = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
            try:
                result = self.w.run(False)
                doc = json.loads(self.w.STATUS.read_text())
            finally:
                self.w.scan = old_scan
                self.restore_status_state(self.w, old)
        self.assertEqual(result, 1)
        self.assertEqual(doc["error"], "scan")
        self.assertEqual(doc["slice"]["memory"], 38)
        self.assertEqual(doc["slice"]["tasks"], 300)
        self.assertEqual(doc["lanes"][0]["scope"], "agent-warden-1-2.scope")
        self.assertEqual(doc["lanes"][0]["memory"], 24)
        self.assertEqual(doc["lanes"][0]["tasks"], 120)
        self.assertIsNone(doc["outside"])
        self.assertIsNone(doc["waiting"])
        self.assertIsNone(doc["orphans"])
        self.assertIsNone(doc["contained"])
        self.assertIsNone(doc["leftovers"])
        self.assertFalse(self.w.status_errors(doc))

    def test_each_leftover_pass_nulls_only_its_own_reading(self):
        # A pass that raises leaves the other readings and the moves alone.
        root = self.P(9200, 1, "claude", ["claude"], self.A, start=7)
        raising = lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom"))  # noqa: E731
        rows = [
            ("every pass reads", {}, {"testWorlds": 3, "failedUnits": 2, "testProcesses": 1,
                                      "testProcessRepos": [{"repo": "vgshell", "processes": 1}]}),
            ("the world pass raises", {"reap_test_worlds": raising},
             {"testWorlds": None, "failedUnits": 2, "testProcesses": 1,
              "testProcessRepos": [{"repo": "vgshell", "processes": 1}]}),
            ("the process report raises", {"report_test_processes": raising},
             {"testWorlds": 3, "failedUnits": 2, "testProcesses": None, "testProcessRepos": None}),
            ("the unit pass raises", {"_failed_unit_pass": raising},
             {"testWorlds": 3, "failedUnits": None, "testProcesses": 1,
              "testProcessRepos": [{"repo": "vgshell", "processes": 1}]}),
            ("the world scan raises", {"scan": lambda: next(scans)},
             {"testWorlds": None, "failedUnits": 2, "testProcesses": None, "testProcessRepos": None}),
        ]
        for name, overrides, expected in rows:
            # plan()'s scan, then the world scan: the scratch pass scans only
            # once a gone folder is past its grace, and this sandbox has none.
            scans = iter([{root.pid: root}])
            stubs = {
                "scan": lambda: {root.pid: root},
                "plan": lambda procs, only=None: ([], [], [], []),
                "reap_orphans": lambda procs, st, correct, only=None: ([], []),
                "enforce_task_caps": lambda correct: [],
                "warn_near_cap": lambda: ([], set(), True),
                "reap_test_worlds": lambda correct, scan, failed: (3, []),
                "report_test_processes": lambda procs: [{"repo": "vgshell", "processes": 1}],
                "_failed_unit_pass": lambda correct: 2,
                "TEST_WORLD_PATTERNS": ("/tmp/vgw-world.*",),
                **overrides,
            }
            with self.subTest(name=name), scratch() as tmp:
                old = self.point_status_state(self.w, Path(tmp))
                try:
                    with contextlib.ExitStack() as stack:
                        for attribute, value in stubs.items():
                            stack.enter_context(patch.object(self.w, attribute, value))
                        stack.enter_context(patch.object(self.w, "log"))
                        self.assertEqual(self.w.run(False), 0)
                    doc = json.loads(self.w.STATUS.read_text())
                finally:
                    self.restore_status_state(self.w, old)
                self.assertEqual(doc["leftovers"], expected)
                self.assertFalse(self.w.status_errors(doc))

    def test_status_and_only_runs_do_not_write_status(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            sentinel = {"sentinel": True}
            self.w.STATE_DIR.mkdir(parents=True, exist_ok=True)
            self.w.STATUS.write_text(json.dumps(sentinel))
            root = self.P(9200, 1, "claude", ["claude"], self.S, start=7)
            old_scan, old_plan = self.w.scan, self.w.plan
            self.w.scan = lambda: {root.pid: root}
            self.w.plan = lambda procs, only=None: ([], [], [], [])
            try:
                self.assertEqual(self.w.status(), 0)
                self.assertEqual(json.loads(self.w.STATUS.read_text()), sentinel)
            finally:
                self.w.scan, self.w.plan = old_scan, old_plan
                self.restore_status_state(self.w, old)
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            sentinel = {"sentinel": True}
            self.w.STATE_DIR.mkdir(parents=True, exist_ok=True)
            self.w.STATUS.write_text(json.dumps(sentinel))
            old_scan, old_plan = self.w.scan, self.w.plan
            old_env = os.environ.get("AGENT_WARDEN_ONLY")
            root = self.P(9300, 1, "claude", ["claude"], self.A, start=8)
            self.w.scan = lambda: {root.pid: root}
            self.w.plan = lambda procs, only=None: ([], [], [], [])
            os.environ["AGENT_WARDEN_ONLY"] = str(root.pid)
            try:
                self.assertEqual(self.w.run(True), 0)
                self.assertEqual(json.loads(self.w.STATUS.read_text()), sentinel)
            finally:
                if old_env is None:
                    os.environ.pop("AGENT_WARDEN_ONLY", None)
                else:
                    os.environ["AGENT_WARDEN_ONLY"] = old_env
                self.w.scan, self.w.plan = old_scan, old_plan
                self.restore_status_state(self.w, old)
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            sentinel = {"sentinel": True}
            self.w.STATE_DIR.mkdir(parents=True, exist_ok=True)
            self.w.STATUS.write_text(json.dumps(sentinel))
            try:
                self.assertEqual(self.w.main(["agent-warden", "--selftest"]), 0)
                self.assertEqual(json.loads(self.w.STATUS.read_text()), sentinel)
            finally:
                self.restore_status_state(self.w, old)

    def test_event_ids_increase_across_state_reopen_and_reset(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            try:
                with self.w.State() as st:
                    first = self.w.emit_event(st, "moved", now=1)["id"]
                with self.w.State() as st:
                    second = self.w.emit_event(st, "moved", now=1)["id"]
                self.assertGreater(second, first)
                self.w.STATE.unlink()
                with self.w.State() as st:
                    third = self.w.emit_event(st, "moved", now=2)["id"]
                self.assertGreater(third, second)
                st = {"_state_readable": True, "event_seq": 0, "events": [
                    {"id": 5000, "time": 1, "kind": "moved", "scope": None, "pid": None, "processes": None, "near": None},
                ]}
                event = self.w.emit_event(st, "moved", now=1)
                self.assertGreater(event["id"], 5000)
                doc = self.w.status_document("report", st, slice_reading=None, lanes=[],
                                             reap=False, moves=[], waiting=[], orphans_status=[], contained=[], now=1)
                self.assertFalse(self.w.status_errors(doc))
                self.w.STATE.unlink(missing_ok=True)
                self.w.STATUS.write_text(json.dumps({"schema": "1.0", "events": [
                    {"id": 9000, "time": 1, "kind": "moved", "scope": None, "pid": None, "processes": None, "near": None},
                ], "counters": {"moves": 0, "partial": 0, "reaped": 0, "moveFailures": 0, "scanFailures": 0, "skips": 0}}))
                with self.w.State(status="report") as st:
                    st["_tick"] = {"procs": {}, "moves": [], "waiting": [], "waiting_events": [], "orphans": [], "contained": [], "error": None}
                self.assertEqual(json.loads(self.w.STATE.read_text())["event_seq"], 9000)
                self.assertEqual(json.loads(self.w.STATUS.read_text())["events"][0]["id"], 9000)
                old_scan, old_plan = self.w.scan, self.w.plan
                self.w.scan = lambda: {}
                self.w.plan = lambda procs, only=None: ([], [], [], [])
                try:
                    self.assertEqual(self.w.status(), 0)
                finally:
                    self.w.scan, self.w.plan = old_scan, old_plan
                self.w.STATE.unlink(missing_ok=True)
                with self.w.State() as st:
                    fourth = self.w.emit_event(st, "moved", now=1)["id"]
                self.assertGreater(fourth, 9000)
                self.w.STATE.unlink(missing_ok=True)
                self.w.STATUS.write_text(json.dumps({"schema": "1.1", "events": [
                    {"id": 9000, "time": 1, "kind": "future-kind", "scope": None, "pid": None, "processes": None, "near": None},
                ], "counters": {"moves": 0, "partial": 0, "reaped": 0, "moveFailures": 0, "scanFailures": 0, "skips": 0}}))
                with self.w.State() as st:
                    self.assertEqual(st["events"], [])
                    self.assertGreater(self.w.emit_event(st, "moved", now=1)["id"], 9000)
                for bad_id in (-1, True):
                    with self.subTest(bad_id=bad_id):
                        self.w.STATE.unlink(missing_ok=True)
                        self.w.STATUS.write_text(json.dumps({"schema": "1.0", "events": [
                            {"id": bad_id, "time": 1, "kind": "moved", "scope": None, "pid": None, "processes": None, "near": None},
                        ], "counters": {"moves": 0, "partial": 0, "reaped": 0, "moveFailures": 0, "scanFailures": 0, "skips": 0}}))
                        with self.w.State() as st:
                            self.assertEqual(st["events"], [])
                            self.assertEqual(self.w.emit_event(st, "moved", now=1)["id"], 1000)
            finally:
                self.restore_status_state(self.w, old)

    def test_waiting_episode_reopens_after_no_moves_tick(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            self.write_status_cgroup(self.w)
            root = self.P(9400, 1, "claude", ["claude"], self.A, start=42)
            plans = iter((
                ([("escaped launch", [root])], [], [], []),
                ([], [], [], []),
                ([("escaped launch", [root])], [], [], []),
            ))
            old_scan, old_plan, old_reap = self.w.scan, self.w.plan, self.w.reap_orphans
            old_enforce, old_warn, old_headroom = self.w.enforce_task_caps, self.w.warn_near_cap, self.w.headroom
            old_bus, old_notify = self.w.Bus, self.w.notify
            class FakeBus:
                def close(self):
                    pass
            self.w.scan = lambda: {root.pid: root}
            self.w.plan = lambda procs, only=None: next(plans)
            self.w.reap_orphans = lambda procs, st, correct, only=None: ([], [])
            self.w.enforce_task_caps = lambda correct: []
            self.w.warn_near_cap = lambda: []
            self.w.headroom = lambda: (False, 95, 100)
            self.w.Bus = FakeBus
            self.w.notify = lambda kind, summary, body: None
            try:
                self.assertEqual(self.w.run(True), 0)
                self.assertEqual(self.w.run(True), 0)
                self.assertEqual(self.w.run(True), 0)
                state = json.loads(self.w.STATE.read_text())
            finally:
                self.w.scan, self.w.plan, self.w.reap_orphans = old_scan, old_plan, old_reap
                self.w.enforce_task_caps, self.w.warn_near_cap, self.w.headroom = old_enforce, old_warn, old_headroom
                self.w.Bus, self.w.notify = old_bus, old_notify
                self.restore_status_state(self.w, old)
        waiting = [event for event in state["events"] if event["kind"] == "waiting"]
        self.assertEqual(len(waiting), 2)
        self.assertEqual(waiting[0]["pid"], root.pid)
        self.assertEqual(waiting[1]["pid"], root.pid)

    def test_report_and_bus_failure_keep_waiting_episode_open(self):
        class FakeBus:
            def close(self):
                pass

        class RaisingBus:
            def __init__(self):
                raise OSError("no bus")

        def run_sequence(correct_flags, bus_classes):
            with scratch() as tmp:
                base = Path(tmp)
                old = self.point_status_state(self.w, base)
                self.write_status_cgroup(self.w)
                root = self.P(9500, 1, "claude", ["claude"], self.A, start=43)
                wait_plan = ([('escaped launch', [root])], [], [], [])
                plans = iter((wait_plan, wait_plan, wait_plan))
                buses = iter(bus_classes)
                old_scan, old_plan, old_reap = self.w.scan, self.w.plan, self.w.reap_orphans
                old_enforce, old_warn, old_headroom = self.w.enforce_task_caps, self.w.warn_near_cap, self.w.headroom
                old_bus, old_notify, old_units = self.w.Bus, self.w.notify, self.w._failed_unit_pass
                # The bus sequence is the moves' alone.
                self.w._failed_unit_pass = lambda correct: None
                self.w.scan = lambda: {root.pid: root}
                self.w.plan = lambda procs, only=None: next(plans)
                self.w.reap_orphans = lambda procs, st, correct, only=None: ([], [])
                self.w.enforce_task_caps = lambda correct: []
                self.w.warn_near_cap = lambda: []
                self.w.headroom = lambda: (False, 95, 100)
                self.w.Bus = lambda: next(buses)()
                self.w.notify = lambda kind, summary, body: None
                try:
                    results = [self.w.run(correct) for correct in correct_flags]
                    state = json.loads(self.w.STATE.read_text())
                finally:
                    self.w.scan, self.w.plan, self.w.reap_orphans = old_scan, old_plan, old_reap
                    self.w.enforce_task_caps, self.w.warn_near_cap, self.w.headroom = old_enforce, old_warn, old_headroom
                    self.w.Bus, self.w.notify, self.w._failed_unit_pass = old_bus, old_notify, old_units
                    self.restore_status_state(self.w, old)
            return results, [event for event in state["events"] if event["kind"] == "waiting"]

        results, waiting = run_sequence((True, False, True), (FakeBus, FakeBus))
        self.assertEqual(results, [0, 0, 0])
        self.assertEqual(len(waiting), 1)
        results, waiting = run_sequence((True, True, True), (FakeBus, RaisingBus, FakeBus))
        self.assertEqual(results, [0, 1, 0])
        self.assertEqual(len(waiting), 1)

    def test_bad_orphan_state_is_dropped_before_reap(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            try:
                unit = "agent-confine-bad.scope"
                (self.w.CG_ROOT / self.w.SLICE / unit).mkdir(parents=True)
                now = self.w.time.time()
                self.w.STATE_DIR.mkdir(parents=True, exist_ok=True)
                self.w.STATE.write_text(json.dumps({"orphans": {unit: {"first": now - self.w.ORPHAN_GRACE - 10, "usage": None, "usage_ts": now - 1, "harmful": "yes"}}}))
                with self.w.State() as st:
                    self.assertEqual(st["orphans"], {})
                    mgr = 4000
                    cg = self._cg(unit)
                    recs = {mgr: self.P(mgr, 1, "systemd", ["/usr/lib/systemd/systemd", "--user"], "/user.slice")}
                    for i in range(self.w.ORPHAN_PROC_MAX):
                        recs[7000 + i] = self.P(7000 + i, mgr, "bun", ["bun"], cg, exe="/usr/bin/bun")
                    reaped, rows = self.w.reap_orphans(recs, st, True)
                self.assertEqual(reaped, [])
                self.assertEqual([row["scope"] for row in rows], [unit])
            finally:
                self.restore_status_state(self.w, old)

    def test_state_write_survives_status_write_failure(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            old_write = self.w.write_status
            self.w.write_status = lambda doc: (_ for _ in ()).throw(RuntimeError("status boom"))
            try:
                with self.w.State(status="report") as st:
                    st["moves"] = 3
                    st["_tick"] = {"procs": {}, "moves": [], "waiting": [], "waiting_events": [], "orphans": [], "contained": [], "error": None}
                stored = json.loads(self.w.STATE.read_text())
                self.assertEqual(stored["moves"], 3)
                with os.fdopen(os.open(self.w.LOCK, os.O_RDWR), "r+") as lock_file:
                    self.w.fcntl.flock(lock_file, self.w.fcntl.LOCK_EX | self.w.fcntl.LOCK_NB)
                    self.w.fcntl.flock(lock_file, self.w.fcntl.LOCK_UN)
            finally:
                self.w.write_status = old_write
                self.restore_status_state(self.w, old)
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            old_write = self.w.write_status
            observed = []
            def record_after_state(doc):
                observed.append(json.loads(self.w.STATE.read_text())["moves"])
            self.w.write_status = record_after_state
            try:
                with self.w.State(status="report") as st:
                    st["moves"] = 4
                    st["_tick"] = {"procs": {}, "moves": [], "waiting": [], "waiting_events": [], "orphans": [], "contained": [], "error": None}
                self.assertEqual(observed, [4])
            finally:
                self.w.write_status = old_write
                self.restore_status_state(self.w, old)

    def test_move_exception_failed_event_processes_unknown(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            self.write_status_cgroup(self.w)
            root = self.P(9600, 1, "claude", ["claude"], self.A, start=44)
            old_scan, old_plan, old_reap = self.w.scan, self.w.plan, self.w.reap_orphans
            old_enforce, old_warn, old_headroom = self.w.enforce_task_caps, self.w.warn_near_cap, self.w.headroom
            old_bus, old_move, old_notify = self.w.Bus, self.w.move, self.w.notify
            class FakeBus:
                def close(self):
                    pass
            self.w.scan = lambda: {root.pid: root}
            self.w.plan = lambda procs, only=None: ([('escaped launch', [root])], [], [], [])
            self.w.reap_orphans = lambda procs, st, correct, only=None: ([], [])
            self.w.enforce_task_caps = lambda correct: []
            self.w.warn_near_cap = lambda: ([], set(), True)
            self.w.headroom = lambda: (True, 1, 100)
            self.w.Bus = FakeBus
            self.w.move = lambda tree, reason, bus: (_ for _ in ()).throw(RuntimeError("boom"))
            self.w.notify = lambda kind, summary, body: None
            try:
                self.assertEqual(self.w.run(True), 0)
                doc = json.loads(self.w.STATUS.read_text())
            finally:
                self.w.scan, self.w.plan, self.w.reap_orphans = old_scan, old_plan, old_reap
                self.w.enforce_task_caps, self.w.warn_near_cap, self.w.headroom = old_enforce, old_warn, old_headroom
                self.w.Bus, self.w.move, self.w.notify = old_bus, old_move, old_notify
                self.restore_status_state(self.w, old)
        failed = [event for event in doc["events"] if event["kind"] == "failed"]
        self.assertEqual(len(failed), 1)
        self.assertIsNone(failed[0]["processes"])

    def test_correct_move_status_rescans_labels(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            self.write_status_cgroup(self.w, scope="agent-warden-321-654.scope")
            before = self.P(321, 1, "claude", ["claude"], self.A, start=654)
            after = self.P(321, 1, "claude", ["claude"], self._cg("agent-warden-321-654.scope"), start=654)
            # Two scan() calls per correct tick with a move here: the
            # plan-time snapshot (before) and the fresh_labels rescan after
            # the move (after). reap_scratch_dirs scans only once a gone
            # folder is past its grace, and AGENT_TMPDIR_PARENT does not
            # exist under this sandboxed HOME.
            calls = iter([{before.pid: before}, {after.pid: after}])
            old_scan, old_plan, old_reap = self.w.scan, self.w.plan, self.w.reap_orphans
            old_enforce, old_warn, old_headroom = self.w.enforce_task_caps, self.w.warn_near_cap, self.w.headroom
            old_bus, old_move, old_worktree, old_notify = self.w.Bus, self.w.move, self.w._worktree_label, self.w.notify
            class FakeBus:
                def close(self):
                    pass
            self.w.scan = lambda: next(calls)
            self.w.plan = lambda procs, only=None: ([("escaped launch", [before])], [], [], [])
            self.w.reap_orphans = lambda procs, st, correct, only=None: ([], [])
            self.w.enforce_task_caps = lambda correct: []
            self.w.warn_near_cap = lambda: []
            self.w.headroom = lambda: (True, 1, 100)
            self.w.Bus = FakeBus
            self.w.move = lambda tree, reason, bus: (True, "agent-warden-321-654.scope", [after], [])
            self.w._worktree_label = lambda pid: "vsy-52"
            self.w.notify = lambda kind, summary, body: None
            try:
                self.assertEqual(self.w.run(True), 0)
                doc = json.loads(self.w.STATUS.read_text())
            finally:
                self.w.scan, self.w.plan, self.w.reap_orphans = old_scan, old_plan, old_reap
                self.w.enforce_task_caps, self.w.warn_near_cap, self.w.headroom = old_enforce, old_warn, old_headroom
                self.w.Bus, self.w.move, self.w._worktree_label, self.w.notify = old_bus, old_move, old_worktree, old_notify
                self.restore_status_state(self.w, old)
        lane = doc["lanes"][0]
        self.assertEqual(lane["scope"], "agent-warden-321-654.scope")
        self.assertEqual(lane["label"], {"tool": "claude", "worktree": "vsy-52"})

    def native_install_labels(self, module):
        # claude's and codex's native installs are described only through `paths`,
        # so D010 leaves is_agent false; the label still names the lane's agent
        rows = [
            ("claude", f"{module.HOME}/.local/share/claude/versions/2.1.0/claude"),
            ("codex", "/usr/lib/openai-codex/codex"),
        ]
        labels = {}
        old_worktree = module._worktree_label
        module._worktree_label = lambda pid: "vsy-122"
        try:
            for tool, exe in rows:
                scope = f"agent-warden-700-1-{tool}.scope"
                proc = module.Proc(700, ppid=1, comm=tool, argv=[tool], exe=exe, cgroup=self._cg(scope), start=1)
                self.assertFalse(proc.is_agent, tool)
                labels[tool] = module.lane_label(scope, {700: proc})
        finally:
            module._worktree_label = old_worktree
        return labels

    def test_lane_label_names_paths_only_native_install(self):
        self.assertEqual(self.native_install_labels(self.w), {
            "claude": {"tool": "claude", "worktree": "vsy-122"},
            "codex": {"tool": "codex", "worktree": "vsy-122"},
        })

    def test_lane_label_location_match_mutant_fails(self):
        text = WARDEN.read_text()
        old = "if _scope_of_proc(p) == scope and p.is_named_agent]"
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, "if _scope_of_proc(p) == scope and p.is_agent]"), "agent_warden_mutant_lane_label")
        self.assertEqual(self.native_install_labels(mutant), {
            "claude": {"tool": None, "worktree": None},
            "codex": {"tool": None, "worktree": None},
        })

    def test_status_event_ring_and_episode_dedupe(self):
        st = {}
        for i in range(60):
            self.w.emit_event(st, "moved", scope=f"s{i}.scope", now=i)
        self.assertEqual(len(st["events"]), 50)
        ids = [event["id"] for event in st["events"]]
        self.assertEqual(ids, sorted(ids))
        self.assertEqual(ids[0], 10000)
        self.assertEqual(ids[-1], 59000)
        st = {}
        self.w.record_near_events(st, [("lane.scope", "tasks", "6200 of 8192")], now=1)
        self.w.record_near_events(st, [("lane.scope", "tasks", "6201 of 8192")], now=2)
        self.assertEqual(len(st["events"]), 1)
        self.w.record_near_events(st, [], now=3)
        self.w.record_near_events(st, [("lane.scope", "tasks", "6202 of 8192")], now=4)
        self.assertEqual(len(st["events"]), 2)
        root = self.P(9000, 1, "claude", ["claude"], self.A, start=123)
        tree = [("escaped launch", [root])]
        self.w.record_waiting_events(st, tree, now=5)
        self.w.record_waiting_events(st, tree, now=6)
        waiting = [event for event in st["events"] if event["kind"] == "waiting"]
        self.assertEqual(len(waiting), 1)

    def test_status_validator_rejects_document_type_mismatches(self):
        base = self.w.status_fixture_docs()["holding-off"]
        rows = []
        for field in ("pid", "start", "processes"):
            doc = json.loads(json.dumps(base))
            doc["outside"][0][field] = None
            rows.append((f"outside {field} null", doc, f"outside[0].{field}"))
            doc = json.loads(json.dumps(base))
            doc["waiting"][0][field] = None
            rows.append((f"waiting {field} null", doc, f"waiting[0].{field}"))
        doc = json.loads(json.dumps(base))
        doc["orphans"] = [{"scope": "orphan.scope", "processes": None, "cores": None, "memory": None, "since": 1, "harmful": False, "reapFailed": False}]
        rows.append(("orphan processes null", doc, "orphans[0].processes"))
        doc = json.loads(json.dumps(base))
        doc["orphans"] = [{"scope": "orphan.scope", "processes": 1, "cores": True, "memory": None, "since": 1, "harmful": False, "reapFailed": False}]
        rows.append(("orphan cores bool", doc, "orphans[0].cores"))
        doc = json.loads(json.dumps(base))
        doc["orphans"] = [{"scope": "orphan.scope", "processes": 1, "cores": float("inf"), "memory": None, "since": 1, "harmful": False, "reapFailed": False}]
        rows.append(("orphan cores infinite", doc, "orphans[0].cores"))
        doc = json.loads(json.dumps(base))
        doc["orphans"] = [{"scope": "orphan.scope", "processes": 1, "cores": None, "memory": 1.5, "since": 1, "harmful": False, "reapFailed": False}]
        rows.append(("orphan memory fraction", doc, "orphans[0].memory"))
        doc = json.loads(json.dumps(base))
        doc["orphans"] = [{"scope": "orphan.scope", "processes": 1, "cores": None, "since": 1, "harmful": False, "reapFailed": False}]
        rows.append(("orphan memory missing", doc, "orphans[0]"))
        doc = json.loads(json.dumps(base))
        doc["orphans"] = [{"scope": "orphan.scope", "processes": 1, "cores": None, "memory": None, "since": True, "harmful": False, "reapFailed": False}]
        rows.append(("orphan since bool", doc, "orphans[0].since"))
        doc = json.loads(json.dumps(base))
        doc["orphans"] = [{"scope": "orphan.scope", "processes": 1, "cores": None, "memory": None, "since": 1, "harmful": True, "reapFailed": None}]
        rows.append(("orphan reapFailed null", doc, "orphans[0].reapFailed"))
        doc = json.loads(json.dumps(base))
        doc["contained"] = [{"unit": "orch.service", "processes": None}]
        rows.append(("contained processes null", doc, "contained[0].processes"))
        doc = json.loads(json.dumps(base))
        doc["events"][0]["time"] = float("nan")
        rows.append(("event time nan", doc, "events[0].time"))
        doc = json.loads(json.dumps(base))
        doc["time"] = float("inf")
        rows.append(("top time infinite", doc, "time"))
        doc = json.loads(json.dumps(base))
        doc["interval"] = 0
        rows.append(("interval zero", doc, "interval"))
        doc = json.loads(json.dumps(base))
        doc["lanes"] = [{"scope": [], "label": {"tool": None, "worktree": None}, "tasks": 1, "tasksMax": 2, "memory": 3, "memoryHigh": 4, "near": []}]
        rows.append(("lane scope list", doc, "lanes[0].scope"))
        doc = json.loads(json.dumps(base))
        doc["lanes"][0]["near"] = [[]]
        rows.append(("lane near list", doc, "lanes[0].near"))
        doc = json.loads(json.dumps(base))
        doc["outside"][0]["reason"] = []
        rows.append(("outside reason list", doc, "outside[0].reason"))
        doc = json.loads(json.dumps(base))
        doc["events"][0]["kind"] = []
        rows.append(("event kind list", doc, "events[0].kind"))
        doc = json.loads(json.dumps(base))
        doc["events"][0]["near"] = []
        rows.append(("event near list", doc, "events[0].near"))
        doc = json.loads(json.dumps(base))
        doc["mode"] = []
        rows.append(("mode list", doc, "mode"))
        doc = json.loads(json.dumps(base))
        doc["error"] = "other"
        rows.append(("unknown error id", doc, "error"))
        for key in ("outside", "waiting", "contained"):
            doc = json.loads(json.dumps(base))
            doc[key] = None
            rows.append((f"{key} null without error", doc, key))
        doc = json.loads(json.dumps(base))
        doc["orphans"] = None
        rows.append(("orphans null without error allowed", doc, None))
        leftovers = self.w.status_fixture_docs()["leftovers"]
        for name, change, field in (
            ("leftovers missing", lambda d: d.pop("leftovers"), "status"),
            ("leftovers null allowed", lambda d: d.update(leftovers=None), None),
            ("leftovers a list", lambda d: d.update(leftovers=[]), "leftovers"),
            ("leftovers key missing", lambda d: d["leftovers"].pop("failedUnits"), "leftovers"),
            ("every leftover null allowed", lambda d: d.update(leftovers=dict.fromkeys(d["leftovers"])), None),
            ("test worlds a boolean", lambda d: d["leftovers"].update(testWorlds=True), "leftovers.testWorlds"),
            ("failed units negative", lambda d: d["leftovers"].update(failedUnits=-1), "leftovers.failedUnits"),
            ("test processes a fraction", lambda d: d["leftovers"].update(testProcesses=1.5), "leftovers.testProcesses"),
            ("repo rows null beside a count", lambda d: d["leftovers"].update(testProcessRepos=None),
             "leftovers.testProcessRepos"),
            ("repo rows beside a null count", lambda d: d["leftovers"].update(testProcesses=None),
             "leftovers.testProcessRepos"),
            ("repo rows an object", lambda d: d["leftovers"].update(testProcessRepos={}), "leftovers.testProcessRepos"),
            ("repo row processes null", lambda d: d["leftovers"]["testProcessRepos"][0].update(processes=None),
             "leftovers.testProcessRepos[0].processes"),
            ("repo row repo a number", lambda d: d["leftovers"]["testProcessRepos"][0].update(repo=1),
             "leftovers.testProcessRepos[0].repo"),
            ("repo row missing processes", lambda d: d["leftovers"]["testProcessRepos"][0].pop("processes"),
             "leftovers.testProcessRepos[0]"),
            ("repo rows with the unknown first", lambda d: d["leftovers"]["testProcessRepos"].reverse(),
             "leftovers.testProcessRepos"),
            ("leftovers beside a scan error", lambda d: d.update(error="scan", outside=None, waiting=None,
                                                                 orphans=None, contained=None), "leftovers"),
        ):
            doc = json.loads(json.dumps(leftovers))
            change(doc)
            rows.append((name, doc, field))
        # Each error opens with the path of the field it rejects, so a row
        # passes only on its own field's error, not on any error at all.
        for name, doc, field in rows:
            with self.subTest(name=name):
                fields = [error.split(" ", 1)[0] for error in self.w.status_errors(doc)]
                if field is None:
                    self.assertEqual(fields, [])
                else:
                    self.assertIn(field, fields)

    def test_status_items_rows(self):
        w, gib, now = self.w, self.w._gib, self.w.FIXTURE_NOW
        fixtures = w.status_fixture_docs()
        lane = "agent-warden-100-200.scope"
        show, show_lane, stop_lane = [], ["--lane", lane], ["--lane", lane, "--stop"]

        def doc(mode="correct", *, events=(), **kw):
            st = w._fixture_state()
            for kind, at, fields in events:
                w.emit_event(st, kind, now=now + at, **fields)
            kw.setdefault("moves", [])
            for key in ("waiting", "orphans_status", "contained"):
                kw.setdefault(key, [])
            return w._fixture_doc(mode, st, now=now, reap=mode == "correct", **kw)

        def orphans(*rows):
            return {"orphans_status": list(rows), "lanes": w._fixture_orphan_lanes(rows)}

        def from_tick(mode, reap_setting, **kw):
            # The real tick's route: the reap answer comes from reaps(), here with AGENT_WARDEN_REAP=REAP_SETTING.
            tick = {"moves": [], "waiting": [], "contained": [], "error": None, "procs": {},
                    "orphans": kw["orphans_status"], "leftovers": w._fixture_leftovers()}
            with patch.object(w, "REAP", reap_setting):
                return w.status_from_tick(mode, w._fixture_state(), tick, slice_reading=w._fixture_slice(),
                                          lanes=kw["lanes"])

        harmful = w._fixture_orphan("agent-confine-leak.scope", processes=42, cores=1.5, memory=gib(2), harmful=True)
        idle = w._fixture_orphan("agent-confine-idle.scope", processes=3)
        idle_one = w._fixture_orphan("agent-confine-idle.scope")
        stuck = w._fixture_orphan("agent-confine-leak.scope", cores=1.5, memory=gib(2), harmful=True, reap_failed=True)
        tree = w._fixture_tree()
        codex = [w._fixture_proc(900, 1, "codex", ["codex"], w.FIXTURE_OUTSIDE_CG, start=700)]
        full = w._fixture_slice(memory=gib(73), headroom=False)
        with patch.object(w, "STATUS_INTERVAL", 1):
            scan_full = w._fixture_doc("report", w._fixture_state(), now=now, reap=False, error="scan",
                                       slice_reading=full)
        unread = dict.fromkeys(("memory", "high", "max", "tasks", "tasksMax", "headroomOk"))
        long_name = "w" * 50
        rows = [
            ("calm", fixtures["calm"], []),
            ("readings that make no item",
             doc(lanes=[{**w._fixture_lanes(near=["memory"])[0], "label": {"tool": None, "worktree": None}}],
                 moves=[("escaped launch", tree)], contained=[tree[0]], leftovers=dict.fromkeys(w.LEFTOVER_KEYS),
                 events=[("near-cap", 0, {"scope": lane, "near": "memory"}), ("waiting", 0, {"pid": 321})]), []),
            ("memory full, agents held back", fixtures["holding-off"],
             [("memory-full", "memory-full", "danger", "Agents are close to their memory limit.",
               "73 of 80 GB in use. The warden holds back 1 agent until memory frees.", [show])]),
            ("memory full beside a failed check", scan_full,
             [("memory-full", "memory-full", "danger", "Agents are close to their memory limit.",
               "73 of 80 GB in use.", [show]),
              ("scan-failed", "scan-failed", "warn", "The warden's last check failed.",
               "Agents are not checked or moved until a check succeeds. It tries again in 1 second.", [])]),
            ("memory unread beside a failed check", doc(slice_reading=unread, error="scan",
                                                           **dict.fromkeys(("moves", "waiting", "orphans_status", "contained"))),
             [("memory-unread", "memory-unread", "warn", "The warden cannot read how much memory agents use.",
               "It moves no agent into its limits until it can.", [show]),
              ("scan-failed", "scan-failed", "warn", "The warden's last check failed.",
               "Agents are not checked or moved until a check succeeds. It tries again in 30 seconds.", [])]),
            ("past the slowdown point", doc(slice_reading=w._fixture_slice(memory=gib(70))),
             [("slowdown", "slowdown", "warn", "Agents use more memory than the slowdown point.",
               "70 of 64 GB. The system slows every agent until use falls.", [show])]),
            ("failed move with the bus unreachable, agents unknown",
             doc(moves=[("escaped launch", tree)], events=[("failed", 0, {})]),
             [("move-failed", "move-failed", "warn", "The warden could not move agents into their limits.",
               "It tries again on its next check.", [show])]),
            ("each agent's events on every tick count once, memory full",
             doc(slice_reading=full, moves=[("escaped launch", tree), ("escaped launch", codex)],
                 waiting=[("escaped launch", tree), ("escaped launch", codex)],
                 events=[*[("failed", at, {"pid": pid}) for pid in (321, 900) for at in (-60, -30, 0)],
                         *[(kind, at, {"pid": pid}) for kind, pids in (("partial", (777, 779)), ("moved", (781, 783)))
                           for pid in pids for at in (-30, 0)]]),
             [("memory-full", "memory-full", "danger", "Agents are close to their memory limit.",
               "73 of 80 GB in use. The warden holds back 2 agents until memory frees.", [show]),
              ("move-failed", "move-failed", "warn", "The warden could not move 2 agents into their limits.",
               "claude, codex still run outside them. It tries again on its next check.", [show]),
              ("move-partial", "move-partial", "warn", "The warden moved only part of 2 agents into their limits.",
               "The rest still runs outside them. It tries again on its next check.", [show]),
              ("moved", "moved", "info", "The warden moved 2 agents into their limits.", None, [])]),
            ("failed and partial moves retried with success",
             doc(events=[("failed", -90, {}), ("failed", -60, {"pid": 321}), ("partial", -60, {"pid": 777}),
                         ("moved", -30, {"pid": 321}), ("moved", 0, {"pid": 777})]),
             [("moved", "moved", "info", "The warden moved 2 agents into their limits.", None, [])]),
            ("partial move", fixtures["partial"],
             [("move-partial", "move-partial", "warn", "The warden moved only part of 1 agent into its limits.",
               "The rest still runs outside them. It tries again on its next check.", [show])]),
            ("near both limits", fixtures["near-limit"],
             [("near-limit", f"near-limit:{lane}", "warn", "claude in vsy-52 is near its memory and task limits.",
               "Memory: 50 of 64 GB; past it the system slows this agent. "
               "Tasks: 6200 of 8192 tasks; past it the agent cannot start processes.", [show_lane, stop_lane])]),
            ("near the memory limit, names cleaned and capped",
             doc(lanes=[{**w._fixture_lanes(memory=gib(50), near=["memory"])[0],
                         "label": {"tool": "cla\x1bude\x9b", "worktree": long_name}}]),
             [("near-limit", f"near-limit:{lane}", "warn", f"claude in {'w' * 39}… is near its memory limit.",
               "Memory: 50 of 64 GB; past it the system slows this agent.", [show_lane, stop_lane])]),
            ("near the task limit", doc(lanes=w._fixture_lanes(tasks=6200, near=["tasks"])),
             [("near-limit", f"near-limit:{lane}", "warn", "claude in vsy-52 is near its task limit.",
               "Tasks: 6200 of 8192 tasks; past it the agent cannot start processes.", [show_lane, stop_lane])]),
            ("busy leftover work in report mode", from_tick("report", True, **orphans(harmful)),
             [("leftover-busy", "leftover-busy:agent-confine-leak.scope", "warn",
               "Leftover work from a finished agent is busy.",
               "42 processes, 1.5 cores, 2 GB. The warden is set not to stop it.",
               [["--lane", "agent-confine-leak.scope", "--stop"], ["--lane", "agent-confine-leak.scope"]])]),
            ("busy leftover work with reaping off, cores unread",
             from_tick("correct", False, **orphans({**harmful, "cores": None}, idle_one)),
             [("leftover-busy", "leftover-busy:agent-confine-leak.scope", "warn",
               "Leftover work from a finished agent is busy.", "42 processes, 2 GB. The warden is set not to stop it.",
               [["--lane", "agent-confine-leak.scope", "--stop"], ["--lane", "agent-confine-leak.scope"]]),
              ("leftover", "leftover", "info", "Leftover work from 1 finished agent is still running.",
               "1 process. The warden is set not to stop it.", [show])]),
            ("busy leftover work whose stop failed", from_tick("correct", True, **orphans(stuck, idle)),
             [("leftover-busy", "leftover-busy:agent-confine-leak.scope", "warn",
               "Leftover work from a finished agent is busy.",
               "1 process, 1.5 cores, 2 GB. The warden could not stop it. It tries again on its next check.",
               [["--lane", "agent-confine-leak.scope", "--stop"], ["--lane", "agent-confine-leak.scope"]]),
              ("leftover", "leftover", "info", "Leftover work from 1 finished agent is still running.",
               "3 processes. The warden stops it if it gets busy.", [show])]),
            ("idle leftover work in correct mode with reaping on", fixtures["leftover-idle"],
             [("leftover", "leftover", "info", "Leftover work from 5 finished agents is still running.",
               "5 processes. The warden stops it if it gets busy.", [show])]),
            ("busy leftover work the warden stops", doc(**orphans(harmful, idle)),
             [("leftover", "leftover", "info", "Leftover work from 2 finished agents is still running.",
               "45 processes. The warden stops the busy work on its next check.", [show])]),
            ("recent reap", fixtures["reaped"],
             [("reaped", "reaped", "info", "The warden stopped leftover work from 1 finished agent.",
               "42 processes had become busy.", [])]),
            ("reaps at and past the recent window",
             doc(events=[("reaped", -301, {"processes": 7}), ("reaped", -300, {"processes": 1}),
                         ("reaped", 0, {"processes": 1})]),
             [("reaped", "reaped", "info", "The warden stopped leftover work from 2 finished agents.",
               "2 processes had become busy.", [])]),
            ("recent move beside a failed one",
             doc(moves=[("escaped launch", codex)],
                 events=[("moved", 0, {"pid": 321, "processes": 3}), ("failed", 0, {"pid": 900})]),
             [("move-failed", "move-failed", "warn", "The warden could not move 1 agent into its limits.",
               "codex still runs outside them. It tries again on its next check.", [show]),
              ("moved", "moved", "info", "The warden moved 1 agent into its limits.", None, [])]),
            ("outside in report mode", doc("report", moves=[("escaped launch", tree), ("escaped launch", codex)]),
             [("outside-report", "outside-report", "info", "2 agents run outside their limits.",
               "The warden is set to report only, so it moves nothing.", [show])]),
            ("test leftovers in correct mode", fixtures["leftovers"],
             [("test-processes", "test-processes", "info", "3 old test processes are still running.",
               "From vgshell. The warden reports them and never stops them.", []),
              ("test-worlds", "test-worlds", "info", "3 old test folders are waiting to be removed.",
               "The warden removes each one when nothing uses it.", []),
              ("failed-units", "failed-units", "info", "1 failed test unit is waiting to be cleared.",
               "The warden clears it when it is old enough.", [])]),
            ("test leftovers in correct mode, one folder and two units", doc(leftovers=w._fixture_leftovers(1, 2)),
             [("test-worlds", "test-worlds", "info", "1 old test folder is waiting to be removed.",
               "The warden removes it when nothing uses it.", []),
              ("failed-units", "failed-units", "info", "2 failed test units are waiting to be cleared.",
               "The warden clears each one when it is old enough.", [])]),
            ("report mode: one agent outside, test leftovers with repositories unknown",
             doc("report", moves=[("escaped launch", tree)], leftovers=w._fixture_leftovers(1, 4, [(None, 1)])),
             [("outside-report", "outside-report", "info", "1 agent runs outside its limits.",
               "The warden is set to report only, so it moves nothing.", [show]),
              ("test-processes", "test-processes", "info", "1 old test process is still running.",
               "The warden reports it and never stops it.", []),
              ("test-worlds", "test-worlds", "info", "1 old test folder is waiting to be removed.",
               "The warden is set to report only.", []),
              ("failed-units", "failed-units", "info", "4 failed test units are waiting to be cleared.",
               "The warden is set to report only.", [])]),
        ]
        for name, built, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(w.status_errors(built), [])
                self.assertEqual([(item["kind"], item["key"], item["level"], item["title"], item["detail"],
                                   [action["args"] for action in item["actions"]]) for item in built["items"]],
                                 expected)

    def test_status_validator_rejects_bad_items(self):
        base = self.w.status_fixture_docs()["leftover-busy"]
        scope = "agent-confine-leak.scope"
        info = {"kind": "moved", "key": "moved", "level": "info", "title": "Moved.", "detail": None, "actions": []}

        def action(index, **fields):
            return lambda d: d["items"][0]["actions"][index].update(fields)

        rows = [
            ("items missing", lambda d: d.pop("items"), "status"),
            ("items an object", lambda d: d.update(items={}), "items"),
            ("unknown kind", lambda d: d["items"][0].update(kind="other"), "items[0].kind"),
            ("unknown level", lambda d: d["items"][0].update(level="look"), "items[0].level"),
            ("duplicate key", lambda d: d["items"].append(json.loads(json.dumps(d["items"][0]))), "items[1].key"),
            ("aggregate key with a scope", lambda d: d["items"].append({**info, "key": f"moved:{scope}"}),
             "items[1].key"),
            ("per-scope key without its scope", lambda d: d["items"][0].update(key="leftover-busy"), "items[0].key"),
            ("empty title", lambda d: d["items"][0].update(title=""), "items[0].title"),
            ("control character in the title", lambda d: d["items"][0].update(title="Busy\x1b[2J."), "items[0].title"),
            ("control character in the detail", lambda d: d["items"][0].update(detail="a\x85b"), "items[0].detail"),
            ("control character in a label", action(0, label="Stop\n"), "items[0].actions[0].label"),
            ("unknown action id", action(0, id="kill"), "items[0].actions[0].id"),
            ("lane flag without a scope", action(0, args=["--lane"]), "items[0].actions[0].args"),
            ("stop without the lane flag", action(0, args=["--stop"]), "items[0].actions[0].args"),
            ("an argument vsys does not take", action(0, args=["--lane", scope, "--once"]), "items[0].actions[0].args"),
            ("an extra argument", action(0, args=["--lane", scope, "--stop", "--stop"]), "items[0].actions[0].args"),
            ("a scope neither lanes nor orphans lists", action(1, args=["--lane", "gone.scope"]),
             "items[0].actions[1].args"),
            ("a scope only orphans lists",
             lambda d: d.update(lanes=[lane for lane in d["lanes"] if lane["scope"] != scope]), None),
            ("out of level order", lambda d: d["items"].insert(0, info), "items[1].level"),
        ]
        # Each error opens with the path of the field it rejects, so a row
        # passes only on its own field's error.
        for name, change, field in rows:
            with self.subTest(name=name):
                doc = json.loads(json.dumps(base))
                change(doc)
                fields = [error.split(" ", 1)[0] for error in self.w.status_errors(doc)]
                if field is None:
                    self.assertEqual(fields, [])
                else:
                    self.assertIn(field, fields)

    def test_near_cap_status_episode_lifetime_rows(self):
        st = {"_state_readable": True, "event_seq": 0, "events": [], "near_open": []}
        self.w.record_near_events(st, [("lane.scope", "tasks", "6200 of 8192")], now=1)
        self.assertEqual(len([event for event in st["events"] if event["kind"] == "near-cap"]), 1)
        self.w.record_near_events(st, [], {("lane.scope", "tasks")}, True, now=2)
        self.assertEqual(st["near_open"], ["lane.scope:tasks"])
        self.w.record_near_events(st, [("lane.scope", "tasks", "6201 of 8192")], now=3)
        self.assertEqual(len([event for event in st["events"] if event["kind"] == "near-cap"]), 1)
        self.w.record_near_events(st, [], set(), False, now=4)
        self.assertEqual(st["near_open"], ["lane.scope:tasks"])
        self.w.record_near_events(st, [("lane.scope", "tasks", "6202 of 8192")], now=5)
        self.assertEqual(len([event for event in st["events"] if event["kind"] == "near-cap"]), 1)
        self.w.record_near_events(st, [], set(), True, now=6)
        self.assertEqual(st["near_open"], [])
        self.w.record_near_events(st, [("lane.scope", "tasks", "6203 of 8192")], now=7)
        self.assertEqual(len([event for event in st["events"] if event["kind"] == "near-cap"]), 2)

    def test_status_fixtures_validate_and_match_builders(self):
        expected = self.w.status_fixture_docs()
        actual_names = {path.name.removeprefix("status-").removesuffix(".json") for path in (ROOT / "warden" / "fixtures").glob("status-*.json")}
        self.assertEqual(actual_names, set(expected))
        for name, doc in expected.items():
            with self.subTest(name=name):
                fixture = json.loads((ROOT / "warden" / "fixtures" / f"status-{name}.json").read_text())
                self.assertEqual(fixture, doc)
                self.assertFalse(self.w.status_errors(fixture))
        self.assertEqual(expected["calm"]["events"], [])
        self.assertEqual(expected["near-limit"]["lanes"][0]["near"], ["tasks", "memory"])
        self.assertGreaterEqual(expected["holding-off"]["counters"]["skips"], 1)
        self.assertTrue(expected["holding-off"]["waiting"])
        self.assertEqual(expected["partial"]["events"][0]["kind"], "partial")
        self.assertGreaterEqual(expected["partial"]["counters"]["partial"], 1)
        self.assertEqual(expected["reaped"]["events"][0]["kind"], "reaped")
        self.assertGreaterEqual(expected["reaped"]["counters"]["reaped"], 1)
        self.assertEqual(expected["leftovers"]["leftovers"]["testProcessRepos"][-1]["repo"], None)



if __name__ == "__main__":
    unittest.main()
