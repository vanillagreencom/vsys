import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

from agent_warden_testlib import ROOT, WARDEN, WardenRulesCase, clean_env, default_tool_exe, load_warden, materialize_warden_script, scratch

sys.dont_write_bytecode = True


class AgentWardenClassifyRules(WardenRulesCase):
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


if __name__ == "__main__":
    unittest.main()
