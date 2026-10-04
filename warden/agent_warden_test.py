import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from types import SimpleNamespace
import unittest

from agent_warden_testlib import BASE_PATH, ROOT, WARDEN, WardenMutantMixin, clean_env, default_tool_exe, load_warden, materialize_warden_script, scratch, tracked_offenders

sys.dont_write_bytecode = True


class AgentWardenRules(WardenMutantMixin, unittest.TestCase):
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

    def P(self, pid, ppid, comm, argv, cg=None, exe=None, start=1, marked=False, tty=0):
        if exe is None:
            exe = default_tool_exe(self.w, comm)
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
                "desktopExePrefixes": ["/zz/", "/tmp/.mount_"],
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
            ("desktop prefixes from data", module.DESKTOP_EXE_PREFIXES, ("/zz/", "/tmp/.mount_")),
            ("bundled suffixes from data", module.BUNDLED_CLI_SUFFIXES, ("/zz/cli",)),
            ("bundled CLI prefixes drop a /tmp desktop prefix, world-writable on every target",
             module.BUNDLED_CLI_PREFIXES, ("/zz/",)),
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

    def test_overlay_entry_naming_a_shipped_tool_extends_it(self):
        with scratch() as tmp:
            base = Path(tmp)
            script = base / "warden" / "agent-warden"
            script.parent.mkdir(parents=True)
            shutil.copy2(WARDEN, script)
            script.chmod(0o755)
            (base / "data").mkdir()
            (base / "data" / "agent-tools.json").write_text(json.dumps({
                "version": 1,
                "tools": [{"name": "xi-agent", "mise": ["xi-install"]}],
            }))
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            overlay = Path(env["HOME"]) / ".config" / "vsys" / "agent-tools.json"
            overlay.parent.mkdir(parents=True)
            overlay.write_text(json.dumps({
                "version": 1,
                "tools": [{"name": "xi-agent", "mise": ["xi-other"], "executables": ["/usr/bin/xi-agent"]}],
            }))
            module = load_warden(env, "agent_warden_overlay_extends", script)
        self.assertEqual(module.AGENT_COMMS, {"xi-agent"})
        self.assertEqual(module.MISE_AGENT_NAMES, {"xi-install": "xi-agent", "xi-other": "xi-agent"})

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
        old_mise = ["claude", "codex", "pi", "opencode", "gemini", "copilot", "crush", "cursor-agent", "npm-deepseek-ai-dsh", "npm-xai-official-grok", "aqua-google-antigravity-antigravity-cli", "github-can1357-oh-my-pi", "github-open-router-labs-ori-releases", "github-vercel-labs-fx", "http-muse"]
        self.assertEqual(module.AGENT_COMMS, old_names)
        self.assertEqual(module_no_overlay.AGENT_COMMS, shipped_names)
        for directory in old_mise:
            with self.subTest(directory=directory):
                self.assertTrue(module.AGENT_PATH_RE.search(f"{env['MISE_DATA_DIR']}/installs/{directory}/bin/tool"))
        self.assertFalse(module.AGENT_PATH_RE.search(f"{env['MISE_DATA_DIR']}/installs/unlisted/bin/tool"))

    def test_malformed_agent_tool_documents_are_refused(self):
        # The dashboard's parser reads the same table of rejected documents.
        shared = json.loads((ROOT / "data" / "agent-tools-rejected.json").read_text())["rows"]
        self.assertTrue(shared, "extractor broke: no rejected documents")
        rows = [(row["name"], row["document"], None, "agent-tools.json") for row in shared] + [
            ("unknown overlay key", {"version": 1, "tools": []}, {"version": 1, "tools": [], "extra": True}, ".config/vsys/agent-tools.json"),
            ("duplicate overlay mise dir", {"version": 1, "tools": [{"name": "claude", "mise": ["claude"]}]}, {"version": 1, "tools": [{"name": "other", "mise": ["claude"]}]}, ".config/vsys/agent-tools.json"),
            ("duplicate overlay path", {"version": 1, "tools": [{"name": "ok", "paths": ["/pkg/"]}]}, {"version": 1, "tools": [{"name": "ok", "paths": ["/pkg/"]}]}, ".config/vsys/agent-tools.json"),
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
            ("agent by comm, confirmed by its install location", self.P(1, 0, "claude", ["claude"], exe=f"{mise}/claude/2.1.0/claude").is_agent, True),
            ("a non-agent program sharing an agent's name is not an agent", self.P(12, 0, "pi", ["/usr/local/bin/pi"], exe="/usr/local/bin/pi").is_agent, False),
            ("a machine-local script sharing an agent's name is not an agent", self.P(13, 0, "codex", ["/usr/local/bin/codex"], exe="/usr/local/bin/codex").is_agent, False),
            ("hosted mise cli", self.P(2, 0, "node", [f"{mise}/pi/latest/pi/node", f"{mise}/pi/latest/pi/dist/cli.js"], exe="/usr/bin/node").is_agent, True),
            ("hosted mise label", self.w._tool_label(self.P(8, 0, "node", [f"{mise}/npm-xai-official-grok/latest/bin/grok"], exe="/usr/bin/node")), "grok"),
            ("build by comm", self.P(3, 0, "cargo", ["cargo", "test"]).is_build, True),
            ("desktop by executable", self.P(4, 0, "ChatGPT", ["/opt/codex-desktop/ChatGPT"], exe="/opt/codex-desktop/ChatGPT").is_desktop, True),
            ("excluded flag", self.P(5, 0, "claude", ["claude", "--chrome-native-host"]).excluded, True),
            ("rides along shell", self.P(6, 0, "bash", ["bash", "-c", "cargo test"]).rides_along, True),
            ("bundled CLI", self.P(7, 0, "codex", ["/opt/codex-desktop/resources/codex", "exec"], exe="/opt/codex-desktop/resources/codex").is_agent, True),
            ("bundled CLI replaced while running", self.P(9, 0, "codex", ["/opt/codex-desktop/resources/codex", "exec"], exe="/opt/codex-desktop/resources/codex (deleted)").is_agent, True),
            ("bundled helper rides along", self.P(10, 0, "node_repl", ["/opt/codex-desktop/resources/node_repl"], exe="/opt/codex-desktop/resources/node_repl").rides_along, True),
            ("bundled helper replaced while running", self.P(11, 0, "node_repl", ["/opt/codex-desktop/resources/node_repl"], exe="/opt/codex-desktop/resources/node_repl (deleted)").rides_along, True),
            ("agent confirmed by an exact configured executable path", self.P(14, 0, "opencode", ["opencode"], exe="/usr/bin/opencode").is_agent, True),
            ("an executable path containing but not equal to the configured one is not confirmed", self.P(15, 0, "opencode", ["opencode-fake"], exe="/usr/bin/opencode-fake").is_agent, False),
            ("a bundled CLI planted under the shipped /tmp/.mount_ prefix is not an agent: /tmp is world-writable on every target",
             self.P(16, 0, "codex", ["/tmp/.mount_zzzzzz/codex-desktop/resources/codex", "exec"],
                    exe="/tmp/.mount_zzzzzz/codex-desktop/resources/codex").is_agent, False),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

    def test_agent_name_confirmed_by_install_location(self):
        # D010, ported to the warden: a configured name is a candidate, and
        # install-location data it already parses and validates is what
        # confirms it, each as a path-prefix or exact match against the
        # process's own resolved executable. The tool's path fragments
        # (paths) are the dashboard's own, weaker, display-only signal; the
        # warden, which moves a confirmed match automatically, never reads
        # them, so a self-chosen writable path that merely contains one is
        # not proof of install location. A desktop prefix under /tmp is the
        # same kind of non-proof: /tmp is world-writable on every target, so
        # it never confirms a bundled CLI even where it is configured as a
        # desktop prefix. A generic name with no configured location stays
        # trusted, and an unreadable executable never hides an escaped
        # agent.
        with scratch() as tmp:
            base = Path(tmp)
            script = base / "warden" / "agent-warden"
            script.parent.mkdir(parents=True)
            shutil.copy2(WARDEN, script)
            script.chmod(0o755)
            (base / "data").mkdir()
            (base / "data" / "agent-tools.json").write_text(json.dumps({
                "version": 1,
                "tools": [
                    {"name": "pi", "mise": ["pi-install"], "paths": ["/node_modules/pi-coding-agent/"]},
                    {"name": "dsh", "mise": ["dsh-install"]},
                    {"name": "ownersonly"},
                ],
                "desktopExePrefixes": ["/opt/", "/tmp/.mount_", "/tmp"],
                "bundledCliSuffixes": ["/vendor/pi"],
            }))
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            module = load_warden(env, "agent_warden_install_location", script)

        def rec(comm, argv, exe):
            return module.Proc(1, ppid=0, comm=comm, argv=argv, exe=exe, cgroup=self.A, start=1)

        scratch_home = f"{env['HOME']}/scratch"
        rows = [
            ("planted pi outside every install location is not an agent",
             rec("pi", ["/usr/local/bin/pi"], "/usr/local/bin/pi").is_agent, False),
            ("planted dsh outside its mise install dir is not an agent",
             rec("dsh", ["/usr/bin/dsh"], "/usr/bin/dsh").is_agent, False),
            ("a same-uid process whose exe lives under a writable path that merely contains pi's package fragment is not an agent",
             rec("pi", [f"{scratch_home}/node_modules/pi-coding-agent/evil"], f"{scratch_home}/node_modules/pi-coding-agent/evil").is_agent, False),
            ("a same-uid process whose exe merely contains pi's mise install fragment outside the real mise root is not an agent",
             rec("pi", [f"{scratch_home}/fake-mise/installs/pi-install/1.0/pi"], f"{scratch_home}/fake-mise/installs/pi-install/1.0/pi").is_agent, False),
            ("pi under its mise install directory is an agent",
             rec("pi", ["x"], f"{module.MISE_DATA}/installs/pi-install/1.0/pi").is_agent, True),
            ("dsh under its mise install directory is an agent",
             rec("dsh", ["x"], f"{module.MISE_DATA}/installs/dsh-install/1.0/dsh").is_agent, True),
            ("pi as a bundled CLI engine under its desktop prefix is an agent",
             rec("pi", ["/opt/app/vendor/pi"], "/opt/app/vendor/pi").is_agent, True),
            ("pi's bundled CLI suffix outside any desktop prefix is not an agent",
             rec("pi", [f"{scratch_home}/vendor/pi"], f"{scratch_home}/vendor/pi").is_agent, False),
            ("pi as a bundled CLI engine under a /tmp desktop prefix is not an agent: /tmp is world-writable on every target",
             rec("pi", ["/tmp/.mount_zzzzzz/app/vendor/pi"], "/tmp/.mount_zzzzzz/app/vendor/pi").is_agent, False),
            ("pi as a bundled CLI engine under a bare /tmp desktop prefix (no trailing slash) is not an agent: the same forgeable root under another spelling",
             rec("pi", ["/tmp/app/vendor/pi"], "/tmp/app/vendor/pi").is_agent, False),
            ("an unreadable executable keeps the name",
             rec("pi", ["pi"], "").is_agent, True),
            ("a name with no configured install location is trusted",
             rec("ownersonly", ["ownersonly"], "/usr/bin/ownersonly").is_agent, True),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

    def test_agent_name_confirmation_mutant_fails(self):
        text = WARDEN.read_text()
        old = "        if self.comm in AGENT_COMMS:\n            return self._confirmed_by_location(self.comm)"
        self.assertEqual(text.count(old), 1)
        mutant = text.replace(old, "        if self.comm in AGENT_COMMS:\n            return True")
        module = self.load_mutant(mutant, "agent_warden_confirmation_mutant")
        p = module.Proc(1, ppid=0, comm="pi", argv=["/usr/local/bin/pi"], exe="/usr/local/bin/pi", cgroup=self.A, start=1)
        self.assertTrue(p.is_agent)

    def _install_gap_module(self, name, text=None):
        """Shipped data with an agent installed under the /opt desktop prefix,
        once as an exact executable and once under a mise root that itself
        lies in /opt, plus an overlay naming a tool by `paths` alone, as a
        machine's ~/.config/vsys/agent-tools.json can."""
        with scratch() as tmp:
            base = Path(tmp)
            script = materialize_warden_script(base, text)
            (base / "data" / "agent-tools.json").write_text(json.dumps({
                "version": 1,
                "tools": [
                    {"name": "pi", "mise": ["pi-install"]},
                    {"name": "optagent", "executables": ["/opt/optagent/bin/optagent"]},
                ],
                "desktopExePrefixes": ["/opt/"],
                "bundledCliSuffixes": ["/vendor/engine"],
            }))
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": "/opt/mise"})
            for key in ("HOME", "XDG_RUNTIME_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            overlay = Path(env["HOME"]) / ".config" / "vsys" / "agent-tools.json"
            overlay.parent.mkdir(parents=True)
            overlay.write_text(json.dumps({
                "version": 1,
                "tools": [{"name": "pkgonly", "paths": ["/node_modules/pkgonly/"]}],
            }))
            return load_warden(env, name, script)

    def _paths_only_rows(self, module):
        def rec(exe):
            return module.Proc(1, ppid=0, comm="pkgonly", argv=["pkgonly"], exe=exe, cgroup=self.A, start=1)

        planted = f"{module.HOME}/scratch/node_modules/pkgonly/cli"
        return [
            ("a paths-only tool's exe under a writable dir holding its fragment is not an agent", rec(planted).is_agent, False),
            ("a paths-only tool's exe outside every location is not an agent", rec("/usr/local/bin/pkgonly").is_agent, False),
            ("a paths-only tool as a bundled CLI engine under a desktop prefix is an agent", rec("/opt/app/vendor/engine").is_agent, True),
            ("a paths-only tool with an unreadable executable keeps the name", rec("").is_agent, True),
            ("a paths-only tool's exe under a desktop prefix is a desktop app", rec("/opt/pkgonly/lib/node_modules/pkgonly/cli").is_desktop, True),
            ("a paths-only tool still protects its scope through the comm-only match", rec(planted).is_named_agent, True),
        ]

    def test_paths_only_tool_needs_location_evidence(self):
        # D010: a tool whose only location is `paths` names a location the
        # warden never matches against, so its name alone does not confirm
        # it, unlike a name with no location at all.
        module = self._install_gap_module("agent_warden_paths_only")
        for name, actual, expected in self._paths_only_rows(module):
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

    def test_paths_only_tool_mutant_fails(self):
        text = WARDEN.read_text()
        old = ' or location["has_paths"]'
        self.assertEqual(text.count(old), 1)
        module = self._install_gap_module("agent_warden_mutant_paths_only", text.replace(old, ""))
        rows = {name: actual for name, actual, _ in self._paths_only_rows(module)}
        self.assertTrue(rows["a paths-only tool's exe under a writable dir holding its fragment is not an agent"])

    def _desktop_prefix_install_rows(self, module):
        def rec(pid, comm, exe):
            return module.Proc(pid, ppid=0, comm=comm, argv=[comm], exe=exe, cgroup=self.A, start=1)

        exact = rec(1, "optagent", "/opt/optagent/bin/optagent")
        mise = rec(2, "pi", "/opt/mise/installs/pi-install/1.0/pi")
        recs = {1: exact, 2: mise}
        moves, _, _, _ = module.plan(recs, capped=lambda cg: False, contained=lambda cg: False)
        moved = {pid for reason, tree in moves if reason == "unconfined agent" for pid in (p.pid for p in tree)}
        return [
            ("an exact configured executable under a desktop prefix is an agent", exact.is_agent, True),
            ("an exact configured executable under a desktop prefix is a named agent", exact.is_named_agent, True),
            ("an exact configured executable under a desktop prefix is moved", 1 in moved, True),
            ("a mise-anchored executable under a desktop prefix is an agent", mise.is_agent, True),
            ("a mise-anchored executable under a desktop prefix is a named agent", mise.is_named_agent, True),
            ("a mise-anchored executable under a desktop prefix is moved", 2 in moved, True),
            ("a desktop binary beside the configured executable stays desktop",
             rec(3, "optagent", "/opt/optagent/bin/optagent-ui").is_desktop, True),
            ("a desktop binary in an unlisted mise directory stays desktop",
             rec(4, "pi", "/opt/mise/installs/other/1.0/pi").is_desktop, True),
        ]

    def test_desktop_prefix_keeps_a_confirmed_install(self):
        # A confirmed executables or mise match under a desktop prefix is the
        # agent's install, not the desktop app, as a bundled CLI engine is.
        module = self._install_gap_module("agent_warden_desktop_prefix_install")
        for name, actual, expected in self._desktop_prefix_install_rows(module):
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

    def test_desktop_prefix_install_mutants_fail(self):
        text = WARDEN.read_text()
        cases = [
            ("executables", "\n                        or self.exe in AGENT_EXECUTABLES or bool(AGENT_PATH_RE.search(self.exe)))",
             "\n                        or bool(AGENT_PATH_RE.search(self.exe)))",
             "an exact configured executable under a desktop prefix is an agent"),
            ("mise", "\n                        or self.exe in AGENT_EXECUTABLES or bool(AGENT_PATH_RE.search(self.exe)))",
             "\n                        or self.exe in AGENT_EXECUTABLES)",
             "a mise-anchored executable under a desktop prefix is an agent"),
        ]
        for name, old, new, row in cases:
            with self.subTest(name=name):
                self.assertEqual(text.count(old), 1)
                module = self._install_gap_module(f"agent_warden_mutant_desktop_{name}", text.replace(old, new))
                rows = {label: actual for label, actual, _ in self._desktop_prefix_install_rows(module)}
                self.assertFalse(rows[row])

    def _escaped_unconfirmed_rows(self, module):
        native_install = f"{module.HOME}/.local/share/claude/versions/2.1.0/claude"
        job = "/user.slice/user-1000.slice/user@1000.service/app.slice/orch-x.service"
        recs = {
            1: module.Proc(1, ppid=0, comm="tmux: server", argv=["tmux"], exe="/usr/bin/tmux", cgroup=self.A, start=1),
            70: module.Proc(70, ppid=1, comm="claude", argv=["claude"], exe=native_install, cgroup=self.A, start=2, marked=True),
            71: module.Proc(71, ppid=1, comm="claude", argv=["claude"], exe=native_install, cgroup=self.A, start=3),
            80: module.Proc(80, ppid=1, comm="ChatGPT", argv=["ChatGPT"], exe="/opt/codex-desktop/ChatGPT", cgroup=self.A, start=4, marked=True),
            81: module.Proc(81, ppid=80, comm="claude", argv=["claude"], exe=native_install, cgroup=self.A, start=5, marked=True),
            90: module.Proc(90, ppid=1, comm="claude", argv=["claude"], exe=native_install, cgroup=job, start=6, marked=True),
        }
        moves, _, _, units = module.plan(recs, capped=lambda cg: False, contained=lambda cg: cg == job)
        escaped = [sorted(p.pid for p in tree) for reason, tree in moves if reason == "escaped launch"]
        moved = {p.pid for _, tree in moves for p in tree}
        return [
            ("a native install the warden cannot confirm is not an agent", recs[70].is_agent, False),
            ("a marked launch of it outside the slice is moved as an escaped launch", [70] in escaped, True),
            ("an unmarked twin is not moved", 71 in moved, False),
            ("a marked launch of it under a desktop app stays", 81 in moved, False),
            ("a marked desktop app itself stays", 80 in moved, False),
            ("a marked launch of it in a contained unit is listed as that unit's", [p.pid for p in units], [90]),
        ]

    def test_escaped_launch_moves_an_unconfirmed_name(self):
        # D010's escaped-launch rule.
        for name, actual, expected in self._escaped_unconfirmed_rows(self.w):
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

    def test_escaped_launch_unconfirmed_name_mutant_fails(self):
        text = WARDEN.read_text()
        old = "               and (p.is_agent or not desktop_owned(p))]"
        self.assertEqual(text.count(old), 1)
        module = self.load_mutant(text.replace(old, "               and p.is_agent]"), "agent_warden_mutant_escaped_unconfirmed")
        rows = {name: actual for name, actual, _ in self._escaped_unconfirmed_rows(module)}
        self.assertFalse(rows["a marked launch of it outside the slice is moved as an escaped launch"])

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
                    self.assertEqual(self.w.reap_scratch_dirs(False, {}), [])
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
                removed = self.w.reap_scratch_dirs(True, {})
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

    def test_reap_scratch_dirs_rmtree_failure_rows(self):
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
                fails = scratch_dir / "agent-confine-500-600"
                fails.mkdir()
                also_gone = scratch_dir / "agent-confine-700-800"
                also_gone.mkdir()
                old = time.time() - self.w.SCRATCH_GRACE - 1
                os.utime(fails, (old, old))
                os.utime(also_gone, (old, old))
                logs = []
                old_log, old_rmtree = self.w.log, self.w.shutil.rmtree
                self.w.log = logs.append

                def flaky_rmtree(path, *a, **kw):
                    if str(path) == str(fails):
                        raise OSError("boom")
                    return old_rmtree(path, *a, **kw)

                self.w.shutil.rmtree = flaky_rmtree
                try:
                    removed = self.w.reap_scratch_dirs(True, {})
                finally:
                    self.w.log, self.w.shutil.rmtree = old_log, old_rmtree
                rows = [
                    ("the failing directory survives", fails.is_dir(), True),
                    ("the failure is logged", any("agent-confine-500-600" in line and "failed" in line for line in logs), True),
                    ("the other gone scope is still removed despite the failure", also_gone.exists(), False),
                    ("removed reports only the one that succeeded", removed, ["agent-confine-700-800"]),
                ]
                for name, actual, expected in rows:
                    with self.subTest(name=name):
                        self.assertEqual(actual, expected)
            finally:
                self.w.CG_ROOT, self.w.AGENT_TMPDIR_PARENT = old_cg, old_parent

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
                mutant.reap_scratch_dirs(True, {})
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
                removed = self.w.reap_scratch_dirs(True, {})
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
                mutant.reap_scratch_dirs(True, {})
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
                    removed = self.w.reap_scratch_dirs(True, {})
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
                mutant.reap_scratch_dirs(True, {})
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
        # unreadable rows prove a desktop's non-dumpable processes never
        # pin a gone scope's directory, an agent shell that handed it down
        # holds it ("in-use" beats "unknown"), and an unreadable process
        # left alone in a scope move() created keeps it this tick.
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
             [manager, (701, 700, "ssh-agent", app, None)], [], "free"),
            ("an unreadable child of an agent shell whose TMPDIR names it",
             [(556, 555, "op", nested, None), (555, 1, "bash", nested, "TMPDIR={moved}")], [], "in-use"),
            ("an orphaned unreadable daemon in another live agents.slice scope",
             [manager, (800, 700, "op", other, None)], ["agent-confine-300-400.scope"], "free"),
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
                            removed = self.w.reap_scratch_dirs(True, procs)
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
                    mutant.reap_scratch_dirs(True, {555: None})
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
                    removed = self.w.reap_scratch_dirs(True, {555: None})
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
        self.assertEqual(text.count("reap_scratch_dirs(correct, scan())\n"), 1)
        self.assertEqual(text.count("reap_scratch_dirs(correct, procs)\n"), 0)

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

                    removed = self.w.reap_scratch_dirs(True, stale)
                    self.assertEqual(removed, ["agent-confine-100-200"])
                    self.assertFalse(moved.is_dir())

                    moved.mkdir()
                    os.utime(moved, (old_mtime, old_mtime))
                    removed = self.w.reap_scratch_dirs(True, fresh)
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

    def test_orphan_protection_uses_comm_only_name_match(self):
        # D010's location check gates only the automatic move into
        # agents.slice (is_agent). claude's and codex's native, non-mise
        # installs are described only through `paths` in data/agent-tools.json
        # (no `executables` entry for either), so a process on such an
        # install never satisfies D010 and is_agent reads it as unconfirmed.
        # Orphan reap must still treat it as a live agent: _is_orphan and
        # scope_still_orphan read is_named_agent, the wider comm-only match,
        # not is_agent.
        mgr = 4000
        native_install = f"{self.w.HOME}/.local/share/claude/versions/2.1.0/claude"
        headless = "/user.slice/user-1000.slice/user@1000.service/agents.slice/agent-confine-headless.scope"
        recs = {
            mgr: self.P(mgr, 1, "systemd", ["/usr/lib/systemd/systemd", "--user"], "/user.slice"),
            # a headless worker: its launch shell has already exited, so it is
            # reparented to the user manager, with no controlling terminal.
            700: self.P(700, mgr, "claude", ["claude", "-p", "work"], headless, exe=native_install),
        }
        self.assertFalse(recs[700].is_agent, "a paths-only native install must stay unconfirmed by is_agent")
        self.assertTrue(recs[700].is_named_agent, "the comm-only match must still see a live agent")
        units = {unit for unit, _ in self.w.orphans(recs, self.w.manager_pids(recs))}
        self.assertNotIn("agent-confine-headless.scope", units)

    def test_orphan_protection_name_match_mutant_fails(self):
        text = WARDEN.read_text()
        old = "    if any(p.is_named_agent for p in members):"
        self.assertEqual(text.count(old), 1)
        mutant = text.replace(old, "    if any(p.is_agent for p in members):")
        module = self.load_mutant(mutant, "agent_warden_orphan_name_match_mutant")
        mgr = 4000
        native_install = f"{module.HOME}/.local/share/claude/versions/2.1.0/claude"
        headless = "/user.slice/user-1000.slice/user@1000.service/agents.slice/agent-confine-headless.scope"
        recs = {
            mgr: module.Proc(mgr, ppid=1, comm="systemd", argv=["/usr/lib/systemd/systemd", "--user"],
                              exe="/usr/lib/systemd/systemd", cgroup="/user.slice", start=1),
            700: module.Proc(700, ppid=mgr, comm="claude", argv=["claude", "-p", "work"],
                              exe=native_install, cgroup=headless, start=1),
        }
        units = {unit for unit, _ in module.orphans(recs, module.manager_pids(recs))}
        self.assertIn("agent-confine-headless.scope", units)

    def test_named_agent_classification_rows(self):
        # is_named_agent has the same three branches as is_agent but only
        # branch 2 (comm in AGENT_COMMS) had any coverage of its own: these
        # rows exercise branch 1 (the excluded/is_desktop guard) and branch 3
        # (the HOST_COMMS + AGENT_PATH_RE match) directly against
        # is_named_agent, not against is_agent's own, differently-gated copy.
        mise = f"{self.w.MISE_DATA}/installs"
        rows = [
            ("an excluded process that would otherwise match AGENT_COMMS is not a named agent",
             self.P(60, 0, "claude", ["claude", "--chrome-native-host"]).is_named_agent, False),
            ("a desktop process that would otherwise match AGENT_COMMS is not a named agent",
             self.P(61, 0, "codex", ["/opt/other-desktop/resources/weird-binary"],
                    exe="/opt/other-desktop/resources/weird-binary").is_named_agent, False),
            ("a HOST_COMMS process with an agent path in argv[:2] is a named agent",
             self.P(62, 0, "node", [f"{mise}/pi/latest/pi/node", f"{mise}/pi/latest/pi/dist/cli.js"],
                    exe="/usr/bin/node").is_named_agent, True),
            ("a HOST_COMMS process with no agent path in argv is not a named agent",
             self.P(63, 0, "node", ["/usr/bin/node", "/opt/not-an-agent/app.js"],
                    exe="/usr/bin/node").is_named_agent, False),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

    def test_named_agent_guard_mutant_fails(self):
        text = WARDEN.read_text()
        old = ('keeps gating only the automatic move into agents.slice."""\n'
               '        if self.excluded or self.is_desktop:\n'
               '            return False\n'
               '        if self.comm in AGENT_COMMS:\n'
               '            return True\n'
               '        return self.comm in HOST_COMMS and any(AGENT_PATH_RE.search(a) for a in self.argv[:2])')
        self.assertEqual(text.count(old), 1)
        mutant = text.replace(old, old.replace(
            '        if self.excluded or self.is_desktop:\n'
            '            return False\n'
            '        if self.comm in AGENT_COMMS:',
            '        if self.comm in AGENT_COMMS:',
        ))
        module = self.load_mutant(mutant, "agent_warden_mutant_named_agent_guard")
        p = module.Proc(60, ppid=0, comm="claude", argv=["claude", "--chrome-native-host"],
                         exe=default_tool_exe(module, "claude"), cgroup=self.A, start=1)
        self.assertTrue(p.excluded)
        self.assertTrue(p.is_named_agent)

    def test_named_agent_path_match_mutant_fails(self):
        text = WARDEN.read_text()
        old = ('keeps gating only the automatic move into agents.slice."""\n'
               '        if self.excluded or self.is_desktop:\n'
               '            return False\n'
               '        if self.comm in AGENT_COMMS:\n'
               '            return True\n'
               '        return self.comm in HOST_COMMS and any(AGENT_PATH_RE.search(a) for a in self.argv[:2])')
        self.assertEqual(text.count(old), 1)
        mutant = text.replace(old, old.replace(
            '        return self.comm in HOST_COMMS and any(AGENT_PATH_RE.search(a) for a in self.argv[:2])',
            '        return False',
        ))
        module = self.load_mutant(mutant, "agent_warden_mutant_named_agent_path")
        mise = f"{module.MISE_DATA}/installs"
        p = module.Proc(62, ppid=0, comm="node",
                         argv=[f"{mise}/pi/latest/pi/node", f"{mise}/pi/latest/pi/dist/cli.js"],
                         exe="/usr/bin/node", cgroup=self.A, start=1)
        self.assertFalse(p.is_named_agent)

    def test_reap_orphans_returns_status_rows_and_reaped_event(self):
        with scratch() as tmp:
            base = Path(tmp)
            old_root, old_reap, old_still = self.w.CG_ROOT, self.w.reap, self.w.scope_still_orphan
            self.w.CG_ROOT = base / "cg"
            try:
                mgr = 4000
                reaped_unit = "agent-confine-reap.scope"
                quiet_unit = "agent-confine-watch.scope"
                reaped_cg = self._cg(reaped_unit)
                quiet_cg = self._cg(quiet_unit)
                recs = {mgr: self.P(mgr, 1, "systemd", ["/usr/lib/systemd/systemd", "--user"], "/user.slice")}
                for i in range(self.w.ORPHAN_PROC_MAX):
                    recs[5000 + i] = self.P(5000 + i, mgr, "bun", ["bun"], reaped_cg, exe="/usr/bin/bun")
                recs[6000] = self.P(6000, mgr, "bun", ["bun"], quiet_cg, exe="/usr/bin/bun")
                for unit in (reaped_unit, quiet_unit):
                    d = self.w.CG_ROOT / self.w.SLICE / unit
                    d.mkdir(parents=True, exist_ok=True)
                    (d / "cpu.stat").write_text("")
                now = self.w.time.time()
                st = {
                    "reaped": 0,
                    "move_failures": 0,
                    "event_seq": 0,
                    "events": [],
                    "orphans": {
                        reaped_unit: {"first": now - self.w.ORPHAN_GRACE - 10, "usage": None, "usage_ts": now - 1, "harmful": True},
                    },
                }
                self.w.reap = lambda unit: (True, "")
                self.w.scope_still_orphan = lambda unit, managers: unit == reaped_unit
                reaped, rows = self.w.reap_orphans(recs, st, True)
            finally:
                self.w.CG_ROOT, self.w.reap, self.w.scope_still_orphan = old_root, old_reap, old_still
        self.assertEqual(len(reaped), 1)
        self.assertIn(reaped_unit, reaped[0])
        self.assertEqual([row["scope"] for row in rows], [quiet_unit])
        self.assertIsNone(rows[0]["cores"])
        self.assertNotIn(reaped_unit, st["orphans"])
        events = [event for event in st["events"] if event["kind"] == "reaped"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["scope"], reaped_unit)
        self.assertEqual(events[0]["processes"], self.w.ORPHAN_PROC_MAX)

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
            subprocess.run(["git", "init", "-q", str(repo)], env=env, capture_output=True, check=True)
            files = {
                "warden/agent-warden": f"src = '{forbidden}/x'\n",
                "warden/clean": "nothing here\n",
                "warden/__pycache__/agent_warden_testlib.cpython-314.pyc": f"\x00{forbidden}/dev/vsys/warden\x00",
                "warden/untracked-note": f"{forbidden}\n",
            }
            for name, text in files.items():
                (repo / name).parent.mkdir(parents=True, exist_ok=True)
                (repo / name).write_text(text)
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
