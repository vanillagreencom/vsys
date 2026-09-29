#!/usr/bin/env python3
"""Run the warden checks and the application checks from the repository root."""

import json
import os
from pathlib import Path
import subprocess
import sys


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
    checks = ("lint", "typecheck", "test", "build")
    for check in checks:
        command = scripts.get(check)
        if not isinstance(command, str) or not command.strip():
            raise ValueError(f"package.json must define a nonempty {check} script")
    if not Path("bun.lock").is_file():
        raise ValueError("Commit bun.lock before running application checks")

    subprocess.run(["bun", "install", "--frozen-lockfile"], check=True)
    for check in checks:
        subprocess.run(["bun", "run", check], check=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, TypeError, AttributeError, subprocess.CalledProcessError) as error:
        print(f"::error::Application checks failed: {error}", file=sys.stderr)
        sys.exit(1)
