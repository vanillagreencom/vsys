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
                "memory.high": "64",
                "memory.max": "80",
                "pids.current": "300",
                "pids.max": "16384",
            },
            lane: {
                "memory.current": lane_memory,
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
                for raw, expected in ((str(128 * 1024**3), "128"), ("max", "unlimited"),
                                      ("invalid", "unknown"), (None, "unknown")):
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
                        cap = re.search(r"soft cap ([^)]+)", notice)
                        self.assertIsNotNone(cap)
                        self.assertEqual(cap.group(1), expected)
            finally:
                self.restore_status_state(self.w, old)

    def test_text_status_preserves_counter_knowledge(self):
        with scratch() as tmp:
            old = self.point_status_state(self.w, Path(tmp))
            try:
                self.w.STATE_DIR.mkdir()
                for recovered, count in ((False, 0), (False, 7), (True, 0)):
                    with self.subTest(recovered=recovered, count=count):
                        st = self.w.default_state()
                        for _, internal in self.w.STATUS_COUNTER_KEYS_PUBLIC:
                            st[internal] = count
                        self.w.STATE.write_text("invalid JSON" if recovered else json.dumps(st))
                        if recovered:
                            with self.w.State():
                                pass
                            self.assertTrue(self.w.read_state_unlocked()["counters_unknown"])
                        counters = self.w.status_counters(self.w.read_state_unlocked())
                        self.assertEqual(set(counters.values()), {None if recovered else count})
                        output = io.StringIO()
                        with patch.object(self.w, "scan", return_value={}), \
                                patch.object(self.w, "notifier_fresh", return_value=False), \
                                contextlib.redirect_stdout(output):
                            self.assertEqual(self.w.status(), 0)
                        values = re.findall(r"(?:moves|partial|reaped|move failures|scan failures|consecutive skips) (\w+)",
                                            output.getvalue().splitlines()[0])
                        self.assertEqual(values, ["unknown" if recovered else str(count)] * len(counters))
            finally:
                self.restore_status_state(self.w, old)

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
                                             moves=[], waiting=[], orphans_status=[], contained=[], now=1)
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
                                             moves=[], waiting=[], orphans_status=[], contained=[], now=1)
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
                                             moves=[], waiting=[], orphans_status=[], contained=[], now=1)
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
                old_bus, old_notify = self.w.Bus, self.w.notify
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
                    self.w.Bus, self.w.notify = old_bus, old_notify
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
            # Three scan() calls per correct tick with a move: the plan-time
            # snapshot (before), the fresh snapshot reap_scratch_dirs takes
            # for its own liveness check (irrelevant here -- AGENT_TMPDIR_PARENT
            # does not exist under this sandboxed HOME, so reap_scratch_dirs
            # returns before ever reading its procs argument), and the
            # fresh_labels rescan after the move (after).
            calls = iter([{before.pid: before}, {}, {after.pid: after}])
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
        doc["orphans"] = [{"scope": "orphan.scope", "processes": None, "cores": None, "memory": None, "since": 1, "harmful": False}]
        rows.append(("orphan processes null", doc, "orphans[0].processes"))
        doc = json.loads(json.dumps(base))
        doc["orphans"] = [{"scope": "orphan.scope", "processes": 1, "cores": True, "memory": None, "since": 1, "harmful": False}]
        rows.append(("orphan cores bool", doc, "orphans[0].cores"))
        doc = json.loads(json.dumps(base))
        doc["orphans"] = [{"scope": "orphan.scope", "processes": 1, "cores": float("inf"), "memory": None, "since": 1, "harmful": False}]
        rows.append(("orphan cores infinite", doc, "orphans[0].cores"))
        doc = json.loads(json.dumps(base))
        doc["orphans"] = [{"scope": "orphan.scope", "processes": 1, "cores": None, "memory": 1.5, "since": 1, "harmful": False}]
        rows.append(("orphan memory fraction", doc, "orphans[0].memory"))
        doc = json.loads(json.dumps(base))
        doc["orphans"] = [{"scope": "orphan.scope", "processes": 1, "cores": None, "since": 1, "harmful": False}]
        rows.append(("orphan memory missing", doc, "orphans[0]"))
        doc = json.loads(json.dumps(base))
        doc["orphans"] = [{"scope": "orphan.scope", "processes": 1, "cores": None, "memory": None, "since": True, "harmful": False}]
        rows.append(("orphan since bool", doc, "orphans[0].since"))
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
        # Each error opens with the path of the field it rejects, so a row
        # passes only on its own field's error, not on any error at all.
        for name, doc, field in rows:
            with self.subTest(name=name):
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



if __name__ == "__main__":
    unittest.main()
