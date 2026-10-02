# Agent warden

Covers: warden/agent-confine warden/agent-confine-lineage-capped warden/agent-warden warden/agent_warden_test.py warden/agent_warden_testlib.py

The agent warden is an optional Python component shipped beside the `vsys` dashboard. The dashboard observes the machine. The warden changes process placement automatically.

[`warden-status.md`](warden-status.md) describes the machine-readable status file that the warden writes for consumers.

## Boundary

- `warden/agent-confine` starts agent harnesses in `agents.slice`, exports `AGENT_CONFINE=1`, exports build caps, and exports `TMPDIR` for scratch discovery.
- `warden/agent-warden` runs as a Python oneshot from a systemd user timer every 30 s in `background.slice`.
- `warden/agent-warden` corrects escaped processes with pidfds and systemd `StartTransientUnit`.
- `warden/agent-warden` never belongs to the dashboard read-only promise. D004 records that split.
- `src/` does not import `warden/`. vsys can observe the processes and cgroups that the warden creates.

## What it moves

The warden moves three process classes into `agents.slice`.

- Escaped launches carry `AGENT_CONFINE=1` but run outside `agents.slice`.
- Unconfined agent CLIs or build tools run outside `agents.slice` and match the classification data in `data/agent-tools.json` plus the local overlay.
- Nested agent sessions share one scope and need a sibling scope so each session gets its own CPU share.

Before a move, the warden opens a pidfd for each process. It re-reads identity, cgroup and classification. It then asks the user systemd manager to create one transient scope with those pidfds. `warden/agent_warden_test.py` and `warden/agent-warden --selftest` cover these planning rules.

## What it leaves alone

A contained job unit is never a move root and never rides along with a moved tree. The default job-unit pattern is `orch-*.service`.

A unit also counts as contained when it is outside `agents.slice` and its own cgroup directory has a real memory, swap, CPU, I/O or cpuset limit. `pids.max` is not enough, because systemd can set a default task limit on every unit.

This rule protects transient validation services such as `orch-validate-vsy-50-12345.service`. The service owns its own process group and time limit. Moving it into an `agent-warden-*.scope` would make the orphan reaper stop a long validation run after the launcher exits. The job-unit rows in `warden/agent_warden_test.py` and `warden/agent-warden --selftest` cover this regression.

## What it caps

The launcher gives each new scope `CPUWeight=99`, `TasksMax=8192` and `MemoryHigh=64G` by default. The non-default CPU weight enables the CPU controller below `agents.slice`; CPUWeight 100 was measured not to enable it. The default per-scope `MemoryHigh=64G` is not a deliberate nested cap even when `agents.slice` has a higher `MemoryHigh`. The warden also caps an unbounded scope it finds under `agents.slice`. `warden/agent_warden_test.py` covers task-cap report mode, capped and plain lineage rows, the default memory-high baseline, and the CPUWeight value. `warden/agent-warden --selftest` covers contained lineage in planning.

The template `warden/systemd/agents.slice` uses percentages for fleet installs: `MemoryHigh=65%` and `MemoryMax=90%`. The owner workstation can keep its tuned absolute values instead.

## What it reaps

The warden reaps only orphaned `.scope` units under `agents.slice`.

A scope is an orphan only when every member has lost its launcher, no member has a controlling terminal, no member is a live agent session and no live external parent still holds it. "Live agent session" reads `Proc.is_named_agent`, D010's comm-only match; `is_agent` gates only the automatic move into `agents.slice`. A `paths`-only install (claude's and codex's native) never satisfies D010, but still protects its scope. A scope named `agent-confine-<pid>-<n>.scope` is not an orphan while `<pid>` is a live member and its parent is outside the scope. A scope named `agent-warden-<pid>-<start>.scope` uses the same rule and also requires the member start time to match. Those rules protect unlisted agent CLIs started through `agent-confine` or adopted by the warden, such as a marked `node server.js`, while their launch root runs. A scope named `agent-warden-build-<pid>-<start>.scope` is not protected by its root, because an adopted build root can still leak leftover work. The reaper waits at least 300 s. It then stops the whole scope only when it is harmful: at least 40 processes or at least 0.5 core on two ticks.

The warden never kills an individual process. It never kills a live session. A scope with a tty, a live agent, a live launch root or a live external parent is not an orphan. The final pre-stop recheck refuses to reap when it cannot enumerate every `cgroup.procs` file that still exists under the scope. The orphan rows in `warden/agent_warden_test.py` and `warden/agent-warden --selftest` enforce this claim, `test_orphan_protection_uses_comm_only_name_match` included.

The warden removes a lane's scratch directory once its scope is gone. `agent-confine` execs `systemd-run` and cannot clean up after its own scope ends, so this pass reuses `enforce_task_caps`'s scope listing and removes any `agent-confine-<pid>-<n>` directory under `AGENT_TMPDIR` whose matching scope is gone. A directory younger than `AGENT_WARDEN_SCRATCH_GRACE` (60 s) survives with no matching scope yet, closing the startup gap before registration. An unreadable scope list is never read as every scope being gone. A gone scope does not prove the directory is free: `move()` relocates a nested session by cgroup membership only, not its environment, so a moved child can keep its parent's old scope's `TMPDIR`. The reap pass resolves both sides with `os.path.realpath` (symlinks included) from a fresh scan taken for this check, not plan()'s earlier one, keeping a directory one resolves inside or is unreadable. Without the warden, these directories stay until removed by hand. `test_reap_scratch_dirs_tmpdir_symlinked_parent` and `test_reap_scratch_dirs_stale_snapshot_misses_a_new_live_pid` cover this.

## Classification data

The shipped classification data is `data/agent-tools.json`. It contains published agent CLI names, mise install directory names, each CLI's install path fragments and executable paths, desktop executable prefixes and bundled CLI suffixes. D010 governs how the warden and the dashboard confirm a name against this data, and why the warden reads a narrower slice of it (a mise install directory, an exact executable path, or a bundled CLI engine under a real, non-`/tmp` desktop prefix, never a `paths` fragment) than the dashboard's display-only match. An unreadable executable keeps the name, because a failed read never hides an escaped agent. The classification rows in `warden/agent_warden_test.py` cover the warden's narrower rule; `src/collect/collector.test.ts` tables the dashboard's own, wider rule.

At startup, the warden first looks beside a checkout at `data/agent-tools.json`. If that file is absent, it looks at `${XDG_DATA_HOME:-$HOME/.local/share}/vsys/agent-tools.json`. If neither file exists, it exits with `agent-tools=missing`.

The local overlay is `$HOME/.config/vsys/agent-tools.json`. It uses the same schema and adds entries. An overlay entry with a name the shipped file lists adds its mise directories to that tool. A missing overlay is normal. A malformed shipped file or overlay exits with `agent-tools=invalid` and names the file. The dashboard reads the same overlay. A diverging hand-written `config.toml` `agentTools` value still replaces the shared list for the dashboard.

D005 records why the dashboard and the warden share this data file. D006 records which Settings saves update the overlay and why they do not pin the layered list.

## Scratch and mise paths

`agent-confine` exports `TMPDIR`; vsys reads it to discover scratch, one root per agent. `AGENT_TMPDIR` overrides the parent path and never changes; default `${XDG_CACHE_HOME:-$HOME/.cache}/agents/tmp`. Each lane gets its own subdirectory under that parent, named after its `--unit` value for `systemd-run --scope`, so deleting one lane's `TMPDIR` cannot reach another's. A non-recursive `mkdir` of mode 700 creates it, only when creating a new scope; an in-use name fails the `mkdir` rather than reusing it. A capped-lineage nested launch, a launch with no user manager, and a failed `mkdir` all keep the inherited `TMPDIR`.

Owners set `AGENT_TMPDIR=$HOME/dev/.scratch/agents` before starting the wrappers, tmux shell or user manager, to keep scratch on the existing subvolume. The warden reads the mise path from `MISE_DATA_DIR`, defaulting to `${XDG_DATA_HOME:-$HOME/.local/share}/mise`; a systemd unit needs it set in `environment.d` when it differs, since it inherits no shell-only value.

`warden/agent_warden_test.py`'s portability rows cover mise and scratch, including `test_agent_confine_and_warden_scratch_parent_agree`, proving the two formulas agree under one environment.

## Tunables

| Variable | Consumer | Default | Effect |
| --- | --- | --- | --- |
| `AGENT_WARDEN_ONLY` | warden | unset | Limits one scan to listed process ids. |
| `AGENT_WARDEN_INTERVAL` | warden | `30` | Seconds between status ticks. Keep it equal to `OnUnitActiveSec` in `warden/systemd/agent-warden.timer`. |
| `AGENT_WARDEN_SPLIT_SESSIONS` | warden | `1` | Splits nested agent sessions when the lineage is not capped. |
| `AGENT_WARDEN_ORPHAN_GRACE` | warden | `300` | Seconds an orphan must stay orphaned before a reap can happen. |
| `AGENT_WARDEN_SCRATCH_GRACE` | warden | `60` | Seconds a scratch directory with no matching scope yet survives a reap tick. |
| `AGENT_WARDEN_REAP` | warden | `1` | Enables orphan reaping. |
| `AGENT_WARDEN_JOB_UNITS` | warden | `orch-*.service` | Whitespace-separated systemd unit patterns left in place. |
| `AGENT_WARDEN_ORPHAN_PROCS` | warden | `40` | Process count that makes an orphan harmful. |
| `AGENT_WARDEN_ORPHAN_CPU` | warden | `0.5` | CPU cores that make an orphan harmful. |
| `AGENT_SCOPE_TASKS_MAX` | both | `8192` | Per-session task ceiling. |
| `AGENT_SCOPE_TASKS_WARN` | warden | `6144` | Per-session task warning threshold. |
| `AGENT_SCOPE_MEM_HIGH` | launcher | `64G` | Per-session soft memory ceiling passed to systemd. |
| `AGENT_SCOPE_MEM_HIGH_BYTES` | warden | `68719476736` | Per-session soft memory ceiling used for warden-created scopes and lineage baseline. |
| `AGENT_SCOPE_MEM_WARN_BYTES` | warden | 75% of `AGENT_SCOPE_MEM_HIGH_BYTES` | Per-session memory warning threshold. |
| `AGENT_TMPDIR` | both | unset | Overrides the scratch parent directory. The launcher creates each lane's subdirectory under it; the warden reads the same value to find which subdirectories to reap. |
| `AGENT_TEST_THREADS` | launcher | `8` | Test-thread cap exported by the launcher. |
| `AGENT_BUILD_JOBS` | launcher | `16` | Build-job cap exported by the launcher. |
| `AGENT_MOLD_JOBS` | launcher | `1` | Mold linker concurrency cap. Empty disables it. |

`AGENT_SCOPE_MEM_HIGH` and `AGENT_SCOPE_MEM_HIGH_BYTES` must name the same size. The launcher reads the systemd size string. The warden reads the byte value for warden-created scopes and for the lineage baseline.

## Notifications

The warden sends desktop notices and retries them per episode for near-cap, headroom and move-failure conditions. [warden-notifications.md](warden-notifications.md) states the heartbeat, episode, logging and `--status` read rules.

## Files and install

`vsys warden install` writes the systemd user units and copies the shared agent-tool list. [warden-install.md](warden-install.md) states the installer rules, the warden directory lookup and the owner workstation migration.

On a fresh install, `agents.slice` can be absent until the first scope enters it. The warden treats an absent slice as empty headroom so the first move can create it. It still fails closed when the slice exists but its memory counters are missing or unparsable.

## Requirements

- Linux with cgroup v2.
- A systemd user manager with CPU, memory and pids delegated below `user@.service`.
- Python 3.9 or newer.
- `libsystemd.so.0`.
- Kernel pidfd support.

## History

The import came from dotfiles commit `a0a3569`.

Dotfiles commits read for the import history:

- `8efd4a8`: `feat: route scratchpad links and confine agents`.
- `29ef1f5`: `sched: drop sched_ext for in-kernel EEVDF; agents cpuset -> CPUWeight`.
- `19d7e04`: `agents: exec shell = bash (SHELL=/bin/bash via agent-confine), skip aliases under CLAUDECODE`.
- `88942a5`: `agents.slice memory caps + client config churn`.
- `9741e20`: `tmux owns its own server; agent scratch off RAM-backed /tmp`.
- `cbf42b0`: `agents: one shim for every CLI, kept ahead of mise on PATH`.
- `e6e99aa`: `build: cache Rust compilation, and own the tmux server without racing a window`.
- `a36e8f4`: `agents: confine by placement, correct by observation, one share per session`.
- `1bc0874`: `agents: bound each lane so one runaway cannot take the fleet down`.
- `5cabb55`: `local-bin: keep Python bytecode out of the stow package`.
- `5069516`: `lane ls: local-time resets, Fable, resets available, cloud credit, --sort reset`.

## Verification

- `python3 warden/agent-warden --selftest` covers classification, planning, job units, orphan rules and scope harm with injected records.
- `python3 -m unittest discover -s warden -p '*_test.py'` covers module loading, classification data lookup, the owner overlay, portability, mutant controls, launcher scratch creation, the job-unit regression and the user installer in `warden/install_test.py`.
- `python3 scripts/ci.py` runs both warden checks before the Bun checks when `warden/` exists.
