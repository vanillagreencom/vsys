# vsys development

A maintainer works on the collector that reads the machine, the model that decides what is wrong, the store that retains it and the terminal UI that draws it. Read [the architecture overview](docs/architecture/overview.md) before moving work between those layers.

## Layout

- `src/collect/`: reads cgroup v2, procfs, mounts, drive reports and the build cache. Takes `CollectionConfig` and nothing wider, and never imports the UI.
- `src/model/`: derives lanes, names, the cause ladder, the meters, alert transitions and lane actions, all as numbers and identifiers.
- `src/store/`: the in-memory archive, the optional SQLite history, the per-sample points and the timeline event derivation.
- `src/config/`: the settings contract, validation, loading and saving, and the key bindings.
- `src/ui/`: the shell, the seven screens and every word and formatted number on them.
- `src/runtime.ts`: the sampling scheduler and the settings-change path. `src/main.ts` is the entry point and `src/effect.ts` performs a confirmed lane action.
- `src/test/`: the temporary-file fixture and the mounted-app harness the suites share.
- `scripts/`: the CI runner and the two benchmarks.

## Constraints

- The project pins its Bun version in `.bun-version` and carries that runtime as a development dependency, so the repository's own Bun is the one to run. Where the system Bun differs, use `PATH="$PWD/node_modules/.bin:$PATH" python3 scripts/ci.py`.
- `scripts/ci.py` refuses to run unless `package.json` defines a nonempty `lint`, `typecheck`, `test` and `build` script and `bun.lock` is committed. It installs with `--frozen-lockfile`, so a lockfile behind `package.json` fails rather than resolving.
- A new setting that collection reads must be added to `collectionKeys` in `src/collect/settings.ts`. Leaving it out compiles only because collection never reads it, and the runtime would then not rebuild the collector when it changes.
- A display setting or a notification rule must stay out of that list, because rebuilding the collector discards the counters and alert state a sample compares against.
- Docs change in the same commit as the code they describe. The `doc-drift-check` hook reads the `Covers:` line of each file in `docs/architecture/` and shows a notice when covered code changed without them.

## Run and debug

```bash
bun run start                 # the dashboard; needs a TTY
bun src/main.ts --help        # options
bun src/main.ts --once        # one JSON snapshot, exit 2 on source errors
bun src/main.ts --markdown --once
bun src/main.ts --config PATH # another TOML settings file
python3 scripts/ci.py         # install, lint, types, tests, build
bun test src/                 # the application suites alone
bun run build                 # dist/main.js, run it with Bun from the project directory
```

`--once` needs no terminal, which is the way to read a snapshot from a script or a test. Interactive mode refuses to start without a TTY and says so.

## Tests

- `src/collect/*.test.ts`: collection against temporary procfs, cgroup and storage fixtures. No test spawns tmux or a build cache server, because a collector is only given those readers when the program builds it.
- `src/model/*.test.ts`: lane derivation and naming, the cause ladder and the meters, build classification, the exact command of each lane action, and shell quoting read back through `/bin/sh`.
- `src/store/*.test.ts`: checkpoint replay, retention, the SQLite schema guard, the load-path migration and the timeline event derivation.
- `src/ui/*.test.tsx`: the mounted shell through OpenTUI's terminal test renderer. These drive the real screens from the keyboard and the mouse and read the rendered frame back.
- `src/main.test.ts`: the CLI in terminals created for the test, including that quit and a failed shutdown each restore their own terminal settings.
- `scripts/ci_test.py`: that the CI runner rejects incomplete configuration and a failed command. Run it with `python3 -m unittest discover -s scripts -p '*_test.py' -v`.

## Benchmarks and what they do not prove

`bun run bench` collects a fixture of 50 scopes and 2000 processes six times, discards the first, and reports the per-sample and per-phase timings against a 20 ms target. It reads regular files in a temporary directory, so the result does not establish latency on a live procfs mount.

`bun run bench:history` fills the configured history window while replacing a process at each sample, then compares selected replayed snapshots against their originals across checkpoint boundaries. It reports incomplete retention and memory use. Its generated workload does not establish a memory bound for every command line or process mix.

## Repository tooling

- Run `.agents/skills/review-gate/scripts/validate.sh` after changing review settings or the writer workflow, and commit `kendex.settings.toml` with those changes so GitHub uses the tested settings.
- Review instructions are generated from `kendex.toml`. Run `.agents/skills/bot-instructions/scripts/bot-instructions render` after changing them, and check the installed render paths after adding a harness.
- Run `.agents/skills/commit-guards/scripts/md-reflow PATH` on a markdown file you changed, and `.agents/skills/doc-limits/scripts/doc-limits` to check every document against its byte ceiling.
