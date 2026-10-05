import ctypes
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

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


def default_tool_exe(module, comm):
    """A located executable for a fixture naming a real agent tool, so a
    plan/lineage row that stands a comm in for "some agent" need not know
    that tool's install layout; a row that tests install-location
    confirmation itself passes its own `exe`."""
    location = module.TOOL_LOCATIONS.get(comm)
    if location and location["mise"]:
        directory = location["mise"][0]
        return f"{module.MISE_DATA}/installs/{directory}/0.0.0/{comm}"
    return "/usr/bin/x"


def tracked_offenders(root, forbidden):
    """Paths under `root`/warden that git tracks and whose text holds
    `forbidden`. Only the tracked set ships, so build output git ignores,
    such as a `.pyc` embedding its absolute source path, is never read.
    A copy with no git metadata, such as a `git archive` extract, has no
    tracked set to read, so the scan skips there."""
    if not (Path(root) / ".git").exists():
        raise unittest.SkipTest(f"{root} has no git metadata: the portability scan cannot list the tracked set")
    listing = subprocess.run(["git", "-C", str(root), "ls-files", "-z", "--", "warden"],
                             env={"PATH": BASE_PATH}, capture_output=True, check=True).stdout
    paths = [name for name in listing.decode().split("\0") if name]
    if not paths:
        raise AssertionError(f"git ls-files listed no file under {root}/warden: the portability extractor is broken")
    return [name for name in paths if (Path(root) / name).is_file() and forbidden in (Path(root) / name).read_text(errors="ignore")]


class FakeSdBus:
    """libsystemd stand-in recording each (sv) property start_scope appends."""

    def __init__(self):
        self.properties = []

    def sd_bus_message_append(self, m, signature, *args):
        if signature == b"(sv)":
            self.properties.append((args[0].value, args[2].value))
        return 0

    def values(self, name):
        return [value for key, value in self.properties if key == name]

    def __getattr__(self, name):
        return lambda *args: 0


def started_scope(module):
    """The FakeSdBus a call to `module`'s Bus.start_scope appended its properties to."""
    bus = module.Bus.__new__(module.Bus)
    bus.lib, bus.bus = FakeSdBus(), ctypes.c_void_p()
    bus.start_scope("agent-warden-1-2.scope", [])
    return bus.lib


def materialize_warden_script(base, text=None):
    base = Path(base)
    path = base / "warden" / "agent-warden"
    path.parent.mkdir(parents=True, exist_ok=True)
    if text is None:
        shutil.copy2(WARDEN, path)
    else:
        path.write_text(text)
    path.chmod(0o755)
    data_dir = base / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "data" / "agent-tools.json", data_dir / "agent-tools.json")
    return path


class WardenMutantMixin:
    def load_mutant(self, text, name):
        with scratch() as tmp:
            base = Path(tmp)
            path = materialize_warden_script(base, text)
            env = clean_env({"HOME": base / "home", "XDG_RUNTIME_DIR": base / "run", "MISE_DATA_DIR": base / "mise"})
            for key in ("HOME", "XDG_RUNTIME_DIR", "MISE_DATA_DIR"):
                Path(env[key]).mkdir(parents=True, exist_ok=True)
            return load_warden(env, name, path)


class WardenStateMixin:
    """Points a loaded warden's state files and cgroup root at a sandbox."""

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


class WardenRulesCase(WardenMutantMixin, WardenStateMixin, unittest.TestCase):
    """One warden module loaded under a private home, shared by a suite's rows."""

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

    def _cg(self, unit):
        return f"/user.slice/user-{self.w.UID}.slice/user@{self.w.UID}.service/{self.w.SLICE}/{unit}"
