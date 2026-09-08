# Development

The application uses Bun on Linux. Install the version in `.bun-version`.

Run `python3 scripts/ci.py` from the repository root. The planning tree reports that application checks are unavailable. Adding `src` requires `package.json`. The first application commit must include `bun.lock` and the package scripts required by `scripts/ci.py`.

Run `python3 -m unittest discover -s scripts -p '*_test.py' -v` to check the CI runner. The suite plants missing configuration and failed commands. Each failure must stop validation.

Run `.agents/skills/review-gate/scripts/validate.sh` after changing review settings or the writer workflow. Commit `kendex.settings.toml` with those changes so GitHub uses the tested settings.

The CI workflow runs for pull requests and merge queue entries. GitHub requires its application and review configuration checks alongside the `Review gate` status. The writer uses the default branch's review engine.

Review instructions are generated from `kendex.toml`. Run `.agents/skills/bot-instructions/scripts/bot-instructions render` after changing them. The installed generator cannot derive exclusions for Antigravity, so the manifest lists the installed render paths explicitly. Check this list after adding a harness.
