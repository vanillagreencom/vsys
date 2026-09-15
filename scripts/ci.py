#!/usr/bin/env python3
"""Run the application checks from the repository root."""

import json
from pathlib import Path
import subprocess
import sys


ARTIFACTS = ("dist/main.js", "dist/scratch-worker.js")


def main() -> int:
    """Allow a planning-only tree, or require the complete Bun check contract."""
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
    # The scratch scan runs in a worker, which the bundler does not follow, so
    # the build emits it as a second entry point. Nothing else here reads the
    # build's output: dropping that entry point leaves every check green while
    # the shipped dashboard cannot measure scratch at all. Last run's files are
    # removed first, so only this build can satisfy the requirement.
    for name in ARTIFACTS:
        Path(name).unlink(missing_ok=True)
    for check in checks:
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
