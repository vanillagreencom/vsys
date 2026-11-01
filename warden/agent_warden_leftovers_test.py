import math
import os
from pathlib import Path
import re
import sys
import time
import unittest
from unittest.mock import patch

from agent_warden_testlib import WARDEN, WardenRulesCase, scratch

sys.dont_write_bytecode = True

# Pids a row's fake /proc answers for; every other /proc read is real.
HOLDER, MATE = 4_000_001, 4_000_002
WORLD = "vgw-world.1"


def fake_proc(w, views):
    """Patches w's /proc reads so each pid in views reads as its dict says:
    environ and cmdline as raw text, cwd and exe as link targets, fds as a
    list of link targets, any of them an exception to raise, and a missing
    entry as unreadable. A view pid reads as running."""
    real_read, real_readlink, real_listdir = w.read, os.readlink, os.listdir

    def view_of(path):
        m = re.fullmatch(r"/proc/(\d+)/(.+)", str(path))
        return (views.get(int(m.group(1))), m.group(2)) if m else (None, None)

    def answer(value):
        if isinstance(value, Exception):
            raise value
        if value is None:
            raise PermissionError(13, "Permission denied")
        return value

    def read(path, default=None):
        view, rest = view_of(path)
        if view is None:
            return real_read(path, default)
        if rest == "stat":
            return "1 (x) S 1"
        return view.get(rest, default)

    def readlink(path, *args, **kwargs):
        view, rest = view_of(path)
        if view is None:
            return real_readlink(path, *args, **kwargs)
        if rest.startswith("fd/"):
            return answer(answer(view.get("fds", []))[int(rest[3:])])
        return answer(view.get(rest))

    def listdir(path):
        view, rest = view_of(path)
        if view is None:
            return real_listdir(path)
        return [str(i) for i in range(len(answer(view.get("fds", []))))]

    return (patch.object(w, "read", side_effect=read), patch.object(w.os, "readlink", side_effect=readlink),
            patch.object(w.os, "listdir", side_effect=listdir))


def readable(**fields):
    view = {"environ": "HOME=/nowhere\0", "cmdline": "test\0", "cwd": "/nowhere", "exe": "/usr/bin/test", "fds": []}
    view.update(fields)
    return view


class FakeUnitBus:
    """The Bus methods reset_failed_units calls, over units {name:
    (Transient, FragmentPath, StateChangeTimestampMonotonic) or an
    exception}. Each bus call takes step seconds of clock, or, like
    sd_bus_call(3), fails with a timeout once it has taken the timeout last
    set; one property is one call. The timeout starts unbounded, so a call
    no set_call_timeout preceded takes its whole step."""

    PROPERTIES = ("Transient", "FragmentPath", "StateChangeTimestampMonotonic")

    def __init__(self, units, clock, step=0.0):
        self.units, self.clock, self.step = units, clock, step
        self.reset, self.timeout = [], math.inf

    def _call(self):
        self.clock[0] += min(self.step, self.timeout)
        if self.step > self.timeout:
            raise OSError("org.freedesktop.DBus.Error.Timeout")

    def set_call_timeout(self, usec):
        if usec <= 0:
            raise AssertionError("a call was given no time")
        self.timeout = usec / 1e6

    def failed_units(self):
        self._call()
        return [(name, f"/unit/{name}") for name in self.units]

    def unit_property(self, path, member):
        self._call()
        value = self.units[path.rsplit("/", 1)[1]]
        if isinstance(value, Exception):
            raise value
        return value[self.PROPERTIES.index(member)]

    def reset_failed(self, name):
        self._call()
        self.reset.append(name)


class AgentWardenLeftoverRules(WardenRulesCase):
    # --- test worlds ---------------------------------------------------------
    def _world_rows(self):
        """(name, holder views, setup, expected): expected is "removed", "kept"
        (counted, not removed) or "skipped" (not a candidate). Views name the
        world as {world} and its pattern's symlinked parent as {link}."""
        lane = self._cg("agent-confine-300-400.scope")
        user = f"/user.slice/user-{self.w.UID}.slice/user@{self.w.UID}.service"
        return [
            ("old and unheld", {}, (), "removed"),
            ("younger than the age", {}, ("young",), "skipped"),
            ("report mode", {}, ("report",), "kept"),
            ("current directory inside it", {HOLDER: readable(cwd="{world}/sub")}, (), "kept"),
            ("TMPDIR names it", {HOLDER: readable(environ="TMPDIR={world}\0")}, (), "kept"),
            ("HOME and XDG_CONFIG_HOME name it", {HOLDER: readable(environ="HOME={world}/h\0XDG_CONFIG_HOME={world}/c\0")},
             (), "kept"),
            ("PATH lists it before a colon", {HOLDER: readable(environ="PATH=/usr/bin:{world}:/bin\0")}, (), "kept"),
            ("an option value inside it", {HOLDER: readable(cmdline="dbus-daemon\0--config-file={world}/d.conf\0")},
             (), "kept"),
            ("an argv path inside it", {HOLDER: readable(cmdline="vgshell-scan\0--watch-core\0{world}/a/shell\0")},
             (), "kept"),
            ("its executable inside it", {HOLDER: readable(exe="{world}/bin/wl-paste")}, (), "kept"),
            ("an open file inside it", {HOLDER: readable(fds=["socket:[1]", "{world}/sub/log"])}, (), "kept"),
            ("argv names it through the pattern's symlinked parent",
             {HOLDER: readable(cmdline="x\0{link}/" + WORLD + "/f\0")}, ("link-pattern",), "kept"),
            ("a longer sibling name", {HOLDER: readable(cwd="{world}0")}, (), "removed"),
            ("an fd closed between the listing and its read",
             {HOLDER: readable(fds=[FileNotFoundError(2, "gone")])}, (), "removed"),
            ("an fd link unreadable", {HOLDER: readable(fds=[PermissionError(13, "denied")], cgroup=lane)}, (), "kept"),
            ("the fd directory unreadable", {HOLDER: readable(fds=PermissionError(13, "denied"), cgroup=lane)}, (), "kept"),
            ("environment unreadable", {HOLDER: readable(environ=None, cgroup=lane)}, (), "kept"),
            ("executable unreadable", {HOLDER: readable(exe=None, cgroup=lane)}, (), "kept"),
            ("unreadable beside a readable member of its lane",
             {HOLDER: readable(environ=None, cgroup=lane), MATE: readable(cgroup=lane)}, (), "kept"),
            ("unreadable in a desktop unit",
             {HOLDER: readable(environ=None, cgroup=f"{user}/app.slice/ssh-agent.service")}, (), "removed"),
            ("unreadable under another uid", {HOLDER: readable(environ=None, cgroup=lane, uid=self.w.UID + 1)},
             (), "removed"),
            ("a symlink matching the pattern", {}, ("symlink",), "skipped"),
            ("owned by another uid", {}, ("foreign",), "skipped"),
            ("HOME itself", {}, ("home",), "skipped"),
            ("an ancestor of a scratch parent", {}, ("scratch-parent",), "skipped"),
            ("a mount point under it", {}, ("mount",), "kept"),
        ]

    def _world_pass(self, w, views, setup):
        """One reap over a world past the age; (count, removed, world still there)."""
        with scratch() as tmp:
            base = Path(tmp)
            parent = base / "tmp"
            world = parent / WORLD
            (world / "sub").mkdir(parents=True)
            (base / "link").symlink_to(parent)
            if "symlink" in setup:
                world.rename(base / "target")
                world.symlink_to(base / "target")
                os.utime(base / "target", (0, 0))
            os.utime(world, (time.time(),) * 2 if "young" in setup else (0, 0), follow_symlinks=False)
            pattern = f"{base / 'link' if 'link-pattern' in setup else parent}/vgw-world.*"
            procs, rendered = {}, {}
            for pid, view in views.items():
                rendered[pid] = {k: (v.format(world=world, link=base / "link") if isinstance(v, str)
                                     else [x.format(world=world) if isinstance(x, str) else x for x in v]
                                     if isinstance(v, list) else v)
                                 for k, v in view.items()}
                procs[pid] = w.Proc(pid, ppid=1, comm="test", argv=["test"], exe="/usr/bin/test",
                                    cgroup=view.get("cgroup", self.A), uid=view.get("uid"))
            patches = [patch.object(w, "TEST_WORLD_PATTERNS", (pattern,)), patch.object(w, "log"),
                       patch.object(w, "_mount_points", return_value={str(world / "sub")} if "mount" in setup else set()),
                       patch.object(w, "AGENT_TMPDIR_PARENT",
                                    str(world / "agents" / "tmp") if "scratch-parent" in setup else str(base / "scratch")),
                       patch.object(w, "AGENT_TMPDIR_DEFAULT", str(base / "scratch")),
                       patch.object(w, "HOME", str(world) if "home" in setup else str(base / "home")),
                       patch.object(w, "UID", w.UID + 1 if "foreign" in setup else w.UID), *fake_proc(w, rendered)]
            for p in patches:
                p.start()
            try:
                count, removed = w.reap_test_worlds("report" not in setup, procs, set())
            finally:
                for p in reversed(patches):
                    p.stop()
            return count, removed, os.path.lexists(world), os.path.realpath(world)

    def _expected(self, expected, real):
        return {"removed": (0, [real], False), "kept": (1, [], True), "skipped": (0, [], True)}[expected]

    def test_test_world_rows(self):
        for name, views, setup, expected in self._world_rows():
            with self.subTest(name=name):
                count, removed, present, real = self._world_pass(self.w, views, setup)
                self.assertEqual((count, removed, present), self._expected(expected, real))

    def test_test_world_guard_mutants_fail(self):
        text = WARDEN.read_text()
        rows = [
            ("argv", 'read(f"/proc/{pid}/cmdline")]', '""]', "an argv path inside it"),
            ("open files", "                texts.append(target)\n", "                pass\n", "an open file inside it"),
            ("environment", 'texts = [read(f"/proc/{pid}/environ"), ', 'texts = ["", ', "HOME and XDG_CONFIG_HOME name it"),
            ("unread process", "_unread_may_hold(proc):\n            unread.append(pid)\n",
             "_unread_may_hold(proc):\n            pass\n", "environment unreadable"),
            ("name boundary", "token[len(path)] not in NAME_CHARS", "True", "a longer sibling name"),
            ("owner", "st.st_uid == UID and now", "now", "owned by another uid"),
            ("symlink", "                st = os.lstat(path)\n            except OSError:\n                continue\n            if (stat",
             "                st = os.stat(path)\n            except OSError:\n                continue\n            if (stat",
             "a symlink matching the pattern"),
            ("mount point", 'if mounts is None or any(m == path or m.startswith(path + "/") for m in mounts):',
             "if mounts is None:", "a mount point under it"),
        ]
        cases = {name: (views, setup, expected) for name, views, setup, expected in self._world_rows()}
        for name, old, new, row in rows:
            with self.subTest(mutant=name):
                self.assertEqual(text.count(old), 1)
                mutant = self.load_mutant(text.replace(old, new), "agent_warden_mutant_world")
                views, setup, expected = cases[row]
                count, removed, present, real = self._world_pass(mutant, views, setup)
                self.assertNotEqual((count, removed, present), self._expected(expected, real))

    def test_test_worlds_cap_removals_per_pass(self):
        with scratch() as tmp:
            parent = Path(tmp)
            for index in range(self.w.TEST_WORLD_REMOVALS_PER_PASS + 2):
                (parent / f"vgw-world.{index}").mkdir()
                os.utime(parent / f"vgw-world.{index}", (0, 0))
            with patch.object(self.w, "TEST_WORLD_PATTERNS", (f"{parent}/vgw-world.*",)), patch.object(self.w, "log"):
                passes = [self.w.reap_test_worlds(True, {}, set()) for _ in range(2)]
        self.assertEqual([(count, len(removed)) for count, removed in passes],
                         [(2, self.w.TEST_WORLD_REMOVALS_PER_PASS), (0, 2)])

    def test_test_world_counts_without_a_readable_listing(self):
        with scratch() as tmp:
            rows = [
                ("no pattern", (), (None, [])),
                ("a parent that cannot be listed", (f"{tmp}/missing/vgw-world.*",), (None, [])),
                ("a listed parent with no match", (f"{tmp}/vgw-world.*",), (0, [])),
            ]
            for name, patterns, expected in rows:
                with self.subTest(name=name), patch.object(self.w, "TEST_WORLD_PATTERNS", patterns), \
                        patch.object(self.w, "log"):
                    self.assertEqual(self.w.reap_test_worlds(True, {}, set()), expected)

    # --- old test processes --------------------------------------------------
    def test_test_process_rows(self):
        with scratch() as tmp:
            base = Path(tmp)
            parent = base / "tmp"
            parent.mkdir()
            main = base / "dev" / "vgshell"
            for name in ("vgs-1", "vgs-2"):
                gitdir = main / ".git" / "worktrees" / name
                gitdir.mkdir(parents=True)
                (gitdir / "commondir").write_text("../..\n")
                (base / "dev" / "wt" / name / "src").mkdir(parents=True)
            (base / "dev" / "wt" / "vgs-1" / ".git").write_text(f"gitdir: {main}/.git/worktrees/vgs-1\n")
            (base / "dev" / "wt" / "vgs-2" / ".git").write_text("gitdir: ../../vgshell/.git/worktrees/vgs-2\n")
            world = f"{parent}/vgw-world.7"
            boot_now, hour = 100_000.0, 3600
            # (name, argv, tty, age in seconds, cwd, repo or "not counted")
            rows = [
                ("an argv path in a world, from a worktree", ["scan", f"{world}/core"], 0, 2 * hour,
                 f"{base}/dev/wt/vgs-1/src", "vgshell"),
                ("an option value in a world, from a relative gitdir", ["dbus", f"--config-file={world}/d.conf"], 0,
                 2 * hour, f"{base}/dev/wt/vgs-2", "vgshell"),
                ("from the main checkout", ["scan", world], 0, 2 * hour, str(main), "vgshell"),
                ("a world already removed, outside any repository", ["scan", f"{parent}/vgw-world.gone/x"], 0,
                 2 * hour, "/", None),
                ("current directory unreadable", ["scan", world], 0, 2 * hour, None, None),
                ("a terminal", ["scan", world], 34816, 2 * hour, str(main), "not counted"),
                ("younger than the age", ["scan", world], 0, 60, str(main), "not counted"),
                ("argv outside every world", ["scan", f"{parent}/other/x", "relative/vgw-world.7"], 0, 2 * hour,
                 str(main), "not counted"),
                ("argv at the pattern's parent", ["scan", str(parent)], 0, 2 * hour, str(main), "not counted"),
            ]
            procs, views = {}, {}
            for index, (name, argv, tty, age, cwd, _) in enumerate(rows):
                pid = HOLDER + index
                procs[pid] = self.w.Proc(pid, ppid=1, comm="scan", argv=argv, exe="/usr/bin/scan", cgroup=self.A,
                                         start=int((boot_now - age) * self.w.CLK_TCK), tty=tty)
                views[pid] = {"cwd": cwd}
            patches = (patch.object(self.w, "TEST_WORLD_PATTERNS", (f"{parent}/vgw-world.*",)), *fake_proc(self.w, views))
            for p in patches:
                p.start()
            try:
                for index, (name, *_, repo) in enumerate(rows):
                    with self.subTest(name=name):
                        pid = HOLDER + index
                        expected = [] if repo == "not counted" else [{"repo": repo, "processes": 1}]
                        self.assertEqual(self.w.report_test_processes({pid: procs[pid]}, boot_now), expected)
                with self.subTest(name="grouped by repository, the unknown last"):
                    self.assertEqual(self.w.report_test_processes(procs, boot_now),
                                     [{"repo": "vgshell", "processes": 3}, {"repo": None, "processes": 2}])
            finally:
                for p in reversed(patches):
                    p.stop()
        with patch.object(self.w, "TEST_WORLD_PATTERNS", ()):
            self.assertIsNone(self.w.report_test_processes(procs, boot_now))

    # --- failed transient units ----------------------------------------------
    def _unit_pass(self, w, units, correct=True, step=0.0):
        """reset_failed_units over units at a clock three hours on; (left, reset, seconds the pass took)."""
        start = 3 * 3600.0
        clock = [start]
        bus = FakeUnitBus(units, clock, step)
        with patch.object(w, "log"):
            left = w.reset_failed_units(correct, bus, clock=lambda: clock[0])
        return left, bus.reset, clock[0] - start

    def _unit_rows(self):
        old, young = 1_000_000, int(3 * 3600e6) - 1_000_000
        own = lambda name: str(self.w.TRANSIENT_DIR / name)  # noqa: E731
        # (name, properties, correct, left, reset)
        return [
            ("transient and failed past the age", (True, own("run-u1.service"), old), True, 0, ["run-u1.service"]),
            ("report mode", (True, own("run-u1.service"), old), False, 1, []),
            ("failed for less than the age", (True, own("run-u1.service"), young), True, 0, []),
            ("not transient", (False, own("run-u1.service"), old), True, 0, []),
            ("a fragment in the user unit directory", (True, "/home/u/.config/systemd/user/run-u1.service", old),
             True, 0, []),
            ("no fragment", (True, "", old), True, 0, []),
            ("another unit's transient fragment", (True, own("run-u2.service"), old), True, 0, []),
            ("no state change time", (True, own("run-u1.service"), 0), True, None, []),
            ("properties unreadable", OSError("org.freedesktop.DBus.Error.Timeout"), True, None, []),
        ]

    def test_failed_unit_rows(self):
        for name, properties, correct, left, reset in self._unit_rows():
            with self.subTest(name=name):
                self.assertEqual(self._unit_pass(self.w, {"run-u1.service": properties}, correct)[:2], (left, reset))

    def test_failed_unit_fragment_mutant_fails(self):
        text = WARDEN.read_text()
        old = "if not transient or fragment != str(TRANSIENT_DIR / name):"
        self.assertEqual(text.count(old), 1)
        mutant = self.load_mutant(text.replace(old, "if not transient:"), "agent_warden_mutant_unit_fragment")
        row = {name: properties for name, properties, *_ in self._unit_rows()}["a fragment in the user unit directory"]
        self.assertEqual(self._unit_pass(mutant, {"run-u1.service": row})[1], ["run-u1.service"])

    def test_failed_unit_pass_is_bounded(self):
        old = 1_000_000
        units = {f"run-u{i}.service": (True, str(self.w.TRANSIENT_DIR / f"run-u{i}.service"), old) for i in range(25)}
        cap = self.w.FAILED_UNIT_RESETS_PER_PASS
        left, reset, _ = self._unit_pass(self.w, units)
        self.assertEqual((left, len(reset)), (25 - cap, cap))
        # A three-second budget against a bus whose every call takes step
        # seconds: (name, step, left, reset). Whatever the step, the pass
        # stops unfinished within the budget, resetting only what fit.
        rows = [
            ("each call takes half a second", 0.5, None, ["run-u0.service"]),
            ("each call takes a second", 1.0, None, []),
            ("the property reads take the rest of the budget", 0.75, None, []),
            ("each call outlasts the time left", 2.0, None, []),
        ]
        with patch.object(self.w, "FAILED_UNIT_PASS_SECONDS", 3.0):
            for name, step, want_left, want_reset in rows:
                with self.subTest(name=name):
                    left, reset, seconds = self._unit_pass(self.w, units, step=step)
                    self.assertEqual((left, reset), (want_left, want_reset))
                    self.assertLessEqual(seconds, 3.0)
        failing = FakeUnitBus(dict(list(units.items())[:2]), [3 * 3600.0])
        failing.reset_failed = lambda name: (_ for _ in ()).throw(OSError("access denied"))
        with patch.object(self.w, "log"):
            self.assertEqual(self.w.reset_failed_units(True, failing, clock=lambda: 3 * 3600.0), 2)


if __name__ == "__main__":
    unittest.main()
