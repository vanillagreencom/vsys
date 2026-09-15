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
- `scripts/`: the CI runner and the three benchmarks.

## Constraints

- The project pins its Bun version in `.bun-version` and carries that runtime as a development dependency, so the repository's own Bun is the one to run. Where the system Bun differs, use `PATH="$PWD/node_modules/.bin:$PATH" python3 scripts/ci.py`.
- `scripts/ci.py` refuses to run unless `package.json` defines a nonempty script for each name in its own `CHECKS`, and `bun.lock` is committed. It installs with `--frozen-lockfile`, so a lockfile behind `package.json` fails rather than resolving. It deletes the files in its `ARTIFACTS` before the checks and requires each one back, present and not empty, after them, so only this run's build can satisfy it.
- A new setting that collection reads must be added to `collectionKeys` in `src/collect/settings.ts`. Leaving it out compiles only because collection never reads it, and the runtime would then not rebuild the collector when it changes.
- A display setting or a notification rule must stay out of that list, because rebuilding the collector discards the counters and alert state a sample compares against.
- Scratch traversal runs in a worker. Bun's bundler does not follow the worker's URL, so `bun run build` emits `src/collect/scratch-worker.ts` as a second entry point beside `dist/main.js`, and `src/collect/scratch.ts` resolves whichever of the two spellings is on disk. A build that emits only the entry point leaves the dashboard unable to measure scratch, and `scripts/ci.py` fails on exactly that.
- The traversal's processor bound lives in a timer on a worker thread, where a unit test stages the clock and no test can see the wait. `bun run bench:scratch` measures it, and the Benchmarks section below says what it proves and what it refuses.
- Docs change in the same commit as the code they describe. The `doc-drift-check` hook reads the `Covers:` line of each file in `docs/architecture/` and shows a notice when covered code changed without them.

## Run and debug

```bash
bun run start                 # the dashboard; needs a TTY
bun src/main.ts --help        # options
bun src/main.ts --once        # one JSON snapshot, exit 2 on source errors
bun src/main.ts --markdown --once
bun src/main.ts --config PATH # another TOML settings file
python3 scripts/ci.py         # install, lint, types, tests, build, scratch bound
bun test src/                 # the application suites alone
bun run build                 # dist/main.js, run it with Bun from the project directory
```

`--once` needs no terminal, which is the way to read a snapshot from a script or a test. Interactive mode refuses to start without a TTY and says so.

## Tests

- `src/collect/*.test.ts`: collection against temporary procfs, cgroup and storage fixtures. No test spawns tmux or a build cache server, because a collector is only given those readers when the program builds it. `src/collect/scratch-worker.test.ts` starts the real scan thread against a temporary directory, which is what proves the worker file resolves in the source tree.
- `src/model/*.test.ts`: lane derivation and naming, the cause ladder and the meters, build classification, the exact command of each lane action, and shell quoting read back through `/bin/sh`.
- `src/store/*.test.ts`: checkpoint replay, retention, the SQLite schema guard, the load-path migration and the timeline event derivation.
- `src/ui/*.test.tsx`: the mounted shell through OpenTUI's terminal test renderer. These drive the real screens from the keyboard and the mouse and read the rendered frame back.
- `src/main.test.ts`: the CLI in terminals created for the test, including that quit and a failed shutdown each restore their own terminal settings.
- `scripts/ci_test.py`: that the CI runner rejects incomplete configuration, a failed command, and a build that emitted only one of its entry points. It reads the runner's own `CHECKS` and `ARTIFACTS`, so a check added to one is not missing from the other. Run it with `python3 -m unittest discover -s scripts -p '*_test.py' -v`.

## Benchmarks and what they do not prove

`bun run bench` collects a fixture of 50 scopes and 2000 processes six times, discards the first, and reports the per-sample and per-phase timings against a 20 ms target. It reads regular files in a temporary directory, so the result does not establish latency on a live procfs mount.

`bun run bench:scratch` builds a scratch tree and measures three scans of it. Two run on a scan thread, a warm-up discarded before each, and report elapsed time and whole-process processor time for a scan that holds the whole thread and one held to the default share. The third runs on the caller's thread through the shipped pace, wrapped so every rest the pace asks for is recorded before the timer takes it, and reports the slice it used, the rests it took and their total.

It is the only instrument that can see the processor bound, which is why it is in the check contract rather than beside the other benchmarks alone. It refuses four things: a bounded scan that read a different total than the full-thread one, any scan that reported a source error, a bounded scan that asked for no rest, and one that finished in under 95 percent of the rest it asked for. Working time sits on top of the rests, so a scan that took them runs well clear of that floor and one that skipped them lands at a fraction of it. The slice is an eighth of the measured full-thread scan, or one millisecond where that is longer, so the traversal crosses one whatever the machine and each rest stays above what a timer resolves.

Its processor figure covers the whole process, so it includes the main thread receiving the reading, and its tree sits in the page cache, so the result does not establish the cost of a cold traversal.

`bun run bench:history` fills the configured history window while replacing a process at each sample, then compares selected replayed snapshots against their originals across checkpoint boundaries. It reports incomplete retention and memory use. Its generated workload does not establish a memory bound for every command line or process mix.

## Repository tooling

- Run `.agents/skills/review-gate/scripts/validate.sh` after changing review settings or the writer workflow, and commit `kendex.settings.toml` with those changes so GitHub uses the tested settings.
- Review instructions are generated from `kendex.toml`. Run `.agents/skills/bot-instructions/scripts/bot-instructions render` after changing them, and check the installed render paths after adding a harness.
- Run `.agents/skills/commit-guards/scripts/md-reflow PATH` on a markdown file you changed, and `.agents/skills/doc-limits/scripts/doc-limits` to check every document against its byte ceiling.
