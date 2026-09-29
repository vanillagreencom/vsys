import importlib.machinery
import importlib.util
import json
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


    def test_agent_tool_data_drives_classification_constants(self):
        with scratch() as tmp:
            base = Path(tmp)
            script = base / "warden" / "agent-warden"
            script.parent.mkdir(parents=True)
            shutil.copy2(WARDEN, script)
            script.chmod(0o755)
            data_dir = base / "data"
            data_dir.mkdir()
            (data_dir / "agent-tools.json").write_text(json.dumps({
                "version": 1.0,
                "tools": [{"name": "zz-agent", "mise": ["zz-install"]}],
                "desktopExePrefixes": ["/zz/"],
                "bundledCliSuffixes": ["/zz/cli"],
            }))
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            module = load_warden(env, "agent_warden_synthetic_tools", script)
        rows = [
            ("agent names from data", module.AGENT_COMMS, {"zz-agent"}),
            ("mise path from data", bool(module.AGENT_PATH_RE.search(f"{env['MISE_DATA_DIR']}/installs/zz-install/bin/zz")), True),
            ("old mise absent", bool(module.AGENT_PATH_RE.search(f"{env['MISE_DATA_DIR']}/installs/claude/bin/claude")), False),
            ("desktop prefixes from data", module.DESKTOP_EXE_PREFIXES, ("/zz/",)),
            ("bundled suffixes from data", module.BUNDLED_CLI_SUFFIXES, ("/zz/cli",)),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

    def test_agent_tool_data_inline_mutant_fails(self):
        text = WARDEN.read_text()
        old = 'AGENT_COMMS = {tool["name"] for tool in AGENT_TOOLS["tools"]}'
        self.assertEqual(text.count(old), 1)
        mutant = text.replace(old, 'AGENT_COMMS = {"claude"}')
        with scratch() as tmp:
            base = Path(tmp)
            script = base / "warden" / "agent-warden"
            script.parent.mkdir(parents=True)
            script.write_text(mutant)
            script.chmod(0o755)
            data_dir = base / "data"
            data_dir.mkdir()
            (data_dir / "agent-tools.json").write_text(json.dumps({
                "version": 1,
                "tools": [{"name": "zz-agent", "mise": ["zz-install"]}],
            }))
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            module = load_warden(env, "agent_warden_inline_mutant", script)
        self.assertNotEqual(module.AGENT_COMMS, {"zz-agent"})

    def test_installed_agent_tool_layout_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            script = base / "bin" / "agent-warden"
            script.parent.mkdir(parents=True)
            shutil.copy2(WARDEN, script)
            script.chmod(0o755)
            data_home = base / "xdg-data"
            data_dir = data_home / "vsys"
            data_dir.mkdir(parents=True)
            (data_dir / "agent-tools.json").write_text(json.dumps({
                "version": 1,
                "tools": [{"name": "xi-agent", "mise": ["xi-install"]}],
            }))
            env = clean_env({
                "HOME": base / "home",
                "XDG_RUNTIME_DIR": base / "run",
                "XDG_DATA_HOME": data_home,
                "MISE_DATA_DIR": base / "mise",
            })
            for key in ("HOME", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            module = load_warden(env, "agent_warden_installed_layout", script)
            self.assertEqual(module.AGENT_COMMS, {"xi-agent"})
            (data_dir / "agent-tools.json").unlink()
            result = subprocess.run([sys.executable, str(script), "--selftest"], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(result.stderr.splitlines()[0].startswith("agent-warden: agent-tools=missing "))

    def test_owner_agent_tool_overlay_pins_workstation_set(self):
        with scratch() as tmp:
            base = Path(tmp)
            home = base / "home"
            overlay = home / ".config" / "vsys" / "agent-tools.json"
            overlay.parent.mkdir(parents=True)
            shutil.copy2(ROOT / "data" / "owner-agent-tools.json", overlay)
            env = clean_env({"HOME": home, "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"})
            for key in ("XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            module = load_warden(env, "agent_warden_owner_overlay")
            no_overlay_home = base / "home-no-overlay"
            env_no_overlay = clean_env({"HOME": no_overlay_home, "XDG_RUNTIME_DIR": base / "run-no-overlay", "MISE_DATA_DIR": base / "mise-no-overlay"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env_no_overlay[key]).mkdir(parents=True, exist_ok=True)
            module_no_overlay = load_warden(env_no_overlay, "agent_warden_no_owner_overlay")
        old_names = {"claude", "codex", "pi", "opencode", "gemini", "copilot", "crush", "dsh", "grok", "antigravity", "agy", "omp", "ori", "fx", "cursor-agent", "muse"}
        shipped_names = {"claude", "codex", "gemini", "copilot", "opencode", "crush", "cursor-agent", "pi", "grok", "antigravity"}
        old_mise = ["claude", "codex", "pi", "opencode", "gemini", "copilot", "crush", "cursor-agent", "npm-deepseek-ai-dsh", "npm-xai-official-grok", "aqua-google-antigravity", "github-can1357-oh-my-pi", "github-open-router-labs-ori-releases", "github-vercel-labs-fx", "http-muse"]
        self.assertEqual(module.AGENT_COMMS, old_names)
        self.assertEqual(module_no_overlay.AGENT_COMMS, shipped_names)
        for directory in old_mise:
            with self.subTest(directory=directory):
                self.assertTrue(module.AGENT_PATH_RE.search(f"{env['MISE_DATA_DIR']}/installs/{directory}/bin/tool"))
        self.assertFalse(module.AGENT_PATH_RE.search(f"{env['MISE_DATA_DIR']}/installs/unlisted/bin/tool"))

    def test_malformed_agent_tool_documents_are_refused(self):
        rows = [
            ("bad shipped version", {"version": 2, "tools": []}, None, "agent-tools.json"),
            ("version true", {"version": True, "tools": []}, None, "agent-tools.json"),
            ("unknown overlay key", {"version": 1, "tools": []}, {"version": 1, "tools": [], "extra": True}, ".config/vsys/agent-tools.json"),
            ("duplicate overlay name", {"version": 1, "tools": [{"name": "claude"}]}, {"version": 1, "tools": [{"name": "claude"}]}, ".config/vsys/agent-tools.json"),
            ("mise slash", {"version": 1, "tools": [{"name": "ok", "mise": ["bad/dir"]}]}, None, "agent-tools.json"),
            ("prefix relative", {"version": 1, "tools": [], "desktopExePrefixes": ["relative"]}, None, "agent-tools.json"),
            ("non json", "{", None, "agent-tools.json"),
            ("invalid utf8", b"\xff", None, "agent-tools.json"),
        ]
        for name, shipped, overlay, bad_path in rows:
            with self.subTest(name=name):
                result = self._run_bad_agent_tools(shipped, overlay)
                self.assertNotEqual(result.returncode, 0)
                first = result.stderr.splitlines()[0]
                self.assertIn("agent-warden: agent-tools=invalid ", first)
                self.assertIn(bad_path, first)

    def _run_bad_agent_tools(self, shipped, overlay):
        with scratch() as tmp:
            base = Path(tmp)
            script = base / "warden" / "agent-warden"
            script.parent.mkdir(parents=True)
            shutil.copy2(WARDEN, script)
            script.chmod(0o755)
            data_dir = base / "data"
            data_dir.mkdir()
            data_path = data_dir / "agent-tools.json"
            if isinstance(shipped, bytes):
                data_path.write_bytes(shipped)
            elif isinstance(shipped, str):
                data_path.write_text(shipped)
            else:
                data_path.write_text(json.dumps(shipped))
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            if overlay is not None:
                overlay_path = Path(env["HOME"]) / ".config" / "vsys" / "agent-tools.json"
                overlay_path.parent.mkdir(parents=True)
                overlay_path.write_text(json.dumps(overlay))
            return subprocess.run([sys.executable, str(script), "--selftest"], env=env, capture_output=True, text=True)

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
            path = base / "warden" / "agent-warden"
            path.parent.mkdir(parents=True)
            path.write_text(text)
            path.chmod(0o755)
            data_dir = base / "data"
            data_dir.mkdir()
            shutil.copy2(ROOT / "data" / "agent-tools.json", data_dir / "agent-tools.json")
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

    def _cg(self, unit):
        return f"/user.slice/user-{self.w.UID}.slice/user@{self.w.UID}.service/{self.w.SLICE}/{unit}"

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

    def test_cpu_weight_rows(self):
        self.assertEqual(self.w.SCOPE_CPU_WEIGHT, 99)
        source = WARDEN.read_text()
        self.assertIn("ctypes.c_uint64(SCOPE_CPU_WEIGHT)", source)

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
        rooted = "/user.slice/user-1000.slice/user@1000.service/agents.slice/agent-confine-300-123.scope"
        root_gone = "/user.slice/user-1000.slice/user@1000.service/agents.slice/agent-confine-301-123.scope"
        inside_parent = "/user.slice/user-1000.slice/user@1000.service/agents.slice/agent-confine-302-123.scope"
        adopted = "/user.slice/user-1000.slice/user@1000.service/agents.slice/agent-warden-build-303-123.scope"
        warden_rooted = "/user.slice/user-1000.slice/user@1000.service/agents.slice/agent-warden-304-123.scope"
        warden_gone = "/user.slice/user-1000.slice/user@1000.service/agents.slice/agent-warden-305-123.scope"
        warden_reused = "/user.slice/user-1000.slice/user@1000.service/agents.slice/agent-warden-306-123.scope"
        recs = {
            mgr: self.P(mgr, 1, "systemd", ["/usr/lib/systemd/systemd", "--user"], "/user.slice"),
            200: self.P(200, mgr, "bun", ["bun"], leak, exe="/usr/bin/bun"),
            201: self.P(201, mgr, "bun", ["bun"], leak, exe="/usr/bin/bun"),
            210: self.P(210, 30, "claude", ["claude"], live, tty=111),
            211: self.P(211, 210, "node", ["node"], live, exe="/usr/bin/node"),
            220: self.P(220, mgr, "cargo", ["cargo"], orch_service, exe=f"{self.w.HOME}/.cargo/bin/cargo"),
            300: self.P(300, mgr, "goose", ["goose"], rooted, exe=f"{self.w.HOME}/bin/goose", marked=True),
            **{400 + i: self.P(400 + i, 300, "rustc", ["rustc"], rooted, exe=f"{self.w.HOME}/.rustup/x/rustc", marked=True) for i in range(50)},
            4010: self.P(4010, mgr, "rustc", ["rustc"], root_gone, exe=f"{self.w.HOME}/.rustup/x/rustc", marked=True),
            4011: self.P(4011, 4010, "rustc", ["rustc"], root_gone, exe=f"{self.w.HOME}/.rustup/x/rustc", marked=True),
            302: self.P(302, 4020, "goose", ["goose"], inside_parent, exe=f"{self.w.HOME}/bin/goose", marked=True),
            4020: self.P(4020, mgr, "bash", ["bash"], inside_parent, exe="/usr/bin/bash", marked=True),
            303: self.P(303, mgr, "rustc", ["rustc"], adopted, exe=f"{self.w.HOME}/.rustup/x/rustc"),
            4030: self.P(4030, 303, "rustc", ["rustc"], adopted, exe=f"{self.w.HOME}/.rustup/x/rustc"),
            304: self.P(304, mgr, "goose", ["goose"], warden_rooted, exe=f"{self.w.HOME}/bin/goose", marked=True, start=123),
            **{500 + i: self.P(500 + i, 304, "rustc", ["rustc"], warden_rooted, exe=f"{self.w.HOME}/.rustup/x/rustc", marked=True) for i in range(50)},
            4050: self.P(4050, mgr, "rustc", ["rustc"], warden_gone, exe=f"{self.w.HOME}/.rustup/x/rustc", marked=True),
            306: self.P(306, mgr, "goose", ["goose"], warden_reused, exe=f"{self.w.HOME}/bin/goose", marked=True, start=999),
            4060: self.P(4060, 306, "rustc", ["rustc"], warden_reused, exe=f"{self.w.HOME}/.rustup/x/rustc", marked=True),
        }
        units = {unit for unit, _ in self.w.orphans(recs, self.w.manager_pids(recs))}
        rows = [
            ("orphan leak found", "agent-confine-leak.scope" in units, True),
            ("live tty session protected", "agent-confine-live.scope" in units, False),
            ("job service is not a scope orphan", "orch-validate-vsy-50.service" in units, False),
            ("agent-confine live launch root protects unlisted agent", "agent-confine-300-123.scope" in units, False),
            ("agent-confine scope with missing launch root is orphan", "agent-confine-301-123.scope" in units, True),
            ("root pid parented inside scope does not protect", "agent-confine-302-123.scope" in units, True),
            ("agent-warden build scope with live root stays reapable", "agent-warden-build-303-123.scope" in units, True),
            ("agent-warden session scope with live root is protected", "agent-warden-304-123.scope" in units, False),
            ("agent-warden session scope with missing root is orphan", "agent-warden-305-123.scope" in units, True),
            ("agent-warden session scope with reused pid is orphan", "agent-warden-306-123.scope" in units, True),
            ("process count harm", self.w.scope_harm(5140, 0.0), True),
            ("cpu harm", self.w.scope_harm(1, 0.8), True),
            ("quiet orphan not harmful", self.w.scope_harm(6, 0.0), False),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

    def test_scope_still_orphan_refuses_incomplete_membership(self):
        with scratch() as tmp:
            old_root, old_proc = self.w.CG_ROOT, self.w.Proc
            self.w.CG_ROOT = Path(tmp) / "cg"
            try:
                unit = "agent-confine-leak.scope"
                scope = self.w.CG_ROOT / self.w.SLICE / unit
                child = scope / "child"
                child.mkdir(parents=True)
                (scope / "cgroup.procs").write_text("200\n")
                (child / "cgroup.procs").mkdir()
                self.w.Proc = lambda pid: old_proc(pid, ppid=4000, comm="bun", argv=["bun"], exe="/usr/bin/bun", cgroup=f"/user.slice/user-{self.w.UID}.slice/user@{self.w.UID}.service/{self.w.SLICE}/{unit}", start=1)
                self.assertFalse(self.w.scope_still_orphan(unit, {4000}))
            finally:
                self.w.CG_ROOT, self.w.Proc = old_root, old_proc

    def test_scope_still_orphan_skips_vanished_child(self):
        with scratch() as tmp:
            old_root, old_proc, old_procfiles = self.w.CG_ROOT, self.w.Proc, self.w._scope_procfiles
            self.w.CG_ROOT = Path(tmp) / "cg"
            try:
                unit = "agent-confine-leak.scope"
                scope = self.w.CG_ROOT / self.w.SLICE / unit
                vanished = scope / "gone" / "cgroup.procs"
                scope.mkdir(parents=True)
                (scope / "cgroup.procs").write_text("200\n")
                self.w._scope_procfiles = lambda base: [scope / "cgroup.procs", vanished]
                self.w.Proc = lambda pid: old_proc(pid, ppid=4000, comm="bun", argv=["bun"], exe="/usr/bin/bun", cgroup=f"/user.slice/user-{self.w.UID}.slice/user@{self.w.UID}.service/{self.w.SLICE}/{unit}", start=1)
                self.assertTrue(self.w.scope_still_orphan(unit, {4000}))
            finally:
                self.w.CG_ROOT, self.w.Proc, self.w._scope_procfiles = old_root, old_proc, old_procfiles

    def test_scope_still_orphan_incomplete_membership_mutant_fails(self):
        text = WARDEN.read_text()
        old = '        txt = read(procfile)\n        if txt is None:\n            if procfile.parent.exists():\n                log(f"orphan recheck incomplete: cannot read {procfile}")\n                return False\n            continue\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, '        txt = read(procfile, "") or ""\n'), "agent_warden_mutant_scope_recheck")
        with scratch() as tmp:
            old_root, old_proc = mutant.CG_ROOT, mutant.Proc
            mutant.CG_ROOT = Path(tmp) / "cg"
            try:
                unit = "agent-confine-leak.scope"
                scope = mutant.CG_ROOT / mutant.SLICE / unit
                child = scope / "child"
                child.mkdir(parents=True)
                (scope / "cgroup.procs").write_text("200\n")
                (child / "cgroup.procs").mkdir()
                mutant.Proc = lambda pid: old_proc(pid, ppid=4000, comm="bun", argv=["bun"], exe="/usr/bin/bun", cgroup=f"/user.slice/user-{mutant.UID}.slice/user@{mutant.UID}.service/{mutant.SLICE}/{unit}", start=1)
                self.assertTrue(mutant.scope_still_orphan(unit, {4000}))
            finally:
                mutant.CG_ROOT, mutant.Proc = old_root, old_proc

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


    def point_status_state(self, module, base):
        old = module.STATE_DIR, module.STATE, module.STATUS, module.LOCK, module.CG_ROOT
        module.STATE_DIR = base / "state"
        module.STATE = module.STATE_DIR / "state.json"
        module.STATUS = module.STATE_DIR / "status.json"
        module.LOCK = module.STATE_DIR / "lock"
        module.CG_ROOT = base / "cg"
        return old

    def restore_status_state(self, module, old):
        module.STATE_DIR, module.STATE, module.STATUS, module.LOCK, module.CG_ROOT = old

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

    def test_status_writer_uses_rename_and_mode(self):
        self.assertTrue(self.status_writer_is_atomic(self.w))

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
                    json.dumps({"event_seq": "1"}),
                    json.dumps({"near_open": [1]}),
                ):
                    with self.subTest(bad_state=bad_state):
                        self.w.STATE.write_text(bad_state)
                        with self.w.State() as st:
                            counters = self.w.status_counters(st)
                            st.setdefault("events", []).append({"test": True})
                        self.assertEqual(counters, {"moves": None, "partial": None, "reaped": None, "moveFailures": None, "scanFailures": None, "skips": None})
                        self.assertEqual(self.w.DEFAULT_STATE["events"], [])
            finally:
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
            finally:
                self.restore_status_state(self.w, old)

    def test_correct_move_status_rescans_labels(self):
        with scratch() as tmp:
            base = Path(tmp)
            old = self.point_status_state(self.w, base)
            self.write_status_cgroup(self.w, scope="agent-warden-321-654.scope")
            before = self.P(321, 1, "claude", ["claude"], self.A, start=654)
            after = self.P(321, 1, "claude", ["claude"], self._cg("agent-warden-321-654.scope"), start=654)
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
            self.w.notify = lambda summary, body: None
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

    def test_launch_root_mutant_fails(self):
        text = WARDEN.read_text()
        old = '    if launch_root_alive(unit, members):\n        return False\n'
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, ""), "agent_warden_mutant_launch_root")
        mgr = 4000
        rooted = "/user.slice/user-1000.slice/user@1000.service/agents.slice/agent-warden-300-123.scope"
        recs = {
            mgr: mutant.Proc(mgr, ppid=1, comm="systemd", argv=["/usr/lib/systemd/systemd", "--user"], exe="/usr/lib/systemd/systemd", cgroup="/user.slice", start=1),
            300: mutant.Proc(300, ppid=mgr, comm="goose", argv=["goose"], exe=f"{mutant.HOME}/bin/goose", cgroup=rooted, start=123, marked=True),
            301: mutant.Proc(301, ppid=300, comm="rustc", argv=["rustc"], exe=f"{mutant.HOME}/.rustup/x/rustc", cgroup=rooted, start=1, marked=True),
        }
        units = {unit for unit, _ in mutant.orphans(recs, mutant.manager_pids(recs))}
        self.assertIn("agent-warden-300-123.scope", units)

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
            result = subprocess.run([str(launcher), "env"], env=env, capture_output=True, text=True)
            expected = str(Path(env["XDG_CACHE_HOME"]) / "agents" / "tmp")
            lines = log.read_text().splitlines() if log.exists() else []
        return result, expected, lines

    def test_agent_confine_nested_helper_statuses_launch(self):
        rows = [
            (1, 0),
            (3, 2),
        ]
        for status, systemd_runs in rows:
            with self.subTest(status=status):
                result, expected, lines = self.run_nested_launcher(status)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"TMPDIR={expected}", result.stdout.splitlines())
                self.assertEqual(len(lines), systemd_runs)
                if status == 3:
                    self.assertIn("--scope", lines[-1])
                    self.assertIn("-p CPUWeight=99", lines[-1])
                    self.assertIn("-p TasksMax=8192", lines[-1])
                    self.assertIn("-p MemoryHigh=64G", lines[-1])
                    self.assertRegex(lines[-1], r"--unit=agent-confine-[0-9]+-")

    def test_agent_confine_nested_status_three_mutant_fails(self):
        text = (ROOT / "warden" / "agent-confine").read_text()
        old = '3) : ;;'
        new = '3) exec env "${CAPS[@]}" "$@" ;;'
        self.assertEqual(text.count(old), 1)
        result, expected, lines = self.run_nested_launcher(3, text.replace(old, new))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"TMPDIR={expected}", result.stdout.splitlines())
        self.assertNotEqual(len(lines), 2)

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
