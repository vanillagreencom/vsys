# vsys-view: fleet and system observability TUI

Status: plan, 2026-09-06. Owner: method. Private repo.

## Why

On 2026-09-06 twelve agent lanes ran on this box while the root filesystem went
read-only. Nothing showed, at a glance, which lane was doing what, which scopes
had escaped `agents.slice`, that five interactive `claude` sessions were running
unconfined in `app.slice`, that one lane was looping a test binary under a 5 MB
memory cap, or that the dev drive's corruption counter was climbing. Every one of
those facts sat in a sysfs or procfs file readable without root. vsys-view is the
screen that reads them, keeps history, and makes the answer obvious.

Design rule: the tool observes. It never kills, renices, or edits anything.

## Stack

- OpenTUI (`@opentui/core` + `@opentui/react`) on Bun. TypeScript throughout.
  OpenTUI is Bun-only (Zig core over Bun FFI), so the language question is
  settled by the framework choice. Flexbox layout, mouse support, no frame cap.
- Collector: plain TypeScript reading `/sys/fs/cgroup`, `/proc`, `/sys/fs/btrfs`,
  `/proc/pressure`, `/proc/meminfo`. No native module, no root. Everything the
  collector needs was verified readable as the user on this box.
- History: in-memory ring buffers per series, plus optional SQLite persistence
  through `bun:sqlite` so history survives restarts and a stall can be replayed.
- Optional privileged extras (SMART unsafe-shutdown counters, `btrfs device stats`)
  come through a tiny polkit-free path: a systemd system timer already writes
  scrub results to `/run/btrfs-scrub`; vsys-view reads those files, never sudo.

## What it must answer (from the incident)

1. Where is CPU going right now: agents slice vs desktop vs each lane.
2. Is any lane starved: per-scope `cpu.pressure`, memory pressure, io pressure.
3. Who is building: `rustc`, `cargo`, `ld`/`lld`, test binaries per scope, with
   thread counts (the 65-thread test binary case).
4. Which agent processes run OUTSIDE `agents.slice` (unconfined), and what
   launched them (parent chain, absolute path vs shim).
5. Which scopes carry a dangerous MemoryMax (below a threshold, default 1G):
   the `systemd-run -p MemoryMax=5M` loop that took root read-only.
6. Memory: slice usage vs `memory.high`/`memory.max`, swap, zram, per lane RSS.
7. Storage: every btrfs mount's `ro` flag, `error_stats` deltas, scrub results,
   scratch directory sizes, free space per volume.
8. History: all of the above as time series, so "what happened at 17:56" has an
   answer the next morning.

## Screens

Global layout: a top bar (host, load, agents/desktop CPU split, memory, alerts
count), a left rail of views, a main panel, a bottom key hint line.

### 1. Fleet (default)
Table of every scope under the watched slices. Columns (toggleable):
lane name, account (`CLAUDE_CONFIG_DIR` basename), cwd/worktree, branch,
tool (claude/codex/pi/opencode/...), CPU %, CPU pressure, RSS, swap,
tasks, rustc/cargo/test-binary counts, age, state. Sort by any column.
Row colour: normal; amber when pressure > threshold; red when unconfined or
memory-capped below floor. Enter opens the Lane detail.

### 2. Lane detail
Header with the scope's cgroup path, main pid, launch command, env of interest
(TMPDIR, CLAUDE_CODE_TMPDIR, CARGO_BUILD_JOBS, RUST_TEST_THREADS, SHELL).
Process tree with per-process CPU, threads, RSS, cwd. Sparkline history of CPU,
memory, pressure for the selected window. Open files under scratch dirs.

### 3. Slices
Tree of `user@1000.service`: `agents.slice`, `app.slice`, `session.slice`,
`background.slice`. For each: `cpu.weight`, `cpu.max`, `memory.high/max/current`,
`memory.swap.max/current`, `pids.max/current`, pressure. Shows the effective
share: agents 25 vs desktop 100 means a one-fifth floor under contention.
Highlights any `run-*.scope` in `app.slice` whose command is an agent tool or
whose `memory.max` is below the floor.

### 4. Builds
Everything compiler-shaped across the machine: rustc, cargo, cc, ld, lld,
mold, tsc, bun, node build workers, test binaries under `target/`. Grouped by
scope, with thread counts, RSS, cwd, elapsed. Shows the sum of build jobs vs
core count so oversubscription is visible.

### 5. Storage
Per btrfs mount: device, ro flag, options (compress, nodatacow), free space,
`error_stats` (write/read/flush/corruption/generation) with deltas since the
last sample and since start; last scrub result from `/run/btrfs-scrub`;
scratch dir sizes (`~/dev/.scratch/{agents,claude}`, `/var/tmp/claude`);
per-session scratch directories with age and size, so pruning is informed.

### 6. Timeline
Full-width charts over the selected window (5 min to 24 h): agents vs desktop
CPU, memory, pressure, btrfs corruption counter, unconfined-agent count,
build job count. Cursor to scrub through time; the Fleet table can be pinned
to the cursor time to show "who ran what then". Alert markers on the axis.

### 7. Alerts
Log of rule hits with timestamps: unconfined agent appeared, scope below
memory floor, btrfs ro, error counter grew, scrub problem, slice near
`memory.high`, pressure above threshold for N seconds, scratch over quota.
Optional desktop notification per rule through `notify-send`.

## Settings menu (persisted to `~/.config/vsys-view/config.toml`)

- Refresh interval (default 1 s) and history length (default 24 h, ring size).
- Persistence on/off and SQLite path.
- Watched slices (default `agents.slice`, `app.slice`) and the cgroup root.
- Agent tool names (default claude, codex, pi, opencode, gemini, copilot, grok,
  agy, crush, dsh) for unconfined detection.
- Memory floor for the "dangerous cap" rule (default 1 GiB).
- Pressure thresholds (amber, red) and hold time.
- Lane naming: how to derive the lane name (worktree dir, branch, env var).
- Scratch directories to size and the size quota.
- btrfs mounts to watch (default: all) and the scrub result directory.
- Column visibility and order per table; default sort.
- Theme (respects terminal palette; light/dark presets), sparkline style
  (braille / block), units (binary/decimal).
- Notifications on/off per rule.
- Keybindings (vim-style defaults, editable).

## Portability

cgroup v2, `/proc` and `/sys/fs/btrfs` are Linux-generic. Machine-specific
knowledge is all configuration: slice names, agent tool names, scratch paths,
scrub result path. A different box with a different slice layout runs it with a
different config and no code change. Non-btrfs hosts simply get an empty
Storage view section.

## Architecture

```
src/
  collect/      one module per source, each returns a typed snapshot
    cgroups.ts  walk cgroup tree: stats, pressure, limits, procs
    procs.ts    per-pid: comm, cmdline, cwd, env subset, threads, RSS
    builds.ts   classify processes as build/test work
    btrfs.ts    mounts, error_stats, scrub results, scratch sizes
    system.ts   loadavg, meminfo, zram, pressure
  model/        snapshot -> lanes, slices, alerts; rules engine
  store/        ring buffers, optional SQLite, query by window
  ui/           OpenTUI React components: views, tables, charts, settings
  config/       load/validate/save TOML, defaults, keybindings
  main.ts       scheduler: collect every N s, apply rules, render
```

Collection cost target: under 20 ms per tick for 50 scopes and 2000 processes,
measured; reading `/proc/<pid>/environ` only for scope main pids, cached by pid
start time.

## Phases

1. Collector + Fleet + Slices views, config file, 1 s refresh. Usable in a day.
2. Builds and Storage views, alerts engine, notify-send.
3. History store, Timeline view, SQLite persistence.
4. Lane detail, settings menu UI, keybinding editor, theme presets.
5. Polish: mouse, export snapshot to JSON/markdown for incident reports,
   `vsys-view --once` for scripting.

## Open questions

- Whether to show the 12-lane fleet as one table or grouped by account.
- Whether alerts should be able to run a user hook script (observe-only rule
  says no by default; maybe an opt-in for `notify-send`-style side effects only).
- SMART counters need root; decide between a system timer writing to `/run`
  (matches the scrub pattern) or leaving them out.
