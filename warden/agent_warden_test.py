import os
from pathlib import Path
import subprocess
import sys
import unittest

from agent_warden_testlib import BASE_PATH, ROOT, WARDEN, WardenRulesCase, clean_env, default_tool_exe, load_warden, scratch, tracked_offenders

sys.dont_write_bytecode = True


class AgentWardenRules(WardenRulesCase):
    def test_plan_rows(self):
        T = "/user.slice/user-1000.slice/user@1000.service/agents.slice/tight.scope"
        recs = {
            1: self.P(1, 0, "tmux: server", ["tmux"]),
            10: self.P(10, 1, "zsh", ["zsh"], marked=True),
            11: self.P(11, 10, "cargo", ["cargo", "build"], marked=True),
            20: self.P(20, 1, "claude", ["claude"]),
            21: self.P(21, 20, "bash", ["bash"]),
            30: self.P(30, 1, "cargo", ["cargo", "test"]),
            40: self.P(40, 1, "codex", ["codex"], self.S, start=1),
            41: self.P(41, 40, "claude", ["claude", "-p", "x"], self.S, start=2),
            50: self.P(50, 1, "codex", ["codex"], T, start=1),
            51: self.P(51, 50, "claude", ["claude", "-p", "x"], T, start=2),
        }
        moves, unmatched, held, units = self.w.plan(recs, capped=lambda cg: cg == T, contained=lambda cg: False)
        by = {reason: [sorted(p.pid for p in tree) for tree in trees] for reason, trees in self._group(moves).items()}
        rows = [
            ("escaped launch", [10, 11] in by.get("escaped launch", []), True),
            ("unconfined agent", [20, 21] in by.get("unconfined agent", []), True),
            ("unconfined build", [30] in by.get("unconfined build", []), True),
            ("nested split", [41] in by.get("nested session", []), True),
            ("nested held", [p.pid for p in held], [51]),
            ("contained list empty", units, []),
            ("unmatched empty", unmatched, []),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

    def _group(self, moves):
        out = {}
        for reason, tree in moves:
            out.setdefault(reason, []).append(tree)
        return out

    def test_contained_planning_guard_rows(self):
        limited = "/user.slice/user-1000.slice/user@1000.service/app.slice/limited.service"
        contained_scope = "/user.slice/user-1000.slice/user@1000.service/agents.slice/contained.scope"
        plain_limited = "/user.slice/user-1000.slice/user@1000.service/app.slice/plain-limited.service"
        recs = {
            1: self.P(1, 0, "systemd", ["/usr/lib/systemd/systemd", "--user"], "/user.slice"),
            10: self.P(10, 1, "bash", ["bash"], marked=True),
            11: self.P(11, 10, "cargo", ["cargo", "build"], limited, exe=f"{self.w.HOME}/.cargo/bin/cargo", marked=True),
            20: self.P(20, 1, "codex", ["codex"], contained_scope, start=1),
            21: self.P(21, 20, "claude", ["claude", "-p", "x"], contained_scope, start=2),
            30: self.P(30, 1, "bash", ["bash"], plain_limited, exe="/usr/bin/bash"),
            31: self.P(31, 30, "sleep", ["sleep", "10"], plain_limited, exe="/usr/bin/sleep"),
        }
        contained = lambda cg: self.w.unit_of(cg) in {"limited.service", "contained.scope", "plain-limited.service"}
        moves, _, _, units = self.w.plan(recs, contained=contained, split=True)
        moved = {p.pid for _, tree in moves for p in tree}
        unitp = {p.pid for p in units}
        by = self._group(moves)
        rows = [
            ("contained descendant stays out of moved tree", [10] in [sorted(p.pid for p in t) for t in by.get("escaped launch", [])] and 11 not in moved, True),
            ("contained descendant is listed as a contained candidate", 11 in unitp, True),
            ("contained agent scope is not split", 21 not in moved, True),
            ("unmarked limited service is not listed", {30, 31} & unitp, set()),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

    def test_recheck_refuses_contained_unit(self):
        p = self.P(70, 1, "cargo", ["cargo", "build"], exe=f"{self.w.HOME}/.cargo/bin/cargo", start=7)
        q = self.P(70, 1, "cargo", ["cargo", "build"], exe=f"{self.w.HOME}/.cargo/bin/cargo", start=7)
        old_pidfd, old_close, old_proc, old_contained = self.w.os.pidfd_open, self.w.os.close, self.w.Proc, self.w.contained_unit
        self.w.os.pidfd_open = lambda pid: 99
        self.w.os.close = lambda fd: None
        self.w.Proc = lambda pid: q
        self.w.contained_unit = lambda cg: True
        try:
            self.assertIsNone(self.w.recheck(p, nested=False))
        finally:
            self.w.os.pidfd_open, self.w.os.close, self.w.Proc, self.w.contained_unit = old_pidfd, old_close, old_proc, old_contained

    def test_containment_mutant_controls(self):
        text = WARDEN.read_text()
        mutations = [
            (
                "stop_default",
                " or is_contained(p)\n                or not p.rides_along",
                "\n                or not p.rides_along",
                lambda m: self._mutant_moves_contained_descendant(m),
            ),
            (
                "by_cg",
                "if p.is_agent and p.confined and not is_contained(p):",
                "if p.is_agent and p.confined:",
                lambda m: self._mutant_splits_contained_scope(m),
            ),
            (
                "recheck",
                "or contained_unit(q.cgroup) or (nested and lineage_is_capped(q.cgroup))",
                "or False or (nested and lineage_is_capped(q.cgroup))",
                lambda m: self._mutant_recheck_accepts_contained(m),
            ),
        ]
        for name, old, new, probe in mutations:
            with self.subTest(name=name):
                self.assertEqual(text.count(old), 1)
                mutant = self.load_mutant(text.replace(old, new), f"agent_warden_mutant_{name}")
                self.assertTrue(probe(mutant))

    def _mutant_moves_contained_descendant(self, m):
        limited = "/user.slice/user-1000.slice/user@1000.service/app.slice/limited.service"
        recs = {
            10: m.Proc(10, ppid=1, comm="bash", argv=["bash"], exe="/usr/bin/bash", cgroup=self.A, start=1, marked=True),
            11: m.Proc(11, ppid=10, comm="cargo", argv=["cargo"], exe=f"{m.HOME}/.cargo/bin/cargo", cgroup=limited, start=1, marked=True),
        }
        moves, _, _, _ = m.plan(recs, contained=lambda cg: m.unit_of(cg) == "limited.service")
        return [10, 11] in [sorted(p.pid for p in tree) for _, tree in moves]

    def _mutant_splits_contained_scope(self, m):
        contained_scope = "/user.slice/user-1000.slice/user@1000.service/agents.slice/contained.scope"
        recs = {
            20: m.Proc(20, ppid=1, comm="codex", argv=["codex"], exe=default_tool_exe(m, "codex"), cgroup=contained_scope, start=1),
            21: m.Proc(21, ppid=20, comm="claude", argv=["claude"], exe=default_tool_exe(m, "claude"), cgroup=contained_scope, start=2),
        }
        moves, _, _, _ = m.plan(recs, capped=lambda cg: False, contained=lambda cg: m.unit_of(cg) == "contained.scope", split=True)
        return any([21] == [p.pid for p in tree] for reason, tree in moves if reason == "nested session")

    def _mutant_recheck_accepts_contained(self, m):
        p = m.Proc(70, ppid=1, comm="cargo", argv=["cargo"], exe=f"{m.HOME}/.cargo/bin/cargo", cgroup=self.A, start=7)
        q = m.Proc(70, ppid=1, comm="cargo", argv=["cargo"], exe=f"{m.HOME}/.cargo/bin/cargo", cgroup=self.A, start=7)
        old_pidfd, old_close, old_proc, old_contained = m.os.pidfd_open, m.os.close, m.Proc, m.contained_unit
        m.os.pidfd_open = lambda pid: 99
        m.os.close = lambda fd: None
        m.Proc = lambda pid: q
        m.contained_unit = lambda cg: True
        try:
            return m.recheck(p, nested=False) is not None
        finally:
            m.os.pidfd_open, m.os.close, m.Proc, m.contained_unit = old_pidfd, old_close, old_proc, old_contained

    def test_warden_scope_name_rows(self):
        build = self.P(810, 1, "cargo", ["cargo"], exe=f"{self.w.HOME}/.cargo/bin/cargo", start=44)
        session = self.P(811, 1, "goose", ["goose"], exe=f"{self.w.HOME}/bin/goose", start=45, marked=True)
        rows = [
            ("unconfined build", self.w.warden_scope_name(build, "unconfined build"), "agent-warden-build-810-44.scope"),
            ("escaped build root", self.w.warden_scope_name(build, "escaped launch"), "agent-warden-build-810-44.scope"),
            ("escaped session root", self.w.warden_scope_name(session, "escaped launch"), "agent-warden-811-45.scope"),
            ("nested session", self.w.warden_scope_name(session, "nested session"), "agent-warden-811-45.scope"),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

    def test_warden_scope_name_build_mutant_fails(self):
        text = WARDEN.read_text()
        old = 'prefix = "agent-warden-build" if reason == "unconfined build" or (reason == "escaped launch" and root.is_build) else "agent-warden"'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, 'prefix = "agent-warden"'), "agent_warden_mutant_scope_name")
        build = mutant.Proc(810, ppid=1, comm="cargo", argv=["cargo"], exe=f"{mutant.HOME}/.cargo/bin/cargo", cgroup=self.A, start=44)
        self.assertNotEqual(mutant.warden_scope_name(build, "unconfined build"), "agent-warden-build-810-44.scope")

    def test_move_result_classification_rows(self):
        root = self.P(900, 1, "codex", ["codex"], self.S)
        child = self.P(901, 900, "bash", ["bash"], self.S)
        rows = [
            ("done", True, [root, child], [], {"moves": 1, "partial": 0, "move_failures": 0}, 1, 0),
            ("partial", False, [root], [child], {"moves": 0, "partial": 1, "move_failures": 0}, 1, 0),
            ("all missing", False, [], [root, child], {"moves": 0, "partial": 0, "move_failures": 1}, 0, 1),
        ]
        for name, done, moved, missing, expected, summary_len, failures_len in rows:
            with self.subTest(name=name):
                state = {"moves": 0, "partial": 0, "move_failures": 0}
                summary = []
                failures = []
                self.w.record_move_result(state, summary, failures, root, "escaped launch", done, "unit.scope", moved, missing)
                self.assertEqual({key: state[key] for key in expected}, expected)
                self.assertEqual(len(state.get("events", [])), 1)
                self.assertEqual(state["events"][0]["kind"], "moved" if done else "partial" if moved else "failed")
                self.assertEqual(len(summary), summary_len)
                self.assertEqual(len(failures), failures_len)

    def test_job_unit_rows(self):
        orch = "/user.slice/user-1000.slice/user@1000.service/app.slice/orch-validate-vsy-50-12345.service"
        limited = "/user.slice/user-1000.slice/user@1000.service/app.slice/build-with-memory.service"
        plain = "/user.slice/user-1000.slice/user@1000.service/app.slice/app-foo.scope"
        tmux = "/user.slice/user-1000.slice/user@1000.service/app.slice/tmux.service"
        recs = {
            1: self.P(1, 0, "systemd", ["/usr/lib/systemd/systemd", "--user"], "/user.slice"),
            100: self.P(100, 1, "bash", ["bash"], orch, marked=True),
            101: self.P(101, 100, "python3", ["python3", "build.py"], orch, marked=True),
            102: self.P(102, 101, "cargo", ["cargo", "build"], orch, exe=f"{self.w.HOME}/.cargo/bin/cargo", marked=True),
            103: self.P(103, 102, "rustc", ["rustc"], orch, exe=f"{self.w.HOME}/.rustup/x/rustc", marked=True),
            104: self.P(104, 1, "codex", ["codex", "exec"], orch, marked=True),
            110: self.P(110, 1, "bash", ["bash"], limited, marked=True),
            111: self.P(111, 110, "cargo", ["cargo"], limited, exe=f"{self.w.HOME}/.cargo/bin/cargo", marked=True),
            120: self.P(120, 1, "bash", ["bash"], plain, marked=True),
            121: self.P(121, 120, "cargo", ["cargo"], plain, exe=f"{self.w.HOME}/.cargo/bin/cargo", marked=True),
            130: self.P(130, 1, "bash", ["bash"], tmux, marked=True),
            131: self.P(131, 130, "cargo", ["cargo"], tmux, exe=f"{self.w.HOME}/.cargo/bin/cargo", marked=True),
        }
        contained = lambda cg: self.w.contained_unit(cg) or self.w.unit_of(cg) == "build-with-memory.service"
        moves, _, _, units = self.w.plan(recs, contained=contained)
        moved = {p.pid for _, tree in moves for p in tree}
        unitp = {p.pid for p in units}
        by = self._group(moves)
        rows = [
            ("orch marked build tree left", {100, 101, 102, 103}.issubset(unitp) and not ({100, 101, 102, 103} & moved), True),
            ("agent cli inside orch left", 104 in unitp and 104 not in moved, True),
            ("non-orch limited service left", {110, 111}.issubset(unitp) and not ({110, 111} & moved), True),
            ("plain scope still escaped", [120, 121] in [sorted(p.pid for p in t) for t in by.get("escaped launch", [])], True),
            ("tmux service unchanged", [130, 131] in [sorted(p.pid for p in t) for t in by.get("escaped launch", [])], True),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

    def test_portability_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "XDG_DATA_HOME": base / "data"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "XDG_DATA_HOME"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            default_w = load_warden(env, "agent_warden_default_mise")
            override_env = clean_env({
                "HOME": base / "home2", "XDG_RUNTIME_DIR": base / "run2",
                "AGENT_TMPDIR": base / "scratch-override",
            })
            for key in ("HOME", "XDG_RUNTIME_DIR"):
                Path(override_env[key]).mkdir(parents=True, exist_ok=True)
            override_w = load_warden(override_env, "agent_warden_scratch_override")
        rows = [
            ("mise dir follows MISE_DATA_DIR", self.w.MISE_DATA, self.env["MISE_DATA_DIR"]),
            ("agent regex follows MISE_DATA_DIR", bool(self.w.AGENT_PATH_RE.search(f"{self.env['MISE_DATA_DIR']}/installs/claude/latest/claude")), True),
            ("default mise under XDG data", default_w.MISE_DATA, str(Path(env["XDG_DATA_HOME"]) / "mise")),
            ("toolchain prefix follows MISE_DATA_DIR", self.env["MISE_DATA_DIR"] + "/" in self.w.TOOLCHAIN_PREFIXES, True),
            ("unit_of skips slices", self.w.unit_of("/user.slice/user-1000.slice/user@1000.service/app.slice/orch-x.service/child"), "orch-x.service"),
            ("default scratch parent under XDG cache", default_w.AGENT_TMPDIR_PARENT, str(Path(env["HOME"]) / ".cache" / "agents" / "tmp")),
            ("AGENT_TMPDIR overrides the scratch parent", override_w.AGENT_TMPDIR_PARENT, override_env["AGENT_TMPDIR"]),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)
        self.assertEqual(tracked_offenders(ROOT, "/home/" + "method"), [])

    def test_portability_scan_reads_only_tracked_files(self):
        forbidden = "/home/" + "method"
        with scratch() as tmp:
            repo = Path(tmp)
            env = {"PATH": BASE_PATH}
            files = {
                "warden/agent-warden": f"src = '{forbidden}/x'\n",
                "warden/clean": "nothing here\n",
                "warden/__pycache__/agent_warden_testlib.cpython-314.pyc": f"\x00{forbidden}/dev/vsys/warden\x00",
                "warden/untracked-note": f"{forbidden}\n",
            }
            for name, text in files.items():
                (repo / name).parent.mkdir(parents=True, exist_ok=True)
                (repo / name).write_text(text)
            with self.assertRaisesRegex(unittest.SkipTest, "no git metadata"):
                tracked_offenders(repo, forbidden)
            subprocess.run(["git", "init", "-q", str(repo)], env=env, capture_output=True, check=True)
            with self.assertRaisesRegex(AssertionError, "portability extractor is broken"):
                tracked_offenders(repo, forbidden)
            subprocess.run(["git", "-C", str(repo), "add", "--", "warden/agent-warden", "warden/clean"], env=env, capture_output=True, check=True)
            self.assertEqual(tracked_offenders(repo, forbidden), ["warden/agent-warden"])

    def test_contained_unit_limit_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            old_root = self.w.CG_ROOT
            self.w.CG_ROOT = base / "cg"
            try:
                unit = self.w.CG_ROOT / "app.slice" / "limited.service"
                unit.mkdir(parents=True)
                rows = []
                for name, file_name, value in (
                    ("memory max", "memory.max", "1"),
                    ("memory high", "memory.high", "1"),
                    ("memory swap max", "memory.swap.max", "1"),
                    ("cpu max", "cpu.max", "1000 10000"),
                    ("io max", "io.max", "8:0 rbps=1"),
                    ("cpuset cpus", "cpuset.cpus", "0"),
                    ("cpuset mems", "cpuset.mems", "0"),
                ):
                    for child in unit.iterdir():
                        child.unlink()
                    (unit / file_name).write_text(value)
                    rows.append((name, self.w.contained_unit("/user.slice/user-1000.slice/user@1000.service/app.slice/limited.service"), True))
                for child in unit.iterdir():
                    child.unlink()
                (unit / "pids.max").write_text("1")
                rows.append(("pids max ignored", self.w.contained_unit("/user.slice/user-1000.slice/user@1000.service/app.slice/limited.service"), False))
                for name, actual, expected in rows:
                    with self.subTest(name=name):
                        self.assertEqual(actual, expected)
            finally:
                self.w.CG_ROOT = old_root

    def test_selftest_subprocess_exits_zero(self):
        with scratch() as tmp:
            base = Path(tmp)
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise", "TMPDIR": base / "scratch"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR", "TMPDIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            result = subprocess.run([sys.executable, str(WARDEN), "--selftest"], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_job_unit_guard_mutant_fails(self):
        text = WARDEN.read_text()
        old = 'os.environ.get("AGENT_WARDEN_JOB_UNITS", "orch-*.service")'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, 'os.environ.get("AGENT_WARDEN_JOB_UNITS", "")'), "agent_warden_mutant_job_units")
        orch = "/user.slice/user-1000.slice/user@1000.service/app.slice/orch-validate-vsy-50.service"
        recs = {
            100: mutant.Proc(100, ppid=1, comm="bash", argv=["bash"], exe="/usr/bin/bash", cgroup=orch, start=1, marked=True),
            101: mutant.Proc(101, ppid=100, comm="cargo", argv=["cargo"], exe=f"{mutant.HOME}/.cargo/bin/cargo", cgroup=orch, start=1, marked=True),
        }
        moves, _, _, units = mutant.plan(recs, contained=mutant.contained_unit)
        self.assertIn([100, 101], [sorted(p.pid for p in tree) for _, tree in moves])
        self.assertEqual(units, [])


if __name__ == "__main__":
    unittest.main()
