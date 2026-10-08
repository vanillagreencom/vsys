# Cloud defect review 4: a dashboard left running for days

Reviewed on 2026-10-08 against `main` at `8330253`. Scope: what grows or repeats over a long run. That covers history writes, retention and archive size, the event and alert timeline, timers and listeners, worker threads, the scratch traversal, caches keyed by pid, cgroup or path, and React state.

Five findings, all proven. Four have a failing test under `review/tests/`; finding 2 is proven by its code path and the system state that triggers it. No product file was changed.

`docs/architecture/overview.md`, which the task asked me to read first, does not exist on `main`. I read `AGENTS.md`, `DEVELOPMENT.md` and every file under `docs/architecture/` instead.

## Check contract on main

`python3 scripts/ci.py` stops at its first failing step, the Python suite under `scripts/`, so I ran the remaining steps of `main()` by hand in the same order:

| Step | Result |
|---|---|
| `scripts` Python suites | 1 failure, root only |
| `warden` Python suites | 3 failures, root only |
| `package_file_list_check.py` | pass |
| `bun install --frozen-lockfile` | pass |
| `lint`, `typecheck` | pass |
| `test` | 958 pass, 5 fail, root only |
| `build`, `smoke`, `bench:scratch`, `bench:writes` | pass |

Every failure comes from running as root (uid 0). Root ignores the permission bits these tests set to make a read or a directory creation fail:

- `scrub_reporter_test.InstallTest.test_a_migration_mkdir_failure_is_reported_as_a_carry_over_problem_not_an_install_failure`: a `0o555` parent is writable by root, so `mkdir` succeeds.
- `agent_confine_test.test_agent_confine_scratch_mkdir_failure_keeps_inherited_tmpdir` (two subtests) and `agent_warden_scratch_test.test_reap_scratch_dirs_read_only_directory_rows`: same cause, a read-only directory is writable by root.
- Five cases under `src/` that use `chmod 0o000` to make a file or directory unreadable: `io.test.ts` (scrub read records unavailable versions), `scratch-scan.test.ts` (only a root on a list other than the shipped one fails), and three cases in `btrfs.test.ts` (an unreadable shipped report).

Once those are set aside, no check fails on `main`.

## What was checked and found bounded

These were traced and hold. I list them so they are not reviewed again:

- `History` points ring, its change index, `stored` lane series, and SQLite retention (`DELETE` each sample).
- `Archive` checkpoints, its byte budget, and its lane projections and their pruning.
- `EventLog.watching`, `AlertEngine.active` and `pressureSince`.
- The process environment cache, `sccache` samples and `KernelLog.failures` (capped at 64).
- The React key handlers, timers and subscriptions, and the `useLaneTrends` WeakMap.
- The warden's `state.json` episodes, events (50) and `scratch_failed`.

`ErrorMemory.records` and `StorageCollector.initial` and `.last` are never pruned, but they grow only with new Btrfs filesystem ids, which is not a realistic long-run growth.

## Findings

### 1. Desktop notifications block sampling, one `notify-send` at a time, with no timeout

- **Where:** `src/runtime.ts:200` awaits `notify()` before `this.history.add(snapshot)` at `:206`. `src/model/alerts.ts:104-110` spawns one `notify-send` per alert and awaits each `child.exited` in turn, with no time limit.
- **Proof:** `bun test ./review/tests/notify-stall.test.ts`. A stand-in `notify-send` sits first on the child's `PATH` (Bun resolves executables against the `PATH` it started with), and the real `Session` runs at `refreshMs` 100 with three new `unconfined` alerts per sample.
  - Control, where `notify-send` exits at once: 20 or more frames in 4 s (passes).
  - `notify-send` takes 1 s per call: **1 frame in 4 s** (fails).
- **Impact:**
  - Each new alert adds one full `notify-send` call to its sample, and `busy` holds every later sample behind it.
  - A wedged notification daemon makes each call wait the D-Bus default of 25 s. A build that fans out 20 escaped processes then stops sampling for about 8 minutes.
  - A `notify-send` that never exits stops sampling for the rest of the run.
  - Throughout, the header still reads `● live` (`src/ui/chrome.tsx:136`) over a frozen sample.
- **Likelihood:** notifications are opt-in (`notifications: []` by default). Anyone who turns on `unconfined` and runs builds outside the slice hits the per-alert delay. The indefinite case needs a stuck notifier.
- **Smallest fix:** take notifications off the sample path: fire them without awaiting, bound each spawn with a timeout through `spawnText()`, and run them in parallel or coalesce one sample's alerts into one notice.

### 2. A process read that blocks in the kernel stops sampling for good, with no error

- **Where:**
  - `src/collect/procs.ts:210-212` reads `/proc/<pid>/stat` and `/proc/<pid>/cmdline` for every process on every sample.
  - `WorkerHost.request()` (`src/collect/worker-host.ts:140-170`) sets no deadline; only an abort or `close()` ends a request.
  - `Collector.sample()` awaits it at `src/collect/collector.ts:241`.
  - `Session.tick()` awaits the sample at `src/runtime.ts:196`, and `schedule()` returns while `busy` (`:183`).
- **System state that breaks it:** any process on the machine whose memory map lock is held by a thread stuck in uninterruptible sleep. The usual case is a page fault or `mmap` on a hard-mounted NFS or FUSE filesystem whose server stopped answering. Reading that process's `cmdline` then blocks until the lock frees, which is the well-known way `ps` hangs.
- **Wrong output:**
  - The process thread never answers, so no later sample starts and no source error is recorded.
  - The dashboard keeps drawing the last sample under `● live`, with a frozen clock and stale lane and alert state.
  - Only a change to a collection setting recovers it: that closes the collector, which rejects the pending request. The stuck thread may outlive `terminate()`, as the comment at `worker-host.ts:100-106` says.
- **Impact and likelihood:** rare, but once it happens the dashboard silently stops being a monitor. A stuck NFS or FUSE client is exactly when a reader is watching. The earlier fix ("vsys no longer hangs on every future sample when journalctl stalls or tmux's server wedges", in `CHANGELOG.md`) bounded the subprocess reads but not the thread.
- **No test:** a stub thread that never answers would only restate that no timer exists.
- **Smallest fix:** give `WorkerHost.request()` a deadline of a few refresh intervals that fails the request the way an abort does (end and replace the thread). Record the failure as a source error with `processRead` incomplete, so the next sample proceeds.

### 3. A kernel-log search that times out is repeated from the start on every sample, holding each one for 10 s

- **Where:**
  - `src/collect/kernel-log.ts:106` bounds each search at `kernelLogTimeoutMs` (10 s). A killed `journalctl` throws, because `answered()` rejects exit 143.
  - The cursor advances only after a complete answer (`:217`), and `--show-cursor` prints the cursor last.
  - `src/collect/btrfs.ts:429` awaits `kernelLog.read()` on every sample with no backoff, so the next sample searches the whole journal again (`cursor === null`).
- **Proof:** `bun test ./review/tests/kernel-log-retry.test.ts`. A stand-in `journalctl` prints one matching entry and then outlasts the timeout, as a `--grep` over a large multi-boot journal on a cold disk does.
  - Two consecutive `KernelLog.read()` calls each waited **10006 ms and 10003 ms**.
  - Both searched the whole journal (neither had `--after-cursor`). The test fails.
- **Impact:**
  - Once the first search from boot exceeds 10 s, it can never succeed. Every sample waits 10 s and then fails, so the dashboard refreshes about once every 10 s for the rest of the run.
  - A `journalctl` runs almost continuously (8,640 killed searches a day).
  - The kernel-log reading never arrives, and Storage keeps a `journalctl` source error.
- **Likelihood:** depends on journal size and disk speed. It is plausible on a workstation with a persistent journal of many boots on a spinning or busy disk. This is new beyond the earlier "bounded wait" fix: the bound holds, but the repeat makes it the cost of every sample.
- **Smallest fix:** after a timed-out search, back off (retry no more often than every few minutes) or run the search off the sample path. Alternatively, bound the first search's range (for example `--since` the oldest boot still mounted) so it can finish and record a cursor.

### 4. Every shipped build runs React's development build: a 24 h window costs 0.6 to 0.7 s of the dashboard thread per sample at the default refresh

- **Where:**
  - `scripts/build.ts:20` and `:30` call `Bun.build` without defining `process.env.NODE_ENV`, and nothing in `src/` or `packaging/` sets it.
  - The compiled binary embeds only `react.development.js`, `react-reconciler.development.js` and `react-jsx-dev-runtime.development.js` (checked with `grep -a` on a binary built by `bun scripts/build.ts compile`).
  - `bun src/main.ts` and `bun dist/main.js` (React external) load the development build because `NODE_ENV` is unset.
  - React 19.2's development reconciler logs each component render with a deep diff of the changed props (`addObjectDiffToProperties`). The Home tiles and the Timeline receive `points`, an array of every retained point in the window (`src/ui/App.tsx:221`).
- **Proof:** `bun test ./review/tests/render-cost.test.ts`. The driver mounts the program's own `mountScreen()` on OpenTUI's test renderer, fills a real `History` with 24 h of samples at the default `refreshMs` 1000 (86,400 points), steps the window key to 24 h, and times one sample's `history.add` plus draw. Median of 5, in ms:

  | Build | Home, 5 m | Home, 24 h | Timeline, 24 h |
  |---|---:|---:|---:|
  | As shipped (`NODE_ENV` unset) | 6 | **610** | **709** |
  | `NODE_ENV=production` | 3 | 14 | 37 |

  The production control passes and the shipped case fails a budget of half the refresh interval. A CPU profile (`bun --cpu-prof-md`) puts 72% of the time under `addObjectDiffToProperties` and the native `measure` it feeds.

- **Impact:**
  - The cost grows over the first day as the window fills, and it applies with default settings once the reader presses `w` to the 24 h window. `windowIndex` persists across views, so it stays in force.
  - About 65 to 70% of the dashboard thread goes to render bookkeeping, and a keystroke waits up to 0.7 s.
  - At `refreshMs` 100 the shipped build takes **10.5 s per sample** (measured), so the screen falls behind by orders of magnitude.
- **Smallest fix:** add `define: { "process.env.NODE_ENV": '"production"' }` to both `Bun.build` calls in `scripts/build.ts`. I checked that a compile built that way embeds only the `*.production.js` React files. For `bun dist/main.js` and `bun src/main.ts`, which load React from `node_modules`, the variable must be set before React is imported, or React must be bundled.

### 5. Even with production React, Home and Timeline do work proportional to a day of points on every sample, beyond the interval at refreshMs 100

- **Where:**
  - `src/ui/App.tsx:221` walks and copies the whole window on every render.
  - Home runs `bucketPeaks` once per meter tile (`src/ui/home.tsx:590`).
  - The Timeline walks the window again in `history.events()` (`src/ui/timeline-screen.tsx:124`), buckets it once (`:136`), and buckets it again for each of eight `peaks()` calls (`:180`, `:181-182`, `:334`).
  - Each `bucketPeaks` is a fresh `timeBuckets` pass that allocates one array per column and pushes every point into it (`src/ui/format.ts:118-160`).
- **Proof:** the third case of `bun test ./review/tests/render-cost.test.ts`, with `NODE_ENV=production`, `refreshMs` 100 and 864,000 points: Home at 24 h takes **235 ms** and the Timeline at 24 h **584 ms** per sample (an earlier run measured 214 and 679). The 50 ms budget fails, and both exceed the 100 ms interval itself.
- **Impact:** a reader who sets the shortest refresh the settings accept and looks at the day saturates the dashboard thread. Samples queue behind renders, and keys wait half a second. The store avoids this kind of scan on purpose (the comments at `src/store/history.ts:84-88` and `:410-415` cite the same 864,000-point case), but the screens undo it.
- **Likelihood:** needs `refreshMs` near its 100 ms floor plus a long window. At the default refresh the production cost is 14 to 37 ms, which is acceptable.
- **Smallest fix:** bucket the window once per render and derive every peak from those buckets. Better, keep per-column peaks incrementally in the store, as `Points.newest` does for changes, so a render touches only the columns.

## Running the tests

`review/tests/run-all.sh` runs all three. Each one alone, from the repository root, with the pinned Bun:

```sh
bun test ./review/tests/notify-stall.test.ts      # finding 1, ~12 s
bun test ./review/tests/kernel-log-retry.test.ts  # finding 3, ~20 s
bun test ./review/tests/render-cost.test.ts       # findings 4 and 5, ~1 min
```

Each test fails on `main` by asserting the behaviour the settings promise. Each makes its scratch with `mkdtemp` under the system temporary directory and removes only that directory. The stand-in `notify-send` and `journalctl` are scripts in that directory. No test signals, stops or moves a real process, touches a systemd unit or opens `/dev/dri`. `render-cost.driver.tsx` and `notify-stall.driver.ts` are the child programs the tests start; neither is a test on its own.
