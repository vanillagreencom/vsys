import importlib.machinery
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
WARDEN = ROOT / "warden" / "agent-warden"
SCRATCH_ROOT = ROOT / "tmp" / "warden-tests"
BASE_PATH = os.environ.get("PATH", "/usr/bin:/bin")


def scratch():
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=SCRATCH_ROOT)


def clean_env(base, *, path=False):
    env = {key: str(value) for key, value in base.items()}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if path:
        env["PATH"] = BASE_PATH
    return env


def load_warden(env, name="agent_warden_under_test", path=WARDEN):
    old = os.environ.copy()
    os.environ.clear()
    os.environ.update(env)
    try:
        loader = importlib.machinery.SourceFileLoader(name, str(path))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        if spec is None:
            raise RuntimeError("agent-warden import spec unavailable")
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        return module
    finally:
        os.environ.clear()
        os.environ.update(old)


class AgentWardenRules(unittest.TestCase):
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
        cls.S = "/user.slice/user-1000.slice/user@1000.service/agents.slice/lane.scope"

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def P(self, pid, ppid, comm, argv, cg=None, exe="/usr/bin/x", start=1, marked=False, tty=0):
        return self.w.Proc(pid, ppid=ppid, comm=comm, argv=argv, exe=exe, cgroup=cg or self.A, start=start, marked=marked, tty=tty)

    def test_classification_rows(self):
        mise = f"{self.w.MISE_DATA}/installs"
        rows = [
            ("agent by comm", self.P(1, 0, "claude", ["claude"]).is_agent, True),
            ("hosted mise cli", self.P(2, 0, "node", [f"{mise}/pi/latest/pi/node", f"{mise}/pi/latest/pi/dist/cli.js"], exe="/usr/bin/node").is_agent, True),
            ("build by comm", self.P(3, 0, "cargo", ["cargo", "test"]).is_build, True),
            ("desktop by executable", self.P(4, 0, "ChatGPT", ["/opt/codex-desktop/ChatGPT"], exe="/opt/codex-desktop/ChatGPT").is_desktop, True),
            ("excluded flag", self.P(5, 0, "claude", ["claude", "--chrome-native-host"]).excluded, True),
            ("rides along shell", self.P(6, 0, "bash", ["bash", "-c", "cargo test"]).rides_along, True),
            ("bundled CLI", self.P(7, 0, "codex", ["/opt/codex-desktop/resources/codex", "exec"], exe="/opt/codex-desktop/resources/codex").is_agent, True),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

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

    def load_mutant(self, text, name):
        with scratch() as tmp:
            base = Path(tmp)
            path = base / "agent-warden"
            path.write_text(text)
            path.chmod(0o755)
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            return load_warden(env, name, path)

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
            20: m.Proc(20, ppid=1, comm="codex", argv=["codex"], exe=f"{m.HOME}/.local/bin/codex", cgroup=contained_scope, start=1),
            21: m.Proc(21, ppid=20, comm="claude", argv=["claude"], exe=f"{m.HOME}/.local/bin/claude", cgroup=contained_scope, start=2),
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

    def test_lineage_and_task_cap_rows(self):
        with scratch() as tmp:
            base = Path(tmp) / "cg"
            old_root = self.w.CG_ROOT
            self.w.CG_ROOT = base
            try:
                agent_slice = base / self.w.SLICE
                plain = agent_slice / "plain.scope"
                tight = agent_slice / "tight.scope"
                for directory in (agent_slice, plain, tight):
                    directory.mkdir(parents=True, exist_ok=True)
                for directory, pids in ((agent_slice, "100"), (plain, "100"), (tight, "100")):
                    (directory / "pids.max").write_text(pids)
                    (directory / "memory.max").write_text("1000")
                    (directory / "memory.high").write_text("max")
                    (directory / "memory.swap.max").write_text("max")
                    (directory / "cpu.max").write_text("max 100000")
                    (directory / "io.max").write_text("")
                    (directory / "cpuset.cpus").write_text("")
                    (directory / "cpuset.mems").write_text("")
                (tight / "memory.max").write_text("10")
                rows = [
                    ("plain lineage", self.w.lineage_is_capped(self._cg("plain.scope")), False),
                    ("tight memory lineage", self.w.lineage_is_capped(self._cg("tight.scope")), True),
                    ("outside agents slice", self.w.lineage_is_capped("/user.slice/user-1000.slice/user@1000.service/app.slice/x.scope"), True),
                ]
                for name, actual, expected in rows:
                    with self.subTest(name=name):
                        self.assertEqual(actual, expected)
                (agent_slice / "pids.max").write_text("1000")
                unbounded = agent_slice / "unbounded.scope"
                bounded = agent_slice / "bounded.scope"
                unbounded.mkdir()
                bounded.mkdir()
                (unbounded / "pids.max").write_text("max")
                (bounded / "pids.max").write_text("10")
                logs = []
                old_log = self.w.log
                self.w.log = logs.append
                try:
                    self.assertEqual(self.w.enforce_task_caps(False), [])
                finally:
                    self.w.log = old_log
                self.assertTrue(any("unbounded.scope" in line and "would cap" in line for line in logs))
                self.assertFalse(any("scope bounded.scope:" in line for line in logs))
            finally:
                self.w.CG_ROOT = old_root

    def _cg(self, unit):
        return f"/user.slice/user-{self.w.UID}.slice/user@{self.w.UID}.service/{self.w.SLICE}/{unit}"

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

    def test_orphan_rows(self):
        mgr = 4000
        leak = "/user.slice/user-1000.slice/user@1000.service/agents.slice/agent-confine-leak.scope"
        live = "/user.slice/user-1000.slice/user@1000.service/agents.slice/agent-confine-live.scope"
        orch_service = "/user.slice/user-1000.slice/user@1000.service/agents.slice/orch-validate-vsy-50.service"
        recs = {
            mgr: self.P(mgr, 1, "systemd", ["/usr/lib/systemd/systemd", "--user"], "/user.slice"),
            200: self.P(200, mgr, "bun", ["bun"], leak, exe="/usr/bin/bun"),
            201: self.P(201, mgr, "bun", ["bun"], leak, exe="/usr/bin/bun"),
            210: self.P(210, 30, "claude", ["claude"], live, tty=111),
            211: self.P(211, 210, "node", ["node"], live, exe="/usr/bin/node"),
            220: self.P(220, mgr, "cargo", ["cargo"], orch_service, exe=f"{self.w.HOME}/.cargo/bin/cargo"),
        }
        units = {unit for unit, _ in self.w.orphans(recs, self.w.manager_pids(recs))}
        rows = [
            ("orphan leak found", "agent-confine-leak.scope" in units, True),
            ("live tty session protected", "agent-confine-live.scope" in units, False),
            ("job service is not a scope orphan", "orch-validate-vsy-50.service" in units, False),
            ("process count harm", self.w.scope_harm(5140, 0.0), True),
            ("cpu harm", self.w.scope_harm(1, 0.8), True),
            ("quiet orphan not harmful", self.w.scope_harm(6, 0.0), False),
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
        rows = [
            ("mise dir follows MISE_DATA_DIR", self.w.MISE_DATA, self.env["MISE_DATA_DIR"]),
            ("agent regex follows MISE_DATA_DIR", bool(self.w.AGENT_PATH_RE.search(f"{self.env['MISE_DATA_DIR']}/installs/claude/latest/claude")), True),
            ("default mise under XDG data", default_w.MISE_DATA, str(Path(env["XDG_DATA_HOME"]) / "mise")),
            ("toolchain prefix follows MISE_DATA_DIR", self.env["MISE_DATA_DIR"] + "/" in self.w.TOOLCHAIN_PREFIXES, True),
            ("unit_of skips slices", self.w.unit_of("/user.slice/user-1000.slice/user@1000.service/app.slice/orch-x.service/child"), "orch-x.service"),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)
        forbidden = "/home/" + "method"
        offenders = [str(path.relative_to(ROOT)) for path in (ROOT / "warden").rglob("*") if path.is_file() and forbidden in path.read_text(errors="ignore")]
        self.assertEqual(offenders, [])

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
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
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
            result = subprocess.run([str(ROOT / "warden" / "agent-confine"), "env"], env=env, capture_output=True, text=True)
            expected = str(Path(env["XDG_CACHE_HOME"]) / "agents" / "tmp")
            created = Path(expected).is_dir()
        rows = [
            ("outside-slice branch succeeds with systemd-run unavailable", result.returncode, 0),
            ("outside-slice branch exports default TMPDIR", f"TMPDIR={expected}" in result.stdout.splitlines(), True),
            ("outside-slice branch creates default TMPDIR", created, True),
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
            result = subprocess.run([str(launcher), "env"], env=env, capture_output=True, text=True)
            expected = str(Path(env["XDG_CACHE_HOME"]) / "agents" / "tmp")
            created = Path(expected).is_dir()
        rows = [
            ("nested plain-lineage branch succeeds with systemd-run unavailable", result.returncode, 0),
            ("nested plain-lineage branch exports default TMPDIR", f"TMPDIR={expected}" in result.stdout.splitlines(), True),
            ("nested plain-lineage branch creates default TMPDIR", created, True),
        ]
        for name, actual, expected_value in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected_value)


if __name__ == "__main__":
    unittest.main()
