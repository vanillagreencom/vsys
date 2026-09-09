# Development

The application uses the Bun version in `.bun-version`. `package.json` includes that runtime as a development dependency. Use `PATH="$PWD/node_modules/.bin:$PATH" python3 scripts/ci.py` when the system Bun has a different version.

Run `python3 scripts/ci.py` from the repository root for dependency, lint, type, test, and build checks. Run `python3 -m unittest discover -s scripts -p '*_test.py' -v` to verify that the CI runner rejects incomplete configuration and failed commands.

The application tests use temporary procfs, cgroup, and storage fixtures. The UI tests use OpenTUI's terminal test renderer. The CLI suite opens isolated terminals. It verifies restoration after quit, Ctrl+C, and a forced shutdown failure.

Run `bun run bench` to measure collection with the plan's scope and process counts. The benchmark reports measured samples and whether they meet the target. It builds files in a temporary directory. Regular-file reads do not establish performance on a live procfs mount.

Run `bun run bench:history` to check retention over the configured window. This benchmark advances sample timestamps and replaces a test process at each sample. It compares replayed snapshots with saved originals across checkpoint boundaries. It reports incomplete retention and memory use.

`bun run build` produces `dist/main.js`. Run it with Bun from the project directory so its external dependencies can resolve.

The collector owns source reads. The model derives lanes and rule hits. The runtime owns scheduling and settings changes. The history store owns application persistence. The UI owns navigation and display. Read [the architecture notes](docs/architecture/overview.md) before changing those boundaries.

Run `.agents/skills/review-gate/scripts/validate.sh` after changing review settings or the writer workflow. Commit `kendex.settings.toml` with those changes so GitHub uses the tested settings.

Review instructions are generated from `kendex.toml`. Run `.agents/skills/bot-instructions/scripts/bot-instructions render` after changing them. The manifest lists installed render paths explicitly because the generator cannot derive Antigravity exclusions. Check this list after adding a harness.
