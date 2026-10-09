# Cloud defect review 7: the terminal UI

Date: 2026-10-09. Base: `5cb1971` (main). Scope: what the reader sees and can do in `src/ui/`, `src/runtime.ts` and `src/main.ts`.

Every finding below is proven by a test under `review/tests/` that asserts the behaviour the product promises and fails on main. Some files also hold a control test that passes on main, to show the fixture works. The tests use stub snapshots and private temporary directories only.

```sh
# from the repository root
bun test review/tests/
```

On main this gives 4 passing (the controls) and 12 failing (the proofs). `review/tests/README.md` maps each file to its finding.

## Check contract on main

`python3 scripts/ci.py` stops at its first step: one `scripts/` Python test fails. I ran the remaining steps one at a time:

| Step | Result |
| --- | --- |
| `python3 -m unittest discover -s scripts` | 1 failure, root only |
| `python3 -m unittest discover -s warden` | 3 failures, root only |
| `scripts/package_file_list_check.py`, `bun install --frozen-lockfile` | pass |
| `lint`, `typecheck` | pass |
| `test` (`bun test src/`) | 1006 pass, 5 fail, root only |
| `build`, `smoke`, `bench:scratch`, `bench:writes` | pass |

All nine failures come from one cause: this session runs as root (uid 0). Root ignores file modes, so a test that makes a file or directory unreadable or unwritable (with `chmod 000`, `0o500` or `0o555`) and expects the next read, mkdir or removal to fail sees it succeed.

- `scripts/scrub_reporter_test.py`: `test_a_migration_mkdir_failure_is_reported_as_a_carry_over_problem_not_an_install_failure`.
- `warden/agent_confine_test.py`: `test_agent_confine_scratch_mkdir_failure_keeps_inherited_tmpdir` (two subtests).
- `warden/agent_warden_scratch_test.py`: `test_reap_scratch_dirs_read_only_directory_rows`.
- `src/collect/io.test.ts`: "a scrub read binds exact text to its file version and records unavailable versions".
- `src/collect/scratch-scan.test.ts`: "only a root on a list other than the shipped one fails for not existing".
- `src/collect/btrfs.test.ts`: three "an unreadable shipped report …" tests.

I disregarded all of them. No other step failed.

## Findings

They are ordered by impact. A damaged setting comes first, then wrong numbers and wrong states shown to the reader, then layout.

### 1. Settings saves a key binding that no keypress can produce

- **Where:** `src/config/keys.ts:24` (`normalizeKey`), reached from the Settings editor in `src/ui/settings-screen.tsx`.
- **Proof:** `review/tests/unreachable-key.test.tsx`. The test expects the save to be refused and the key to keep working. On main:
  1. Open Settings and find `keys.open`.
  2. Replace `return` with `enter` and press Enter.
  3. The save is accepted: `saved.keys.open === "enter"`.
  4. Press Enter again. Nothing opens (`opened: false`).
- **Why it breaks:** every screen labels this key "Enter" (`keyLabel` in `src/ui/chrome.tsx:23`), so `enter` is the name a reader types. But OpenTUI reports the key as `return`. `normalizeKey` accepts any lowercase word as a key name, so `enter` validates and is saved, and no key event ever matches it.
- **Impact:** Open stops working on every screen. The Settings row that would fix it can no longer be opened from the keyboard, only with the mouse or by editing `config.toml` by hand. The same happens for any action bound to an invented name such as `esc` or `pgdown`. Likelihood is moderate: the label every footer shows invites this exact value.
- **Smallest fix:** in `normalizeKey`, accept a multi-letter key name only if it is in the set of names OpenTUI emits, and map the labels a reader sees (`enter`, `esc`) to `return` and `escape`.

### 2. Home states "0 agents · nothing needs attention" when no process was read

- **Where:** `src/ui/home.tsx:559`.
- **Proof:** `review/tests/agent-count.test.ts`. The sample has `processRead: "unknown"`, no processes and a `/proc` source error, which is what the collector publishes when the process read misses its deadline (`src/collect/collector.ts:234`). The footer of the same frame says `1 sources unreadable`, and the Builds tile says `not available`, yet Home draws:

  ```
  Healthy
  0 agents · 8 cores · nothing needs attention
  ```

- **Why it breaks:** without process data, `lanes()` builds no lane for an escaped agent. Where the agent slice is not compared, it builds no lane for any agent at all (`agentLane` in `src/model/lanes.ts`). The count line prints `s.lanes.length` as a fact anyway.
- **Impact:** on a stalled `/proc` read, or a late read that blocks the next samples, Home shows an empty, healthy machine while agents run. This is a zero for a reading vsys could not take, which AGENTS.md forbids. Likelihood: whenever the process read times out, which is the case D008 exists for.
- **Smallest fix:** draw the agent count only when `processesComplete(s)`, and otherwise write `gap` (or "at least N").

### 3. Agent detail says "No scratch file is open" for files in the agent's own temporary directory

- **Where:** `src/ui/agent.tsx:291-302`, which calls `scratchFiles(reader, c, lane.pids)` (`src/collect/procs.ts:469`).
- **Proof:** `review/tests/open-files.test.tsx`. In a stand-in `/proc`, process 40 holds `…/cache/agents/tmp/agent-confine-40/rustcXYZ/lib.rlib` open, and its `TMPDIR` names that directory. Opening Agents → Enter → Open files draws `No scratch file is open.` The control test in the same file lists the file once `scratchDirs` names the directory.
- **Why it breaks:** `scratchFiles` matches descriptors against `c.scratchDirs` alone. The roots Storage measures also include the temporary directories running agents name (`scratchRoots()` and `agentScratchDirs()` in `src/collect/scratch.ts`; layers.md, "Do measure as scratch …"). `agent-confine`, the launcher the warden ships, gives every lane its own `TMPDIR` under `~/.cache/agents/tmp`, and the shipped `scratchDirs` does not include that path.
- **Impact:** every agent started through `agent-confine` is shown holding no scratch file while Storage measures its scratch root. The reader is told there is nothing to clean up. Likelihood: high for warden users.
- **Smallest fix:** match descriptors against the same roots the scan uses: `scratchRoots(c.scratchDirs, agentScratchDirs(snapshot.procs))`.
- **Related:** the effect depends on `lane.pids`, which is a new array on every sample. So the detail re-reads every member's `/proc/PID/fd` on the dashboard thread once a sample, even with Open files closed. `procs.ts:468` says "read only on demand", and layers.md says "Never read a process file on the dashboard thread". Moving the read behind `open.has("Open files")` fixes both.

### 4. Resources calls a group with no readable threshold input "nothing over a threshold"

- **Where:** `src/ui/resources.tsx:157-197` (`groupCause`, `causeText`, `groupLevel`).
- **Proof:** `review/tests/group-status.test.ts`. A group with `memory: null` and every pressure `null`, which is what `collectGroups` stores for unread files, draws `Status      nothing over a threshold`, and its row is coloured ok.
- **Why it breaks:** `groupCause` skips every null input and returns `null`. `causeText(null)` treats that as a judgement that passed.
- **Impact:** on a kernel booted with `psi=0`, or where the pressure files of a group are unreadable, every group says it crossed no stall threshold although none was measured. That is an unknown drawn as healthy (layers.md: "grade a meter whose input is null as a warning, never as untroubled"). Likelihood: low to moderate, but certain on a PSI-less kernel.
- **Smallest fix:** when a pressure the thresholds need is null, return an unread status worded with `gap` and level `warn` instead of `null`.

### 5. Builds draws "Processes in lane-a 0" under a row that reads "not available"

- **Where:** `src/ui/builds-screen.tsx:317`.
- **Proof:** `review/tests/builds-unknown-count.test.tsx`. With `processRead: "incomplete"` and a lane whose `builds` is null, the lane row's Building cell draws `not available`. Opening it draws `Processes in lane-a  0 ───…`.
- **Why it breaks:** the heading count is `procs.length`, the number of processes vsys did read. That count is meaningless while the row's own count is unknown.
- **Impact:** the drill-down contradicts the row above it and tells the reader the lane builds nothing. `lanes.ts` makes `builds` null whenever one pid in the lane's tree went unread, which a short-lived compiler racing the read does often. Likelihood: moderate during builds.
- **Smallest fix:** when `current.builds === null`, pass `gap` as the section count instead of `procs.length`.

### 6. Storage's "Filesystems" heading counts mounts

- **Where:** `src/ui/storage-screen.tsx:851`.
- **Proof:** `review/tests/storage-count.test.tsx`. `/` and `/home` are subvolumes of one Btrfs filesystem (one fsid). `volumesByDevice` returns one group, and the screen draws one filesystem row marked `2 mounts`, but the heading reads `f Filesystems  2`.
- **Why it breaks:** the count is `st.volumes.length`, the number of mounts. The rows under it are filesystems.
- **Impact:** a wrong count on the most common Btrfs layout, where root and home are subvolumes of one filesystem. Every such install shows it. Likelihood: high on Btrfs.
- **Smallest fix:** count `volumesByDevice(st.volumes).length`.

### 7. The agent detail shows "make jobs not set" when the environment was not read

- **Where:** `src/ui/agent.tsx:552`, fed by `jobserver()` (`src/model/naming.ts:57`).
- **Proof:** `review/tests/unread-env-limits.test.tsx`. The leading process has `envAvailable: false`. The Limits line draws `make jobs not set · jobserver not set`, while the Launch section of the same screen draws `Environment  not available`. The control test shows the same words where the environment was read and the variable is absent. The third test shows that `jobserver()` returns the same `{ jobs: null, jobserver: null }` for both cases, so the screen cannot tell them apart.
- **Impact:** a lane whose `/proc/PID/environ` could not be read is reported as running make with no job limit and no token pool. That is a definite, wrong statement made from a read that failed. The lane's account in the same data is kept unknown for exactly this reason (`types.ts`, `Lane.account`). Likelihood: low; it needs an unreadable environ, such as a non-dumpable process or a read race.
- **Smallest fix:** when `proc?.envAvailable === false`, write `gap` for make jobs and the jobserver in the UI. Or have the model carry the unread state beside the two nulls.

### 8. The footer cuts the machine's standing at 80 columns

- **Where:** `src/ui/chrome.tsx:260-279` (`Footer`).
- **Proof:** `review/tests/footer-status.test.ts`, on Home with one concern:
  - At 80 columns the footer ends in `y copy  ? 1 co`.
  - At 60 it ends in `o hold 1`.
  - At 90 it reads `? keys1 concern`, with no gap.
  - At 120 it is whole; that case is the passing control.
- **Why it breaks:** the status `Line` is `flexShrink={0}`, but the hints `Line` beside it keeps its intrinsic width and is never shrunk. The status is clipped at the screen edge instead, and nothing separates the two.
- **Impact:** the footer status is the one line that says how the machine stands from every screen ("1 concern", "all clear", "3 sources unreadable", the retention warning). In the classic 80-column terminal it is cut to a fragment. Likelihood: high for anyone at 80 to 100 columns.
- **Smallest fix:** give the hints `Line` `flexShrink={1} minWidth={0}`, and put two blanks before the status.

### 9. Settings shows an interval of 90 seconds as "1m"

- **Where:** `src/ui/settings.ts:594-600` (`interval`).
- **Proof:** `review/tests/setting-display.test.ts`. `validate()` accepts both of these values:
  - `settingDisplay("scratchRefreshMs", 90000, c)` returns `1m`.
  - `settingDisplay("refreshMs", 3599000, c)` returns `59m`.
- **Why it breaks:** from one minute up, `interval()` falls back to `age()`, which floors to whole minutes.
- **Impact:** the value shown is shorter than the value in effect, by up to 59 seconds. Likelihood: low; it needs a non-default interval that is not a whole number of minutes.
- **Smallest fix:** below an hour, write minutes and seconds (`1m 30s`), or keep the `toFixed(1)` treatment the seconds branch uses.

### 10. Settings reads "Watched Btrfs mounts: none" when every Btrfs mount is watched

- **Where:** `src/ui/settings.ts:610`.
- **Proof:** `review/tests/setting-display.test.ts`. `settingDisplay("btrfsMounts", [], c)` returns `none`, and `[]` is the shipped default. The collector treats an empty list as "watch every Btrfs mount" (`src/collect/btrfs.ts:452`), and the setting's own help text says so.
- **Impact:** every default install lists the setting as watching nothing. The help line contradicts it only while that row is selected. Likelihood: certain on defaults; the harm is limited to a misread setting.
- **Smallest fix:** give `btrfsMounts` its own empty-list wording, such as `every Btrfs mount`, in `settingDisplay`.

## Proven but left out for the ten-finding limit

These have failing proofs in the helper reviewers' scratch files. They are lower impact than the ten above, and their tests are not committed.

- **Storage and Builds rows are cut at the screen edge with no cut mark.**
  - Storage drops the unit of a reading at 66 to 70 columns (`4.7`, `2.`) and drops the reading entirely at 60. The cause is fixed 40- and 42-cell paths in `storage-screen.tsx:656` and `:734`.
  - Builds loses the count below 45 columns.
- **The Help overlay is not clamped to the terminal.** At 80x24 its first rows are cut, and below 67 columns the key column falls off the left edge (`chrome.tsx` `Help`).
- **The narrow header's tab row neither wraps nor shrinks.** At 60 columns `7 Settings` is not drawn.
- **On Timeline, the right arrow skips the oldest sample** when the cursor sits before it (`timeline-screen.tsx:151-157`).
- **The text editor's title names the Open key as the save key**, as in "Space saves", but only Enter submits (`settings-screen.tsx:512`).
- **Small display inconsistencies:**
  - `blockedText` writes "waiting on not available" for stall shares that were read as zero.
  - Stacked Home overruns its busiest-agents rows.
  - `percent()` draws `?` rather than `not available` for a null in a few places.
  - A scratch card lands on a mount row that has the same path.
  - The Markdown export lists `HugePages_*` page counts under a `Bytes` heading.

## Checked and not reported

- **The lane action confirm flow.** `act()` refuses an action while a sample is pinned or write mode is off. The confirmation intercepts every key. `resolveIntent()` rebuilds the command against the current sample and compares the confirmed line. A mouse click while the dialog is open replaces the dialog with the new intent, which the reader then sees. I found no route where an action runs against something other than what the dialog showed.
- **Selection after rows change** (`useSelection`, `heldOrder`) on Agents, Builds and the agent detail. It follows identity correctly.
- **Self-scaled sparklines.** A flat 2% stall draws as full-height bars. That is the design of a relative sparkline, not a defect I can hold to a rule.
- **The Agents list's "Wait" column.** It shows CPU pressure only, which `lanes.ts:499` documents as intended.
