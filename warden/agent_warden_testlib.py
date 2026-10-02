import importlib.machinery
import importlib.util
import os
from pathlib import Path
import shutil
import tempfile

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
