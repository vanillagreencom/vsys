#!/usr/bin/env python3
"""Run the warden checks and the application checks from the repository root."""

import json
import os
from pathlib import Path
import subprocess
import sys


ARTIFACTS = (
    "dist/main.js",
    "dist/collect/process-worker.js",
    "dist/collect/scratch-worker.js",
)
# The scratch scan's processor bound lives in a timer and a worker thread, so
# no unit test can see it: a staged clock records what the pace asks for and
# returns at once. bench:scratch is the one instrument that measures the rest
# taken, and it is in this list so the contract fails when the bound is gone.
# smoke takes one sample with the bundle build just wrote and one with a
# standalone binary it compiles, each starting both worker threads. A build
# that drops a worker passes every check before it and fails only when a
# sample starts that thread, and the binary embeds its workers at paths
# neither the source tree nor the bundle shows. bench:writes holds a sample's
# history writes to their budget: timed inside the test suite, a write
# measures whatever the other suites are doing to the disk.
CHECKS = ("lint", "typecheck", "test", "build", "smoke", "bench:scratch", "bench:writes")


def run_warden_checks() -> None:
    warden = Path("warden")
    if not warden.exists():
        return
    script = warden / "agent-warden"
    if not script.is_file():
        raise ValueError("warden/ exists without warden/agent-warden")
    tests = warden / "agent_warden_test.py"
    if not tests.is_file():
        raise ValueError("warden/ exists without warden/agent_warden_test.py")
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    subprocess.run([sys.executable, str(script), "--selftest"], check=True, env=env)
    subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "warden", "-p", "*_test.py"], check=True, env=env)


def run_packaging_checks() -> None:
    if not Path("packaging").exists():
        return
    subprocess.run([sys.executable, "scripts/package_file_list_check.py"], check=True)


def main() -> int:
    """Allow a planning-only tree, or require the complete check contract."""
    run_warden_checks()
    run_packaging_checks()
    manifest = Path("package.json")
    if not manifest.exists():
        if Path("src").exists() or Path("bun.lock").exists():
            raise ValueError("Application files exist without package.json")
        print("::notice::Planning stage: no package.json or src; application checks are not available.")
        return 0

    package = json.loads(manifest.read_text())
    scripts = package.get("scripts", {})
    for check in CHECKS:
        command = scripts.get(check)
        if not isinstance(command, str) or not command.strip():
            raise ValueError(f"package.json must define a nonempty {check} script")
    if not Path("bun.lock").is_file():
        raise ValueError("Commit bun.lock before running application checks")

    subprocess.run(["bun", "install", "--frozen-lockfile"], check=True)
    # Each worker thread is an entry point of its own, because the bundler
    # does not follow a worker URL. Last run's files are removed first, so
    # only this build can satisfy the requirement.
    for name in ARTIFACTS:
        Path(name).unlink(missing_ok=True)
    for check in CHECKS:
        subprocess.run(["bun", "run", check], check=True)
    for name in ARTIFACTS:
        artifact = Path(name)
        if not artifact.is_file() or artifact.stat().st_size == 0:
            raise ValueError(f"The build emitted no {name}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, TypeError, AttributeError, subprocess.CalledProcessError) as error:
        print(f"::error::Application checks failed: {error}", file=sys.stderr)
        sys.exit(1)
