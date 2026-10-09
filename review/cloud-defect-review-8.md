# Cloud defect review 8

Scope: the numbers vsys reads and computes in `src/collect/`, `src/model/` and `src/config/`, reviewed at `5cb1971` on 2026-10-09. No product code changed.

Six findings, ordered by impact. Each has a failing test under `review/tests/` that drives the real reader or model function. Run them all from the repository root:

```sh
bun test review/tests/
```

Each test asserts the correct value, so each one fails on `5cb1971`. In `btrfs-readonly.test.ts`, the second test is a control and passes.

## Check contract on main

I ran `python3 scripts/ci.py` once before starting. It stopped at its first step. I then ran the remaining steps one by one with the same commands `main()` runs:

| Step | Result |
|---|---|
| `python3 -m unittest discover -s scripts` | 1 failure, caused by root (below) |
| `python3 -m unittest discover -s warden` | 3 failures, caused by root (below) |
| `scripts/package_file_list_check.py`, `bun install --frozen-lockfile` | pass |
| `lint`, `typecheck`, `build`, `smoke`, `bench:scratch`, `bench:writes` | pass |
| `bun run test` | 1006 pass, 5 fail, caused by root (below) |

Every failure comes from this session running as root (uid 0). Root ignores file modes, so a fixture made unreadable or read-only with `chmod` is still read or written:

- `scripts/scrub_reporter_test.py`: `test_a_migration_mkdir_failure_is_reported_as_a_carry_over_problem_not_an_install_failure`. Root can create a directory inside the mode-0555 parent.
- `warden/agent_confine_test.py`: `test_agent_confine_scratch_mkdir_failure_keeps_inherited_tmpdir` (two subtests). `warden/agent_warden_scratch_test.py`: `test_reap_scratch_dirs_read_only_directory_rows`. Both rely on a read-only directory.
- `src/collect/io.test.ts`: `a scrub read binds exact text to its file version and records unavailable versions`, which reads a mode-000 file. `src/collect/scratch-scan.test.ts`: `only a root on a list other than the shipped one fails for not existing`. Three `src/collect/btrfs.test.ts` tests built on an unreadable shipped report: `... prevents Healthy at startup`, `... at replacement`, and `... stays unassociated after mount reuse`.

I ignored these, as the brief says.

---

## 1. A Btrfs mount made read-only by design reads as a filesystem the kernel forced read-only

- **File:** `src/collect/btrfs.ts:38`, together with `src/collect/mounts.ts:40-42`.
- **Proof:** `review/tests/btrfs-readonly.test.ts`, test `a mount made read-only by design is not a filesystem forced read-only`. The input is mountinfo from Fedora Atomic on Btrfs:
  - `/sysroot` and the `/usr` bind mount carry per-mount `ro`.
  - Their superblock options after ` - ` are `rw`, because `/var/home` on the same filesystem is written.
  - Expected `readOnly`: false for all three mounts. Actual: `[["/sysroot", true], ["/usr", true], ["/var/home", false]]`.
  - The control test (superblock `ro`, per-mount `rw`) still reads true, as it should.
- **Why it happens:** `parseMounts` merges the per-mount and superblock option lists into one set. `btrfsMounts` then sets `readOnly` from `options.includes("ro")`. When Btrfs forces a filesystem read-only after an error, the kernel sets `SB_RDONLY`. That shows in the superblock options. A per-mount `ro` (a read-only bind mount or `mount -o ro,bind`) does not mean the filesystem is read-only.
- **Impact:** The default `btrfsMounts = []` watches every Btrfs mount. On every Fedora Atomic (Silverblue, Kinoite) install on Btrfs, and on openSUSE MicroOS/Aeon, vsys shows a permanent danger card: "2 mounts are read-only … check the kernel log for the error that forced the mount read-only" (`src/ui/attention.ts:297-302`). It also raises the `btrfs-ro` alert and notification, adds a timeline entry, and marks Storage rows read-only. The filesystem is healthy and writable. This happens on every sample on those installs. The danger card also hides a real forced read-only event under one that is always on.
- **Smallest fix:** Keep the superblock options apart in `parseMounts` (for example a `superOptions` field). Set `readOnly` from the superblock `ro` alone.

## 2. A member that exits between the `cgroup.procs` read and the process walk blanks the lane's totals, and the Builds rows stop matching the fleet total

- **File:** `src/model/lanes.ts:268-270`, the `complete` predicate. Its effects are at lines 384-432 and in `buildRow` at `src/model/builds.ts:72-73`.
- **Proof:** `review/tests/exited-member.test.ts`, test `a member that exited before the process walk leaves the lane's totals known`.
  - Setup: a scope's `cgroup.procs` lists 40, 41 and 42. Process 41 is `rustc`. Process 42 has no `/proc` entry, because it exited before the walk.
  - The real `Collector` reports `processRead: "complete"` and no source errors. That is correct: every existing process was read.
  - Actual: `buildLoad().builds = 1`, but the lane's Builds row reads `builds: null`. `rustc`, `rss` and `age` are all `null`, and `state` is `"unknown"`.
  - Expected: row builds 1, rustc 1, rss 81920, a known age, state `sleeping`.
- **Why it happens:** For a lane with a group, `complete` requires every pid in every descendant group's `cgroup.procs` to be in the process walk. `ProcessCollector.read` correctly drops a pid whose `/proc` files return ENOENT or ESRCH, because the process is gone and that is not a failed read. The model then treats the missing pid as an unread member. Real read failures already make `processRead` `"incomplete"` (`src/collect/procs.ts:432-435`). Hidden processes do too. So a pid that exited is the only thing the membership test catches.
- **Impact:** The gap between the two reads covers the rest of the cgroup walk, the thread round trip and the whole `/proc` walk: tens to hundreds of milliseconds. An agent lane runs a stream of short commands (git, rg, ls, test binaries), and a `cc`/linker-heavy build exits several processes per second. So on a busy lane most samples blank memory, age, state, blocked, rustc/cargo/tests, linkers and sccache on Agents. The Builds screen then shows a lane row as unknown while the Home meter and the Builds total count that lane's compilers. That breaks the rule that per-lane rows sum to the fleet total (`docs/architecture/layers.md`, `compileOrLink`). Likelihood: high on any active lane. `src/model/lanes.test.ts:283` (`"one unread member"`, which passes `processRead` complete) pins the current behaviour, so the fix changes that row.
- **Smallest fix:** For a lane with a group, decide `complete` from `processRead === "complete"`, as group-less lanes already do. Or have the process reader return the pids it found exited, and leave only those out of the membership test.

## 3. CPU and I/O rates divide by wall-clock time, so a clock step multiplies or flattens every rate

- **File:** `src/collect/collector.ts:270` and `:286`, where `time = Date.now()` and `elapsed = time - previous.time`. The same applies to `src/collect/procs.ts:229`, which uses `request.time`. `src/runtime.ts:198` and `src/main.ts:92` call `sample()` with no time.
- **Proof:** `review/tests/clock-step.test.ts`, test `a backward wall-clock step does not multiply cgroup rates`.
  - Setup: one real second passes (the monotonic clock advances 1000 ms). The scope burns one core and writes 100 MB. The wall clock steps back 900 ms during that second.
  - Actual: group CPU 1000 %, lane CPU 1000 %, process CPU 1000 %, write rate 1 000 000 000 B/s.
  - Expected: 100 %, 100 %, 100 % and 100 000 000 B/s.
  - A forward step does the opposite: a busy lane reads near zero. The pressure alert hold (`src/model/alerts.ts:59-64`) is also measured in wall time, so a forward step opens a pressure alert after a single sample.
- **Impact:** For one sample, the Agents table, the busiest lane, the charts and the stored history show a spike several times the machine's capacity, or a dip. The spike stays in the retained day. Likelihood: low but real. systemd-timesyncd steps the clock when the offset passes its slew limit, which is common after resume from suspend, and chrony steps at start.
- **Smallest fix:** Measure the interval with `performance.now()`, recorded beside each sample and each process reading, and keep `Date.now()` only as the timestamp.

## 4. The memory meter is stuck at warning on a host with no desktop slice

- **File:** `src/model/verdict.ts:744`, with `:778`.
- **Proof:** `review/tests/model-unread.test.ts`, test `memory meter agrees with desktop-swap cause when the desktop slice is absent`.
  - Setup: `groups` holds no `app.slice`.
  - `causes()` raises no `desktop-swap`, and `unjudged()["desktop-swap"]` is undefined, because there is nothing to judge.
  - Actual: `meters()` grades memory `"warn"`. Expected: `"ok"`.
- **Why it happens:** `sliceSum(..., c.desktopSlice, g => g.swap)` returns null when the slice has no group. `gauge(null)` is a warning, under the rule that an unread input warns. But this input is absent, not unread, and the cause it mirrors treats it that way (`src/model/verdict.ts:384`).
- **Impact:** On a headless agent host, or wherever `desktopSlice` names a slice that is not running, the Home memory meter is amber on every sample. Nothing explains it and no cause sits behind it. The `--once --summary` JSON scripts read reports `memory: "warn"`. Likelihood: medium on headless or non-default hosts, none on a stock desktop session.
- **Smallest fix:** Grade the memory meter on swap only when `sliceRoots(s.groups, c.desktopSlice)` is non-empty, the same condition the cause uses. Otherwise grade it `ok`.

## 5. One unread reading closes a scratch, memory-cap or pressure alert, which then notifies again

- **File:** `src/model/alerts.ts:38-45` (memory-cap), `:55-68` with `:101-102` (pressure), and `:83-89` (scratch).
- **Proof:** `review/tests/model-unread.test.ts` holds three tests, one per rule:
  - `scratch notification does not repeat after one failed scan`
  - `memory-cap notification does not repeat after one failed memory.max read`
  - `pressure notification keeps its hold through one unread pressure file`

  Each one opens the alert, feeds one sample whose reading is unread, then feeds the same over-threshold reading again. `unjudged()` reports the subject unread, and the timeline (`EventLog`) keeps that alert open. Each test expects no new alert on the third sample. The engine returns the rule again: a second desktop notification and a second `alerts[]` entry. For pressure, the hold restarts, so the repeat comes `pressureHoldSeconds` later.
- **Why it happens:** Only memory-high keeps an active key while its reading is unjudged (`src/model/alerts.ts:48`). The other three drop out of `next` whenever their condition is not proven true.
- **Impact:** A reader who turned on these notifications gets a duplicate desktop notification for a condition that never cleared. `alerts[]` in `--once` also disagrees with the timeline, which `docs/architecture/history.md` says keeps an alert on an unread subject open. Scratch is the likely case. `scanRoot` fails the whole root when a directory leaves mid-walk (`src/collect/scratch-scan.ts:144-147`, `:180`). Agents' temporary trees churn constantly, and the duty-cycle rests stretch a scan out.
- **Smallest fix:** As memory-high does, carry an active key into `next` when that subject's reading is unread: scratch `bytes === null`, a lane with `memoryMaxKnown === false`, or a group pressure entry that is null. For pressure, keep `pressureSince` while the reading is unread.

## 6. Unit names with a non-ASCII character decode as mojibake

- **File:** `src/model/naming.ts:125-129`, `unescapeUnit`.
- **Proof:** `review/tests/unit-label.test.ts`.
  - `systemd-escape 'café'` prints `caf\xc3\xa9` on this host. systemd escapes each byte of a UTF-8 character separately.
  - `unitLabel("app-niri-caf\\xc3\\xa9-1234.scope")` returns `"cafÃ©"`. Expected: `"café"`. `run-r\xc3\xa9sum\xc3\xa9.service` fails the same way.
- **Why it happens:** Each `\xNN` becomes one `String.fromCharCode` code point, which reads the bytes as Latin-1.
- **Impact:** A lane named from its unit (the fallback in `lanes.ts:338`) or a cause naming a consumer (`consumerName`) shows garbled text, including in `alerts[].message`. Likelihood: low, because desktop app IDs are ASCII, but any unit a reader names with `systemd-run --unit=` in their own language hits it.
- **Smallest fix:** Collect the escaped bytes into a `Uint8Array` and decode them with `TextDecoder("utf-8")`. Do not map each byte to a character.

---

## Checked and not reported

- **The cgroup readers** (`cpu.stat`, `memory.*`, `pids.*`, `io.stat` with extra keys such as `dbytes` and `cost.*`, PSI with and without a `full` line): no defects found. A cgroup recreated at the same path loses its baseline through the inode identity (VSY-184). A counter that goes backwards gives a null rate, never a negative one.
- **The procfs readers** (`stat` with spaces and parentheses in `comm`, `status` VmSwap, `meminfo`, `loadavg`, `uptime`, zram `mm_stat`, mountinfo octal escapes): no defects found. A pid reused between samples is caught by its start time.
- **Settings validation** (`validate()`): every numeric range the Settings help states is enforced. TOML `nan` and `inf` are refused, as are relative paths, slice names, unknown keys and clashing keys.
- **Slice writes:** Storage's "Written since boot" by slice comes from each slice cgroup's own `io.stat`. That counter starts when the cgroup is created, for example when the user manager restarts. I left this out as a wording question about the heading, not a wrong reading.
