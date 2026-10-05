from pathlib import Path
import sys
import unittest

from agent_warden_testlib import WARDEN, WardenRulesCase, scratch

sys.dont_write_bytecode = True


class AgentWardenOrphanRules(WardenRulesCase):
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
            ("process count harm", self.w.scope_harm(5140, 0.0, None), True),
            ("cpu harm", self.w.scope_harm(1, 0.8, None), True),
            ("quiet orphan not harmful", self.w.scope_harm(6, 0.0, None), False),
        ]
        for name, actual, expected in rows:
            with self.subTest(name=name):
                self.assertEqual(actual, expected)

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

    def _memory_ticks(self, module, scopes):
        """Runs two reap ticks over idle fixture scopes past grace. Each scope
        is (unit, processes, memory.stat text or None). Returns the first
        tick's status rows by scope and the units stopped on the second."""
        stopped = []
        with scratch() as tmp:
            old_root, old_reap, old_still = module.CG_ROOT, module.reap, module.scope_still_orphan
            module.CG_ROOT = Path(tmp) / "cg"
            try:
                mgr = 4000
                recs = {mgr: module.Proc(mgr, ppid=1, comm="systemd", argv=["/usr/lib/systemd/systemd", "--user"],
                                         exe="/usr/lib/systemd/systemd", cgroup="/user.slice", start=1)}
                now = module.time.time()
                st = {"reaped": 0, "move_failures": 0, "event_seq": 0, "events": [], "orphans": {}}
                for i, (unit, processes, stat) in enumerate(scopes):
                    cg = f"/user.slice/user-{module.UID}.slice/user@{module.UID}.service/{module.SLICE}/{unit}"
                    for j in range(processes):
                        pid = 10000 + i * 100 + j
                        recs[pid] = module.Proc(pid, ppid=mgr, comm="bun", argv=["bun"], exe="/usr/bin/bun", cgroup=cg, start=1)
                    d = module.CG_ROOT / module.SLICE / unit
                    d.mkdir(parents=True)
                    (d / "cpu.stat").write_text("usage_usec 1000\n")
                    # memory.current counts page cache; the harm test must not read it.
                    (d / "memory.current").write_text(f"{8 * module.ORPHAN_MEM_BYTES}\n")
                    if stat is not None:
                        (d / "memory.stat").write_text(stat)
                    st["orphans"][unit] = {"first": now - module.ORPHAN_GRACE - 10, "usage": 1000, "usage_ts": now - 30, "harmful": False}
                module.reap = lambda unit: (stopped.append(unit), (True, ""))[1]
                module.scope_still_orphan = lambda unit, managers: True
                _, first_rows = module.reap_orphans(recs, st, True)
                self.assertEqual(stopped, [], "nothing is stopped on the first harmful tick")
                module.reap_orphans(recs, st, True)
            finally:
                module.CG_ROOT, module.reap, module.scope_still_orphan = old_root, old_reap, old_still
        return {row["scope"]: row for row in first_rows}, stopped

    def test_memory_harm_rows(self):
        mem = self.w.ORPHAN_MEM_BYTES
        many = self.w.ORPHAN_PROC_MAX
        rows = [
            # name, processes, memory.stat, harmful and stopped, status memory
            ("idle at threshold", 20, f"anon {mem}\nfile 0\n", True, mem),
            ("idle below threshold", 20, f"anon {mem - 1}\nfile 0\n", False, mem - 1),
            ("page cache over threshold", 3, f"anon {mem // 8}\nfile {4 * mem}\n", False, mem // 8),
            ("memory unread", 3, None, False, None),
            ("memory.stat without anon", 3, f"file {4 * mem}\n", False, None),
            ("memory unread, many processes", many, None, True, None),
        ]
        scopes = [(f"agent-confine-mem-{i}.scope", n, stat) for i, (_, n, stat, _, _) in enumerate(rows)]
        first, stopped = self._memory_ticks(self.w, scopes)
        for (unit, _, _), (name, _, _, harmful, memory) in zip(scopes, rows):
            with self.subTest(name=name):
                row = first.get(unit)
                self.assertIsNotNone(row)
                self.assertEqual((row["harmful"], row["memory"]), (harmful, memory))
                self.assertEqual(unit in stopped, harmful)

    def test_memory_axis_mutant_fails(self):
        text = WARDEN.read_text()
        old = "\n            or (memory is not None and memory >= ORPHAN_MEM_BYTES))"
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, ")"), "agent_warden_mutant_memory_axis")
        unit = "agent-confine-mem.scope"
        first, stopped = self._memory_ticks(mutant, [(unit, 20, f"anon {mutant.ORPHAN_MEM_BYTES}\n")])
        self.assertIn(unit, first)
        self.assertFalse(first[unit]["harmful"])
        self.assertEqual(stopped, [])

    def test_failed_reap_is_not_a_move_failure(self):
        with scratch() as tmp:
            old_root, old_reap, old_still = self.w.CG_ROOT, self.w.reap, self.w.scope_still_orphan
            self.w.CG_ROOT = Path(tmp) / "cg"
            try:
                mgr = 4000
                unit = "agent-confine-stuck.scope"
                cg = self._cg(unit)
                recs = {mgr: self.P(mgr, 1, "systemd", ["/usr/lib/systemd/systemd", "--user"], "/user.slice")}
                for i in range(self.w.ORPHAN_PROC_MAX):
                    recs[5000 + i] = self.P(5000 + i, mgr, "bun", ["bun"], cg, exe="/usr/bin/bun")
                d = self.w.CG_ROOT / self.w.SLICE / unit
                d.mkdir(parents=True)
                (d / "cpu.stat").write_text("")
                now = self.w.time.time()
                st = {
                    "reaped": 0,
                    "move_failures": 0,
                    "event_seq": 0,
                    "events": [],
                    "orphans": {unit: {"first": now - self.w.ORPHAN_GRACE - 10, "usage": None, "usage_ts": now - 1, "harmful": True}},
                }
                self.w.reap = lambda unit: (False, "stop refused")
                self.w.scope_still_orphan = lambda unit, managers: True
                reaped, rows = self.w.reap_orphans(recs, st, True)
            finally:
                self.w.CG_ROOT, self.w.reap, self.w.scope_still_orphan = old_root, old_reap, old_still
        checks = [
            ("nothing reaped", reaped, []),
            ("move failures unchanged", st["move_failures"], 0),
            ("reaped unchanged", st["reaped"], 0),
            ("no event", st["events"], []),
            ("scope still listed", [row["scope"] for row in rows], [unit]),
            ("scope still tracked", unit in st["orphans"], True),
        ]
        for name, actual, expected in checks:
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


if __name__ == "__main__":
    unittest.main()
