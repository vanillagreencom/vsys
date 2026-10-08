from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from agent_warden_testlib import WARDEN, WardenRulesCase, clean_env, load_warden, scratch, started_scope

sys.dont_write_bytecode = True


class AgentWardenLimitRules(WardenRulesCase):
    def write_lineage_files(self, module, base):
        agent_slice = base / module.SLICE
        plain = agent_slice / "plain.scope"
        tight = agent_slice / "tight.scope"
        for directory in (agent_slice, plain, tight):
            directory.mkdir(parents=True, exist_ok=True)
        values = {
            agent_slice: ("1000", "1000", str(80 * 1024**3)),
            plain: (str(module.SCOPE_TASKS_MAX), "1000", str(module.SCOPE_MEM_HIGH)),
            tight: (str(module.SCOPE_TASKS_MAX), "1000", str(8 * 1024**3)),
        }
        for directory, (pids, mem_max, mem_high) in values.items():
            (directory / "pids.max").write_text(pids)
            (directory / "memory.max").write_text(mem_max)
            (directory / "memory.high").write_text(mem_high)
            (directory / "memory.swap.max").write_text("max")
            (directory / "cpu.max").write_text("max 100000")
            (directory / "io.max").write_text("")
            (directory / "cpuset.cpus").write_text("")
            (directory / "cpuset.mems").write_text("")
        return agent_slice

    def test_lineage_and_task_cap_rows(self):
        with scratch() as tmp:
            base = Path(tmp) / "cg"
            old_root = self.w.CG_ROOT
            self.w.CG_ROOT = base
            try:
                agent_slice = self.write_lineage_files(self.w, base)
                rows = [
                    ("default scope memory high is plain", self.w.lineage_is_capped(self._cg("plain.scope")), False),
                    ("tighter memory high is capped", self.w.lineage_is_capped(self._cg("tight.scope")), True),
                    ("outside agents slice", self.w.lineage_is_capped("/user.slice/user-1000.slice/user@1000.service/app.slice/x.scope"), True),
                ]
                for name, actual, expected in rows:
                    with self.subTest(name=name):
                        self.assertEqual(actual, expected)
                recs = {
                    10: self.P(10, 1, "codex", ["codex"], self._cg("plain.scope"), start=1),
                    11: self.P(11, 10, "claude", ["claude", "-p", "x"], self._cg("plain.scope"), start=2),
                }
                moves, _, held, _ = self.w.plan(recs, capped=self.w.lineage_is_capped, split=True, contained=lambda cg: False)
                self.assertIn([11], [[p.pid for p in tree] for reason, tree in moves if reason == "nested session"])
                self.assertEqual(held, [])
                (agent_slice / "pids.max").write_text("1000")
                unbounded = agent_slice / "unbounded.scope"
                bounded = agent_slice / "bounded.scope"
                unbounded.mkdir()
                bounded.mkdir()
                (unbounded / "pids.max").write_text("max")
                (bounded / "pids.max").write_text("10")
                calls = []
                logs = []
                old = self.w.log, self.w.subprocess
                self.w.log = logs.append
                self.w.subprocess = SimpleNamespace(run=lambda argv, **_: calls.append(argv) or SimpleNamespace(returncode=0, stderr=""))
                try:
                    self.assertEqual(self.w.enforce_task_caps(False), ["unbounded.scope"])
                finally:
                    self.w.log, self.w.subprocess = old
                # Report mode names the unit in one journal line, its only
                # output, and never sets a property.
                self.assertEqual(len(logs), 1)
                self.assertIn("unbounded.scope", logs[0])
                self.assertFalse(any("set-property" in argv for argv in calls))
            finally:
                self.w.CG_ROOT = old_root

    # (name, slice pids.max or None when absent, scope pids.max, ticks, TasksMax values set)
    TASK_CAP_TICK_ROWS = [
        ("unlimited slice keeps a deliberate cap", "max", "20000", 1, []),
        ("unreadable slice keeps a deliberate cap", None, "20000", 1, []),
        ("unlimited slice still caps an unbounded scope", "max", "max", 3, [8192]),
        ("cap at the slice ceiling is capped", "16384", "16384", 3, [8192]),
        ("cap equal to the scope cap makes no call", "8192", "8192", 3, []),
        ("cap below the scope cap is never raised", "4096", "4096", 1, []),
    ]

    def task_cap_ticks(self, module, slice_pids, scope_pids, ticks):
        """The TasksMax values enforce_task_caps sets over `ticks` corrective
        ticks on one scope; the systemctl stub writes each value back to the
        scope's pids.max, as systemd does."""
        sets = []
        with scratch() as tmp:
            agent_slice = Path(tmp) / "cg" / module.SLICE
            scope = agent_slice / "lane.scope"
            scope.mkdir(parents=True)
            if slice_pids is not None:
                (agent_slice / "pids.max").write_text(slice_pids)
            (scope / "pids.max").write_text(scope_pids)

            def run(argv, **_):
                value = argv[-1].removeprefix("TasksMax=")
                sets.append(int(value))
                (scope / "pids.max").write_text(value)
                return SimpleNamespace(returncode=0, stderr="")

            old = module.CG_ROOT, module.subprocess, module.log
            module.CG_ROOT, module.subprocess, module.log = Path(tmp) / "cg", SimpleNamespace(run=run), lambda msg: None
            try:
                for _ in range(ticks):
                    module.enforce_task_caps(True)
            finally:
                module.CG_ROOT, module.subprocess, module.log = old
        return sets

    def test_task_cap_tick_rows(self):
        self.assertEqual(self.w.SCOPE_TASKS_MAX, 8192)
        for name, slice_pids, scope_pids, ticks, expected in self.TASK_CAP_TICK_ROWS:
            with self.subTest(name=name):
                self.assertEqual(self.task_cap_ticks(self.w, slice_pids, scope_pids, ticks), expected)

    def test_task_cap_tick_mutants_fail(self):
        text = WARDEN.read_text()
        mutants = [
            ("unlimited slice read as a number", "        return math.inf\n\n\ndef enforce_task_caps",
             "        return 16384\n\n\ndef enforce_task_caps", "unlimited slice keeps a deliberate cap"),
            ("cap at or below the scope cap re-set", " and int(cur) > SCOPE_TASKS_MAX)", ")",
             "cap equal to the scope cap makes no call"),
        ]
        rows = {row[0]: row[1:] for row in self.TASK_CAP_TICK_ROWS}
        for name, old, new, row in mutants:
            with self.subTest(mutant=name):
                self.assertEqual(text.count(old), 1)
                mutant = self.load_mutant(text.replace(old, new), "agent_warden_mutant_task_cap_ticks")
                slice_pids, scope_pids, ticks, expected = rows[row]
                self.assertNotEqual(self.task_cap_ticks(mutant, slice_pids, scope_pids, ticks), expected)

    def test_lineage_memory_high_mutant_fails(self):
        text = WARDEN.read_text()
        old = '    baseline["memory.high"] = min(baseline["memory.high"], SCOPE_MEM_HIGH)\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, ""), "agent_warden_mutant_lineage_memory_high")
        with scratch() as tmp:
            old_root = mutant.CG_ROOT
            mutant.CG_ROOT = Path(tmp) / "cg"
            try:
                self.write_lineage_files(mutant, mutant.CG_ROOT)
                self.assertTrue(mutant.lineage_is_capped(f"/user.slice/user-{mutant.UID}.slice/user@{mutant.UID}.service/{mutant.SLICE}/plain.scope"))
            finally:
                mutant.CG_ROOT = old_root

    def test_headroom_rows(self):
        with scratch() as tmp:
            old_root = self.w.CG_ROOT
            self.w.CG_ROOT = Path(tmp) / "cg"
            try:
                rows = [("absent slice", self.w.headroom(), (True, 0, 0))]
                slice_dir = self.w.CG_ROOT / self.w.SLICE
                slice_dir.mkdir(parents=True)
                (slice_dir / "memory.max").write_text("100")
                rows.append(("missing current", self.w.headroom(), (False, -1, -1)))
                (slice_dir / "memory.current").write_text("89")
                rows.append(("below headroom", self.w.headroom(), (True, 89, 100)))
                (slice_dir / "memory.current").write_text("90")
                rows.append(("at headroom", self.w.headroom(), (False, 90, 100)))
                (slice_dir / "memory.max").write_text("max")
                rows.append(("unlimited max", self.w.headroom(), (True, 90, 0)))
                (slice_dir / "memory.current").write_text("not-a-number")
                rows.append(("unparsable current", self.w.headroom(), (False, -1, -1)))
                for name, actual, expected in rows:
                    with self.subTest(name=name):
                        self.assertEqual(actual, expected)
            finally:
                self.w.CG_ROOT = old_root

    def test_headroom_slice_stat_errors(self):
        rows = [
            (FileNotFoundError(), (True, 0, 0)),
            (PermissionError(), (False, -1, -1)),
            (OSError(), (False, -1, -1)),
        ]
        for error, expected in rows:
            with self.subTest(error=type(error).__name__), \
                    patch.object(Path, "stat", side_effect=error), \
                    patch.object(Path, "is_dir", return_value=False):
                self.assertEqual(self.w.headroom(), expected)

    def test_cpu_weight_rows(self):
        # A non-default weight enables the CPU controller inside agents.slice.
        self.assertEqual(started_scope(self.w).values(b"CPUWeight"), [99])

    def test_memory_warn_default_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            default_env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"})
            low_env = clean_env({"HOME": base / "home-low", "XDG_RUNTIME_DIR": base / "run-low", "MISE_DATA_DIR": base / "mise-low", "AGENT_SCOPE_MEM_HIGH_BYTES": str(8 * 1024**3)})
            explicit_env = clean_env({"HOME": base / "home-explicit", "XDG_RUNTIME_DIR": base / "run-explicit", "MISE_DATA_DIR": base / "mise-explicit", "AGENT_SCOPE_MEM_HIGH_BYTES": str(8 * 1024**3), "AGENT_SCOPE_MEM_WARN_BYTES": str(7 * 1024**3)})
            for env in (default_env, low_env, explicit_env):
                for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                    Path(env[key]).mkdir(parents=True, exist_ok=True)
            default_w = load_warden(default_env, "agent_warden_default_mem_warn")
            low_w = load_warden(low_env, "agent_warden_low_mem_warn")
            explicit_w = load_warden(explicit_env, "agent_warden_explicit_mem_warn")
        rows = [
            ("default warning stays 48 GiB", default_w.SCOPE_MEM_WARN, 48 * 1024**3),
            ("lowered high derives warning", low_w.SCOPE_MEM_WARN, 6 * 1024**3),
            ("explicit warning wins", explicit_w.SCOPE_MEM_WARN, 7 * 1024**3),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
