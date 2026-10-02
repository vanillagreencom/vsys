# vsys defect review

Reviewed commit: `e205043` (main). Scope: `src/`, `warden/`, `data/` and the shipped scrub reporter. Ten findings, ordered by impact. Each one is proven by a test that fails on the reviewed commit.

## Running the proofs

Run every proof from the repository root:

```bash
PATH="$PWD/node_modules/.bin:$PATH" bun test review/tests/
```

- 13 tests fail on the reviewed commit, and each failure is a defect below.
- One control passes: `control: a fresh collector reads the exec'd agent's account`.
- `bunfig.toml` preloads the warning gate, so the command must run from the repository root.
- The tests live outside `tsconfig.json`'s `include` and outside the lint paths, so they do not change `scripts/ci.py`.
- The doc-drift Stop hook lists `review/tests/*` as uncovered. They are review-only proofs, not product code, and this review was not to touch `docs/`, so no `Covers:` line was added.

| File | Findings |
| --- | --- |
| `review/tests/lanes.test.ts` | 1, 4, 7 |
| `review/tests/storage.test.tsx` | 2, 5, 8 |
| `review/tests/settings-history.test.ts` | 3, 10 |
| `review/tests/collect.test.ts` | 6, 9 |

## Check contract on main

`python3 scripts/ci.py` stops at its first failing step, which is the warden step. To see the rest, I ran it a second time with only `run_warden_checks` skipped (`python3 -c "import sys; sys.path.insert(0,'scripts'); import ci; ci.run_warden_checks=lambda: None; sys.exit(ci.main())"`), then ran the steps after `test` by hand.

| Step | Result |
| --- | --- |
| warden selftest | pass |
| warden unit tests | 2 failures, root only (below) |
| packaging file-list check | pass |
| install, lint, typecheck | pass |
| `bun test src/` | 760 pass, 1 fail, root only (below) |
| build, smoke (bundle and compiled binary) | pass |
| bench:scratch | pass |
| bench:writes | pass (median 17.3 ms against a 50 ms budget) |

Three test failures, all because this session runs as root, so a chmod-based permission denial does not apply:

- `warden/agent_warden_test.py`, `test_agent_confine_scratch_mkdir_failure_keeps_inherited_tmpdir`, subtests "warns that TMPDIR is unavailable" and "keeps the inherited TMPDIR when the per-scope directory could not be created". The test makes `$XDG_CACHE_HOME/agents/tmp` mode 0500 so that `mkdir` fails, but root creates the directory anyway.
- `src/collect/scratch-scan.test.ts`, "only a root on a list other than the shipped one fails for not existing". The test makes `nested/locked` mode 000, and root reads it anyway, so the expected error never occurs.

## Findings

### 1. Stop on a scope nested inside a container signals the user's own systemd manager

- **Where:**
  - `src/model/actions.ts:61-72`: `laneTarget()` accepts any cgroup whose last component ends in `.scope`.
  - `src/model/actions.ts:85-87`: Stop then addresses that scope by its bare name, as `systemctl --user kill --signal=TERM <scope>`.
  - `src/model/lanes.ts:302-325`: every `.scope` group under a capped ancestor becomes a lane.
- **Proof:** `review/tests/lanes.test.ts`, test "Stop on a scope nested in a capped container never names the user manager's init.scope".
  - It collects a fixture with `user.slice/libpod-abc.scope` (`memory.max` 512 MiB) and the container's own systemd in `user.slice/libpod-abc.scope/container/init.scope`. That nested scope becomes a lane through `dangerousCap`.
  - `resolveIntent(laneIntent("Stop", …))` returns `ready` with argv `["systemctl","--user","kill","--signal=TERM","init.scope"]`.
  - In the user manager, `init.scope` is the manager's own unit, `user@UID.service/init.scope`. systemd(1) says that a user manager receiving SIGTERM starts `exit.target`, which ends every user service and the session.
- **Impact:** a confirmed Stop on what reads as one capped container lane shuts down the reader's whole user session. This is the worst defect found.
  - It needs write mode on and a container booted with systemd under a memory limit below `memoryFloor`, such as `podman run --memory=512m <systemd image>`. That pattern is uncommon but realistic.
  - The lane is flagged as dangerous, so it is exactly the lane a reader would want to stop.
- **Smallest fix:** in `laneTarget()`, return null unless the scope's parent component is a `.slice`, or the scope sits directly under the configured root, so Stop only ever names a unit position systemd itself created.

### 2. A scrub that repairs errors leaves the filesystem flagged as having new errors until the next scrub

- **Where:** `src/model/integrity.ts:289`, which tests `errorAt > checkedAt`. `checkedAt` is the report's `Scrub started` time (`:259`), and `errorAt` is when vsys saw `corruption_errs` grow.
- **Proof:** `review/tests/storage.test.tsx`, test "a scrub that corrected every error it found is not new errors since that scrub".
  - The kernel increments `corruption_errs` for every checksum error a scrub finds, repaired or not: `fs/btrfs/scrub.c`, `scrub_stripe_report_errors()`, calls `btrfs_dev_stat_inc_and_print(…, BTRFS_DEV_STAT_CORRUPTION_ERRS)` once per csum error.
  - That growth is observed during the scrub, which is after its start time.
  - The test then supplies a finished report with `Corrected: 3, Uncorrectable: 0`. `integrities()` returns `complete: true, state: "new-errors"`, a danger state that says nothing has read the filesystem end to end since.
- **Impact:** on a RAID1 or DUP filesystem, a scrub that did its job turns Storage and Home red. The words claim the filesystem has not been checked since the errors, which is false. The state persists, because the error memory is on disk, until a later scrub, which by default is a month away.
  - Likely whenever a scrub corrects anything, which is the case this screen exists for.
- **Smallest fix:** treat counter growth that a finished report covers as checked. For example, compare `errorAt` against the scrub's end (`startedAt + Duration`) when the report counted at least as many errors as the growth.

### 3. A Settings save reverts hand edits made to `config.toml` while vsys runs, and drops every comment

- **Where:** `src/runtime.ts:259-262` builds `configText` from the in-memory config with `configBody()` (`src/config/config.ts:568`). `:289` writes it over the file. `configure()` already re-reads the file at `:225`, but uses that read only for `agentTools`.
- **Proof:** `review/tests/settings-history.test.ts`, test "a Settings save keeps a hand edit and a comment made while vsys runs".
  - With a session running, the file is rewritten by hand to `# keep RSS first on this box` and `sort = "rss"`.
  - One unrelated Settings change follows (`descending = false`).
  - Expected `{comment: true, sort: "rss", descending: false}`; received `{comment: false, sort: "cpu", descending: false}`.
- **Impact:** a setting the reader typed into the file is silently lost, and so are comments, on any Settings save, including a save with no hand edit. Likely for anyone who keeps an editor open on `config.toml` while the dashboard runs.
- **Smallest fix:** apply only the keys changed on the Settings screen on top of `currentState` (the file as it is now) and serialize that. Keeping comments needs an in-place TOML edit instead of `serialize()`.

### 4. An escaped agent outside a scope shows the wrong memory cap, usually "unlimited"

- **Where:** `src/model/lanes.ts:194` and `:203`. A lane with no group takes `cgroup = main.group`, the absolute kernel path (`/user.slice/…`). `effectiveMax()` (`:70-82`) compares that against group paths relative to the configured root, so only the root group `"."` ever covers it.
- **Proof:** `review/tests/lanes.test.ts`.
  - "a group-less agent lane reports the 512 MiB cap of the service it runs in": an agent in `app.slice/agent.service` with `memory.max` 512 MiB gives `{max: null, known: true}`. `src/ui/format.ts:58-59` draws that as `unlimited`.
  - "an agent outside the configured root does not read as known-unlimited": an agent in `/user.slice/user-1000.slice/session-2.scope`, outside the user manager, gets `memoryMaxKnown: true` from `user@1000.service`, a group it is not in.
- **Impact:** wrong state on the Agents screen. A capped agent reads as unlimited, and an agent vsys cannot measure reads as measured.
  - The first case is any agent run under a user `.service`, such as `systemd-run --user` without `--scope` or tmux run as a user service.
  - The second is any agent started in an SSH login. Medium likelihood.
- **Smallest fix:** resolve a group-less lane to the group whose `kernelPath` equals the process's cgroup, and return `known: false` when no group matches.

### 5. An interrupted scrub report reads as clean and raises no alert

- **Where:** `src/collect/btrfs.ts:31-32`. `scrubProblem()` treats only `aborted|canceled|cancelled|failed` as a stopped scrub.
- **Proof:** `review/tests/storage.test.tsx`, test "an interrupted scrub report is not a clean one".
  - btrfs-progs prints `Status: interrupted` for a scrub that neither finished nor was cancelled (`cmds/scrub.c:343`, `ss->finished ? "finished" : "interrupted"`), for example one cut off by a shutdown.
  - The shipped reporter writes `btrfs scrub did not complete (interrupted)` above it (`scripts/scrub-reporter/vsys-scrub-report:56`).
  - For such a report with `Error summary: no errors found`, `problem` is `false`, and the Storage scrub row reads `clean`.
- **Impact:** a scrub that never finished is shown as clean, and the `scrub` alert rule never fires for it.
  - The integrity row does not count it as a check (`src/model/integrity.ts:259`), so the scrub row and the integrity row disagree.
  - Likely whenever a long scrub is cut off by a reboot.
- **Smallest fix:** in `scrubProblem()`, treat every `Status:` other than `finished` (and `running`) as a problem, matching the integrity model's rule that only `finished` is a check.

### 6. An agent `exec`'d from a pane shell keeps the shell's environment, so its account is wrong

- **Where:** `src/collect/procs.ts:325-338`. The environment cache is keyed on pid and start time. `execve` keeps both, but replaces `environ`.
- **Proof:** `review/tests/collect.test.ts`.
  - "a scope main that execs into an agent reads the agent's environment": pid 40 is the main process of `pane.scope`, first `bash` with no `CLAUDE_CONFIG_DIR`, then `exec`'d into `claude` with `CLAUDE_CONFIG_DIR=/accounts/work`.
  - The tool is re-read as `claude`, but the lane's `account` stays `null` instead of `work`.
  - The control "a fresh collector reads the exec'd agent's account" passes on the same files, so the cache alone causes the failure.
- **Impact:** wrong account, and wrong name parts drawn from the environment, for that agent for its whole life.
  - Reached by `export CLAUDE_CONFIG_DIR=…; exec claude` in a pane, or a wrapper that sets the account and `exec`s. A shell's `/proc/PID/environ` never shows later `export`s, but the `exec`'d program's does.
  - `docs/architecture/processes.md` Invariant 2 and `src/collect/process-thread.test.ts` assume that one process identity has one environment, and that assumption is false after `exec`.
- **Smallest fix:** also key the cache entry on the command line, or on the `exe` link, both of which are already read each sample, and re-read `environ` when either changes.

### 7. A watched scope with no readable member shows 0 % CPU and 0 B swap instead of unknown

- **Where:** `src/model/lanes.ts:195-199` (CPU) and `:266-270` (swap). With `group.cpuPercent` or `group.swap` null and no members, `[].every(…)` is true and the sum is 0.
- **Proof:** `review/tests/lanes.test.ts`.
  - "unknown group CPU and swap with no readable member stay unknown" gives `{cpu: 0, swap: 0}`.
  - "end to end: a listed pid that exited before /proc was read leaves CPU unknown" collects a scope listing pid 77 with no `/proc/77`. On that first sample the group has no CPU delta, and the lane draws `0`.
- **Impact:** a number vsys did not read is drawn as zero, against AGENTS.md Conventions. It shows for one sample on a new scope whose process exits between the `cgroup.procs` read and the `/proc` read. Swap shows it on every sample where `memory.swap.current` is missing. Low likelihood, but it breaks the project's first rule.
- **Smallest fix:** use the member sum only when `members.length > 0`, and otherwise keep null.

### 8. An unreadable scratch root shows "0s ago"

- **Where:** `src/collect/scratch-scan.ts:125`. `record()` sets `age: stat ? … : 0`, and the failure path passes no stat. `src/ui/storage-screen.tsx:569-571` falls back to `x.age` when `modifiedAt` is null. The Markdown export writes the same 0.
- **Proof:** `review/tests/storage.test.tsx`, test "an unreadable scratch root shows no age it never read". A configured root that does not exist renders as `…configured-root  ────  not avail…  0s ago  ENOENT: …`.
- **Impact:** an unread age is drawn as "modified just now" beside the error, against AGENTS.md Conventions. This happens for every configured scratch root that is missing or unreadable.
- **Smallest fix:** make `Scratch.age` nullable, or drop it in favour of `modifiedAt`, and draw and export null as not available.

### 9. A scope that has not touched a disk yet shows read and write as unknown instead of 0

- **Where:** `src/collect/cgroups.ts:29`. `ioTotals()` returns null when `io.stat` has no `rbytes`/`wbytes` line.
- **Proof:** `review/tests/collect.test.ts`.
  - "an empty but readable io.stat is zero bytes, not unknown": an empty but readable `io.stat`, with no source error, gives `{ioWrite: null, writeRate: null}` instead of `0`.
  - "a scope's first I/O after an empty io.stat gets a rate": the first sample with I/O has no rate either.
  - The kernel creates a group's per-device `io.stat` line only on that group's first I/O to the device, so a new or quiet scope has an empty, readable `io.stat`.
- **Impact:** quiet agent scopes show Read and Written as not available, so a reader cannot tell a scope that wrote nothing from one vsys could not read. The first write burst after the quiet period gets no rate. Likely on every new scope.
- **Smallest fix:** return zero totals whenever the file was read and parsed. A parse failure already throws.

### 10. Stepping the wall clock backward ends the dashboard

- **Where:**
  - `src/collect/collector.ts:197` stamps each sample with `Date.now()`.
  - `src/store/archive.ts:358-360` throws `Snapshot times must increase`, reached through `History.add`.
  - `src/runtime.ts:181-192` turns any throw in `tick()` into `stop()`.
  - `src/main.ts:152-157` then prints the error and exits.
- **Proof:** `review/tests/settings-history.test.ts`, test "a sample stamped before the previous one does not throw". `History.add` of a sample at `998000` after one at `1000000` throws `Snapshot times must increase`.
- **Impact:** the dashboard exits with `vsys: Snapshot times must increase` when the clock steps back, for example when systemd-timesyncd or chrony steps it after resume, or after `timedatectl set-time`, or a VM clock resync. Low to medium likelihood. A crash, not a wrong reading.
- **Smallest fix:** stamp samples from a clock that never goes backward, such as `max(Date.now(), last + 1)`, or skip a sample whose time is not after the last, instead of throwing.

## Warden

No proven defects in `warden/`, `src/warden.ts` or `data/`. Two log lines from the warden test run look like defects but are test artifacts:

- `task-cap enforcement raised ValueError('not enough values to unpack (expected 3, got 0)')` comes from `warden/agent_warden_status_test.py:516`, `:560` and `:695`, which stub `warn_near_cap` as `lambda: []`. The real function (`warden/agent-warden:1060-1094`) returns a three-element tuple on every path.
- `headroom 0 GiB of 0 GiB` is a stubbed headroom given in bytes.

The following were each checked and rejected:

- PID reuse in moves and reaps: a pidfd is opened, then the start time is re-checked.
- `/proc/PID/stat` parsing with `)` in `comm`.
- Orphan reap with a live launcher.
- Scratch-directory reap of a path still in use, through a symlink, or by traversal.
- Installer overwrite or removal of user files.
