import contextlib
import io
import math
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest

from agent_warden_testlib import ROOT, WARDEN, clean_env, load_warden, materialize_warden_script, scratch, started_scope

# (variable, raw value, module attribute, expected value, fallback logged)
SETTING_ROWS = [
    ("AGENT_SCOPE_TASKS_MAX", "", "SCOPE_TASKS_MAX", 8192, False),
    ("AGENT_SCOPE_TASKS_MAX", "infinity", "SCOPE_TASKS_MAX", math.inf, False),
    ("AGENT_SCOPE_TASKS_MAX", "infinity", "SCOPE_TASKS_WARN", math.inf, False),
    ("AGENT_SCOPE_TASKS_MAX", "50%", "SCOPE_TASKS_MAX", 8192, True),
    ("AGENT_SCOPE_TASKS_MAX", "100", "SCOPE_TASKS_MAX", 100, False),
    ("AGENT_SCOPE_TASKS_WARN", "", "SCOPE_TASKS_WARN", 6144, False),
    ("AGENT_SCOPE_TASKS_WARN", "1.5", "SCOPE_TASKS_WARN", 6144, True),
    ("AGENT_SCOPE_MEM_HIGH_BYTES", "", "SCOPE_MEM_HIGH", 64 * 1024**3, False),
    ("AGENT_SCOPE_MEM_HIGH_BYTES", "1.5", "SCOPE_MEM_HIGH", 64 * 1024**3, True),
    ("AGENT_SCOPE_MEM_WARN_BYTES", "", "SCOPE_MEM_WARN", 48 * 1024**3, False),
    ("AGENT_SCOPE_MEM_WARN_BYTES", "1.5", "SCOPE_MEM_WARN", 48 * 1024**3, True),
    ("AGENT_WARDEN_ORPHAN_GRACE", "", "ORPHAN_GRACE", 300, False),
    ("AGENT_WARDEN_ORPHAN_GRACE", "0.5", "ORPHAN_GRACE", 0.5, False),
    ("AGENT_WARDEN_ORPHAN_GRACE", "inf", "ORPHAN_GRACE", 300, True),
    ("AGENT_WARDEN_ORPHAN_PROCS", "", "ORPHAN_PROC_MAX", 40, False),
    ("AGENT_WARDEN_ORPHAN_PROCS", "abc", "ORPHAN_PROC_MAX", 40, True),
    ("AGENT_WARDEN_ORPHAN_CPU", "", "ORPHAN_CPU_CORES", 0.5, False),
    ("AGENT_WARDEN_ORPHAN_CPU", "nan", "ORPHAN_CPU_CORES", 0.5, True),
    ("AGENT_WARDEN_ORPHAN_CPU", "1.5", "ORPHAN_CPU_CORES", 1.5, False),
    ("AGENT_WARDEN_SCRATCH_GRACE", "", "SCRATCH_GRACE", 60, False),
    ("AGENT_WARDEN_SCRATCH_GRACE", "0.5", "SCRATCH_GRACE", 0.5, False),
    ("AGENT_WARDEN_SCRATCH_GRACE", "inf", "SCRATCH_GRACE", 60, True),
    ("AGENT_WARDEN_INTERVAL", "", "STATUS_INTERVAL", 30, False),
    ("AGENT_WARDEN_INTERVAL", "0", "STATUS_INTERVAL", 30, True),
]
SD_BUS_INFINITY = 2**64 - 1


def load_with(settings, name, path=WARDEN):
    """The module imported under `settings`, and whether the import wrote to stderr."""
    with scratch() as tmp:
        base = Path(tmp)
        env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise", **settings})
        for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
            Path(env[key]).mkdir(parents=True, exist_ok=True)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            module = load_warden(env, name, path)
        return module, err.getvalue() != ""


def setting_reading(row, path=WARDEN):
    variable, raw, attribute, _, _ = row
    try:
        module, logged = load_with({variable: raw}, "agent_warden_setting_" + attribute.lower(), path)
    except Exception as e:  # noqa: BLE001
        return repr(e)
    return getattr(module, attribute), logged


def task_cap_run(raw, path=WARDEN):
    """enforce_task_caps' result and the systemctl calls it made for one scope at TasksMax `max`."""
    module, _ = load_with({"AGENT_SCOPE_TASKS_MAX": raw}, "agent_warden_task_caps", path)
    calls = []

    def run(argv, **_):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stderr="")

    module.scope_units = lambda: {"agent-confine-1-2.scope": "max"}
    module.slice_tasks_max = lambda: 16384
    module.subprocess = SimpleNamespace(run=run)
    module.log = lambda msg: None
    return module.enforce_task_caps(True), calls


def scope_tasks_max(raw, path=WARDEN):
    module, _ = load_with({"AGENT_SCOPE_TASKS_MAX": raw}, "agent_warden_start_scope", path)
    try:
        return started_scope(module).values(b"TasksMax")
    except Exception as e:  # noqa: BLE001
        return repr(e)


class AgentWardenSettingsRules(unittest.TestCase):
    def test_numeric_setting_rows(self):
        for row in SETTING_ROWS:
            variable, raw, attribute, expected, logged = row
            with self.subTest(variable=variable, raw=raw, attribute=attribute):
                self.assertEqual(setting_reading(row), (expected, logged))

    def test_task_cap_rows(self):
        rows = [
            ("infinity", [], []),
            ("100", ["agent-confine-1-2.scope"],
             [["systemctl", "--user", "set-property", "--runtime", "agent-confine-1-2.scope", "TasksMax=100"]]),
        ]
        for raw, capped, calls in rows:
            with self.subTest(raw=raw):
                self.assertEqual(task_cap_run(raw), (capped, calls))

    def test_start_scope_tasks_max_rows(self):
        for raw, expected in [("infinity", [SD_BUS_INFINITY]), ("100", [100])]:
            with self.subTest(raw=raw):
                self.assertEqual(scope_tasks_max(raw), expected)

    def test_lineage_helper_answers_rows(self):
        # The helper reads this process's real cgroup, so either answer is
        # right; exit 2 is the unknown a failed import produces.
        for raw in ("", "infinity", "50%"):
            with self.subTest(raw=raw), scratch() as tmp:
                base = Path(tmp)
                env = clean_env({"HOME": base, "XDG_RUNTIME_DIR": base, "XDG_CACHE_HOME": base,
                                 "MISE_DATA_DIR": base, "AGENT_SCOPE_TASKS_MAX": raw}, path=True)
                result = subprocess.run([sys.executable, str(ROOT / "warden" / "agent-confine-lineage-capped")],
                                        env=env, capture_output=True, text=True, timeout=60)
                self.assertIn(result.returncode, (0, 3), result.stderr)

    def test_settings_mutants_fail(self):
        def row(variable, raw, attribute):
            match = [r for r in SETTING_ROWS if r[:3] == (variable, raw, attribute)]
            self.assertEqual(len(match), 1)
            return lambda path: setting_reading(match[0], path) == match[0][3:]

        unlimited_caps = lambda path: task_cap_run("infinity", path) == ([], [])
        unlimited_scope = lambda path: scope_tasks_max("infinity", path) == [SD_BUS_INFINITY]
        mutants = [
            ("unparsable value raises", "    except ValueError:\n        print(f\"invalid {name}",
             "    except KeyError:\n        print(f\"invalid {name}", row("AGENT_WARDEN_ORPHAN_PROCS", "abc", "ORPHAN_PROC_MAX")),
            ("non-finite float accepted", "    if not math.isfinite(value):\n        raise ValueError(raw)",
             "    if False:\n        raise ValueError(raw)", row("AGENT_WARDEN_ORPHAN_CPU", "nan", "ORPHAN_CPU_CORES")),
            ("empty value is logged", "    if raw == \"\":\n        return default",
             "    if False:\n        return default", row("AGENT_SCOPE_TASKS_MAX", "", "SCOPE_TASKS_MAX")),
            ("infinity refused", "math.inf if raw == \"infinity\" else int(raw)", "int(raw)",
             row("AGENT_SCOPE_TASKS_MAX", "infinity", "SCOPE_TASKS_MAX")),
            ("unlimited scope warns below no cap",
             "math.inf if SCOPE_TASKS_MAX == math.inf else SCOPE_TASKS_MAX * 3 // 4", "SCOPE_TASKS_MAX * 3 // 4",
             row("AGENT_SCOPE_TASKS_MAX", "infinity", "SCOPE_TASKS_WARN")),
            ("non-positive interval accepted", "    if value <= 0:\n        raise ValueError(raw)",
             "    if False:\n        raise ValueError(raw)", row("AGENT_WARDEN_INTERVAL", "0", "STATUS_INTERVAL")),
            ("unlimited scope still capped", "    if SCOPE_TASKS_MAX == math.inf:\n        return capped",
             "    if False:\n        return capped", unlimited_caps),
            ("unlimited TasksMax sent as a float",
             "SD_BUS_INFINITY if SCOPE_TASKS_MAX == math.inf else SCOPE_TASKS_MAX", "SCOPE_TASKS_MAX", unlimited_scope),
        ]
        text = WARDEN.read_text()
        for name, old, new, holds in mutants:
            with self.subTest(mutant=name), scratch() as tmp:
                self.assertEqual(text.count(old), 1)
                path = materialize_warden_script(tmp, text.replace(old, new))
                self.assertFalse(holds(path))


if __name__ == "__main__":
    unittest.main()
