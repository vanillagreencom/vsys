# vsys development

A maintainer works on the collector that reads the machine, the model that decides what is wrong, the store that retains it and the terminal UI that draws it. Read [the architecture overview](docs/architecture/overview.md) before moving work between those layers.

## Layout

- `src/collect/`: reads cgroup v2, procfs, mounts, drive reports and the build cache. Takes `CollectionConfig` and nothing wider, and never imports the UI.
- `src/model/`: derives lanes, names, the cause ladder, the meters, alert transitions and lane actions, all as numbers and identifiers.
- `src/store/`: the in-memory archive, the optional SQLite history, the per-sample points and the timeline event derivation.
- `src/config/`: the settings contract, validation, loading and saving, key bindings, and agent-tool classification data loading.
- `src/ui/`: the shell, the seven screens and every word and formatted number on them.
- `src/runtime.ts`: the sampling scheduler and the settings-change path. `src/main.ts` is the entry point and `src/effect.ts` performs a confirmed lane action.
- `src/test/`: the temporary-file fixture, the mounted-app harness and the busctl stand-in for udisks2 that the suites share, and the warning gate `bunfig.toml` preloads into every suite.
- `scripts/`: the CI runner, the standalone binary check, the sample check for a built program, the three benchmarks with the percentile two of them share, and the root-side scrub and drive reporters under `scripts/scrub-reporter/` and `scripts/smart-reporter/`, which vsys never runs.
- `data/`: shipped JSON data that both the dashboard and the warden read.
- `warden/`: the optional Python agent warden, its launcher scripts, its systemd user-unit templates and its unit tests.

## Constraints

- The project pins its Bun version in `.bun-version` and carries that runtime as a development dependency, so the repository's own Bun is the one to run. Where the system Bun differs, use `PATH="$PWD/node_modules/.bin:$PATH" python3 scripts/ci.py`.
- `scripts/ci.py` refuses to run unless `package.json` defines a nonempty script for each name in its own `CHECKS`, and `bun.lock` is committed. It installs with `--frozen-lockfile`, so a lockfile behind `package.json` fails rather than resolving. It deletes the files in its `ARTIFACTS` before the checks and requires each one back, present and not empty, after them, so only this run's build can satisfy it.
- `.github/workflows/ci.yml` ends in a job named `CI`. It fails when any job it lists in `needs` fails, is cancelled, or skips without the `changes` job's verdict standing it down, and it is the aggregate the main ruleset is to require in place of the per-job checks. Its "Require every other job in needs" step parses the workflow with `yq` and fails when that `needs` list differs from the other jobs in the workflow, so a new job must go into the list.
- A new setting that collection reads must be added to `collectionKeys` in `src/collect/settings.ts`. Leaving it out compiles only because collection never reads it, and the runtime would then not rebuild the collector when it changes.
- A display setting or a notification rule must stay out of that list, because rebuilding the collector discards the counters and alert state a sample compares against.
- Scratch traversal and process reads each run in a worker, and Bun's bundler does not follow a worker's URL. A new worker goes into the entry list in `scripts/build.ts` and the `ARTIFACTS` in `scripts/ci.py`, or a shipped build cannot start it; [process collection](docs/architecture/processes.md) states the whole chain and the checks that enforce it.
- The traversal's processor bound lives in a timer on a worker thread, where a unit test stages the clock and no test can see the wait. `bun run bench:scratch` measures it, and the Benchmarks section below says what it proves and what it refuses.
- `tsconfig.json` sets `noUncheckedIndexedAccess`. An indexed read is guarded, or restructured so the compiler sees it present, never asserted with `!` or cast. A test that depends on an element being there reads it through `present()` in `src/test/present.ts`, which fails at the read and names what was missing.
- Docs change in the same commit as the code they describe. The `doc-drift-check` hook reads the `Covers:` line of each file in `docs/architecture/` and shows a notice when covered code changed without them.

## Run and debug

```bash
bun run start                 # the dashboard; needs a TTY
bun src/main.ts --help        # options
bun src/main.ts --once        # one JSON snapshot, exit 2 on source errors
bun src/main.ts --once --summary # cheap verdict JSON, exit 2 on source errors
bun src/main.ts --markdown --once
bun src/main.ts --config PATH # another TOML settings file
python3 scripts/ci.py         # Python suites, package check, install, lint, types, tests, build, a sample with the bundle and a compiled binary, scratch bound, history write budget
bun test src/                 # the application suites alone
bun run build                 # dist/main.js and both workers under dist/collect/; run main.js with Bun from the project directory
bun run compile               # the standalone ./vsys binary the release and the vsys-git package ship
bun run smoke                 # one --once fixture sample with dist/main.js, and one with a binary compiled into the fixture
bun scripts/sample-check.ts PATH # the same sample with a binary already built
```

`--once` needs no terminal, which is the way to read a snapshot from a script or a test. Interactive mode refuses to start without a TTY and says so.

## Tests

- `src/collect/*.test.ts`: collection against temporary procfs, cgroup and storage fixtures. No test spawns tmux or a build cache server, because a collector is only given those readers when the program builds it. `src/collect/scratch-worker.test.ts` starts the real scan thread against a temporary directory, which is what proves the worker file resolves in the source tree, and reads back from its replies that it rested under a duty of 50 and not at 100. A collector built in a test reads processes in the test's own thread; `src/collect/process-thread.test.ts` compares the real process thread against that reader. `src/collect/worker-host.test.ts` drives each thread failure through a stand-in thread on the host both collection threads share, and `src/collect/scratch-worker.test.ts` runs a child program that quits while its scan thread is blocked reading a pipe.
- `src/model/*.test.ts`: lane derivation and naming, the cause ladder and the meters, build classification, the exact command of each lane action, and shell quoting read back through `/bin/sh`.
- `src/store/*.test.ts`: checkpoint replay, retention, the SQLite schema guard, the load-path migration and the timeline event derivation.
- `src/ui/*.test.tsx`: the mounted shell through OpenTUI's terminal test renderer. These drive the real screens from the keyboard and the mouse and read the rendered frame back. A test that reads where a screen scrolled calls `settle()` from `src/test/harness.tsx` first; [the UI topic](docs/architecture/ui.md) says why.
- `src/test/warnings.ts`: fails any test during which something wrote to `console.error` or `console.warn`, with the text in the failure. A warning written after the last test, such as from a file's `afterAll`, fails the end of the run. Bun reads `bunfig.toml` from the directory it starts in, so run the suites from the repository root; `src/test/warnings.test.ts` fails from anywhere else and says why. React reports a duplicate or missing key, an update outside `act` and invalid nesting that way and keeps rendering, so a printed warning would otherwise pass the run. A warning that is acceptable is silenced where it is written, with the reason beside it; the gate stays on. A test that destroys a renderer it made with `testRender` does so inside `act`, as `close()` in the harness does, or React warns about the unmount. `src/test/warnings.test.ts` runs `src/test/duplicate-key.fixture.tsx` in a child `bun test` and requires its two warning tests and its warning `afterAll` to fail and its clean test to pass. The fixture's name is outside Bun's test pattern, so `bun test src/` does not run it.
- `src/test/indexed-access.test.ts`: that the type check, run with the repository's own `tsconfig.json`, reports an indexed read used without a guard and accepts the same read guarded.
- `src/main.test.ts`: the CLI in terminals created for the test, including the once JSON and summary JSON paths, that quit and a failed shutdown each restore their own terminal settings, and that a hangup and a terminate signal run the quit key's shutdown and print its failure report.
- `scripts/ci_test.py` and `scripts/package_file_list_check_test.py`: that the CI runner rejects incomplete configuration, failed packaging and application checks, a build that emitted only one of its entry points or left one empty, a missing `scripts/` or `warden/` directory or `scripts/` suite, a missing `package.json`, and a failed `scripts/` or `warden/` suite, that the package payload check catches a missing warden file, wrong staged source, ownership-preserving copy, unpinned local Arch package source and a package-owned user unit, and that `install.sh` installs, replaces, warns after committed cleanup failures and rolls back the warden tree while still accepting older binary-only archives. `scripts/ci_test.py` reads the runner's own `CHECKS` and `ARTIFACTS`, so a check added to one is not missing from the other. `scripts/scrub_reporter_test.py` runs the scrub reporter and its installer against stub `btrfs`, `journalctl`, `curl` and `systemctl` commands, and parses each report with vsys's own parser through Bun: the report carries the fields vsys reads and only names proved to be of the damaged inode, and a missing scrub unit, a failed download, a missing `SHA256SUMS`, or a checksum mismatch installs nothing. `scripts/smart_reporter_test.py` runs the drive reporter and its installer against stub `smartctl`, `curl` and `systemctl` commands the same way, parsing each report with `smartWrites()`: a missing `smartctl`, a failed download, a missing `SHA256SUMS`, a missing checksum or a checksum mismatch installs nothing, and the release checksums every file the installer fetches. Run them with `python3 -m unittest discover -s scripts -p '*_test.py' -v`.
- The `*_test.py` files in `warden/`: planning and job units, classification, limits, orphan rules, scratch reaping, launcher scratch creation, numeric settings, status, notices and install. Run them with `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s warden -p '*_test.py'`.

## Benchmarks and what they do not prove

`bun run bench` collects a fixture of 50 scopes and 2000 processes 21 times with processes read on their own thread, as the program reads them. It reports the first sample alone, because that sample starts the thread, then the median and 95th percentile of elapsed time and of whole-process processor time for the other 20, the per-phase medians, and whether every sample met the 20 ms elapsed target. It reads regular files in a temporary directory, so the result does not establish latency on a live procfs mount. Both benchmarks report nearest-rank percentiles through `scripts/percentile.ts`.

Process collection before and after moving it onto its own thread ([process collection](docs/architecture/processes.md)), measured on 2026-10-01 on cachy, Linux 7.2.8-1-cachyos, 32 logical cores, with other work running. Before is the asynchronous reader on the dashboard's thread; after is the shipped thread. Processor time counts every thread of the process, so the thread and the transfer are included. Percentiles are nearest-rank.

Only the `bun run bench` row is reproducible from the repository. The other rows come from one-off probes kept out of it, listed in the Source column:

- Fixture probe: the `bun run bench` fixture, before and after alternating, three runs of 40 measured samples each after two discarded ones. Ranges span the three runs.
- Input probe: the fixture probe with a second thread posting a timestamp every 2 ms while samples run back to back. The delay is the time until the dashboard's thread handles the event, a stand-in for keyboard response.
- Live probe: process collection alone over the live `/proc`, before and after alternating, two runs of 30 readings over 1010 to 1042 processes, with no watched groups and with agent and build classification emptied, so every read stays inside `/proc`.
- One-shot probe: `src/main.ts --once --summary` against the fixture, before and after alternating, 10 measured runs each.

| Measurement | Before | After | Source |
| --- | --- | --- | --- |
| Fixture sample, median processor time | 40.7 to 41.5 ms | 27.0 to 28.4 ms | Fixture probe |
| Fixture sample, 95th percentile processor time | 60.0 to 62.8 ms | 48.8 to 51.3 ms | Fixture probe |
| Fixture sample, median elapsed time | 17.6 to 18.3 ms | 23.0 to 23.8 ms | Fixture probe |
| Fixture sample, 95th percentile elapsed time | 21.8 to 23.7 ms | 26.5 to 31.2 ms | Fixture probe |
| Fixture samples under the 20 ms target | 32 to 35 of 40 | 0 of 40 | Fixture probe |
| Resident memory after 42 samples and a full collection | 97.8 to 100.7 MiB | 107.7 to 108.8 MiB | Fixture probe |
| Input event delay, median | 0.29 to 0.32 ms | 0.010 to 0.012 ms | Input probe |
| Input event delay, 95th percentile | 4.2 to 4.5 ms | 3.3 to 3.8 ms | Input probe |
| Input event delay, slowest | 5.6 to 11.8 ms | 5.0 to 7.0 ms | Input probe |
| Live `/proc` process collection, median processor time | 26.6 and 29.5 ms | 19.7 and 22.1 ms | Live probe |
| Live `/proc` process collection, 95th percentile processor time | 33.5 and 39.0 ms | 27.1 and 28.0 ms | Live probe |
| Live `/proc` process collection, median elapsed time | 13.3 and 15.4 ms | 17.2 and 20.0 ms | Live probe |
| `--once --summary`, median wall time | 172.8 ms | 185.8 ms | One-shot probe |
| `--once --summary`, median processor time | 154.1 ms | 129.8 ms | One-shot probe |
| Fixture, 20 samples: elapsed median and 95th percentile, processor time median and 95th percentile | not measured | 23.7 and 27.3 ms, 28.1 and 38.7 ms | `bun run bench` |

- Every phase except reading processes still runs on the dashboard's thread: mounts, system totals, the cgroup tree, storage, device writes, the build cache and tmux reads, the model and parsing the thread's reply. That is the input delay left after the change.
- The resident memory rows were taken in separate runs from the processor-time rows, under heavier load, so their processor times are not in the table.
- The fixture's elapsed time no longer meets the 20 ms target. The thread reads files one after another, while the asynchronous reader overlapped them; the target is reported apart from the processor time it saves.

`bun run bench:scratch` builds a scratch tree and measures three scans of it. Two run on a scan thread, a warm-up discarded before each, and report elapsed time and whole-process processor time for a scan that holds the whole thread and one held to the default share, with the rests the thread reports the second took. The third runs on the caller's thread through the shipped pace, wrapped so every rest the pace asks for is recorded before the timer takes it, and reports the slice it used, the rests it took and their total.

It is the only instrument that can see the processor bound, which is why it is in the check contract rather than beside the other benchmarks alone. It refuses four things: a bounded scan that read a different total than the full-thread one, any scan that reported a source error, a bounded scan that asked for no rest, and one that finished in under 95 percent of the rest it asked for. Working time sits on top of the rests, so a scan that took them runs well clear of that floor and one that skipped them lands at a fraction of it. The slice is an eighth of the measured full-thread scan, or one millisecond where that is longer, so the traversal crosses one whatever the machine and each rest stays above what a timer resolves.

Its processor figure covers the whole process, so it includes the main thread receiving the reading, and its tree sits in the page cache, so the result does not establish the cost of a cold traversal.

`bun run bench:history` first times the history writes of one sample with SQLite on, alone and beside processes that write and sync to the same disk, and reports the whole `History.add` and its SQLite commit apart. It then fills the configured history window while replacing a process at each sample and moving every counter by a different amount per row, then compares selected replayed snapshots against their originals across checkpoint boundaries. It reports incomplete retention, memory use, and the median, 95th percentile and slowest append for both `History.add` and `Archive.add`. Its generated workload does not establish a memory bound for every command line or process mix, and its timings come from one machine under whatever else it was running.

`bun run bench:writes`, in the check contract, is the first measurement alone without the load, and fails when its median exceeds the write budget; [the history store](docs/architecture/history.md#limits-of-the-checks) says why only that figure is held to it.

One-shot measurement for `--summary`:

| Date | Machine | Kernel | Command | Wall seconds | CPU |
| --- | --- | --- | --- | --- | --- |
| 2026-09-29 | cachy | Linux 7.2.8-1-cachyos x86_64 GNU/Linux | `bun src/main.ts --once` | 1.11 | 138% |
| 2026-09-29 | cachy | Linux 7.2.8-1-cachyos x86_64 GNU/Linux | `bun src/main.ts --once --summary` | 0.18 | 82% |
| 2026-10-01 | cachy | Linux 7.2.8-1-cachyos x86_64 GNU/Linux | `bun src/main.ts --once`, before the kernel log reading | 0.82 to 0.83 | 115% |
| 2026-10-01 | cachy | Linux 7.2.8-1-cachyos x86_64 GNU/Linux | `bun src/main.ts --once`, with it | 1.33 to 1.36 | 110 to 111% |
| 2026-10-01 | cachy | Linux 7.2.8-1-cachyos x86_64 GNU/Linux | `bun src/main.ts --once --summary`, before the kernel log reading | 0.29 to 0.31 | 93 to 98% |
| 2026-10-01 | cachy | Linux 7.2.8-1-cachyos x86_64 GNU/Linux | `bun src/main.ts --once --summary`, with it | 0.28 to 0.31 | 93 to 96% |

Every measured command exited with status 2 on this machine because source errors were present. The 2026-10-01 rows are 3 to 5 runs each of the base commit and this branch, taken one after the other; the base measured 0.29 to 0.31 s for the summary that day, so the 0.18 s row reflects a different machine state rather than a change. A plain `--once` pays the kernel log's first search over every boot the journal holds, 12 on this machine; the summary skips it.

## Repository tooling

- Review instructions are generated from `kendex.toml`. Run `.agents/skills/bot-instructions/scripts/bot-instructions render` after changing them, and check the installed render paths after adding a harness.
- Run `.agents/skills/commit-guards/scripts/md-reflow PATH` on a markdown file you changed, and `.agents/skills/doc-limits/scripts/doc-limits` to check every document against its byte ceiling.
