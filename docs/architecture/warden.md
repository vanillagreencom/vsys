# Agent warden

Covers: warden/agent-confine warden/agent-confine-lineage-capped warden/agent-warden warden/agent_warden_test.py warden/agent_warden_settings_test.py warden/agent_warden_status_test.py warden/agent_warden_testlib.py

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

This rule protects transient validation services such as `orch-validate-vsy-50-12345.service`. The service owns its own process group and time limit. Moving it into an `agent-warden-*.scope` would make the [orphan reaper](warden-reaper.md) stop a long validation run after the launcher exits. The job-unit rows in `warden/agent_warden_test.py` and `warden/agent-warden --selftest` cover this regression.

## What it caps

The launcher gives each new scope `CPUWeight=99`, `TasksMax=8192` and `MemoryHigh=64G` by default. The non-default CPU weight enables the CPU controller below `agents.slice`; CPUWeight 100 was measured not to enable it. The default per-scope `MemoryHigh=64G` is not a deliberate nested cap even when `agents.slice` has a higher `MemoryHigh`. The warden also caps a scope under `agents.slice` whose task cap is `max`, or above `AGENT_SCOPE_TASKS_MAX` and at or above a numeric slice `pids.max`, unless `AGENT_SCOPE_TASKS_MAX` is `infinity`. `test_task_cap_tick_rows` covers the cap rule, and `test_task_cap_rows` in `warden/agent_warden_settings_test.py` covers `infinity`. `warden/agent_warden_test.py` covers task-cap report mode, capped and plain lineage rows, the default memory-high baseline, and the CPUWeight value. `warden/agent-warden --selftest` covers contained lineage in planning.

The template `warden/systemd/agents.slice` uses percentages for fleet installs: `MemoryHigh=65%` and `MemoryMax=90%`. The owner workstation can keep its tuned absolute values instead.

## What it reaps

The warden reaps orphaned scopes under `agents.slice` and the scratch directories of scopes that are gone. [warden-reaper.md](warden-reaper.md) states when a scope is an orphan, when it is harmful enough to stop, and when a scratch directory is free to remove.

## Classification data

The shipped classification data is `data/agent-tools.json`. It contains published agent CLI names, mise install directory names, each CLI's install path fragments and executable paths, desktop executable prefixes and bundled CLI suffixes. D010 governs how the warden and the dashboard confirm a name against this data, and why the warden reads a narrower slice of it (a mise install directory, an exact executable path, or a bundled CLI engine under a real, non-`/tmp` desktop prefix, never a `paths` fragment) than the dashboard's display-only match. A tool located only by `paths` fragments is not trusted by name alone: the warden moves it as a bundled CLI engine, by name when its executable cannot be read, or under D010's escaped-launch rule. A mise or exact-executable match under a desktop prefix is the agent, not the desktop app. An unreadable executable keeps the name, because a failed read never hides an escaped agent. The classification rows in `warden/agent_warden_test.py` cover the warden's narrower rule; `src/collect/collector.test.ts` tables the dashboard's own, wider rule.

At startup, the warden first looks beside a checkout at `data/agent-tools.json`. If that file is absent, it looks at `${XDG_DATA_HOME:-$HOME/.local/share}/vsys/agent-tools.json`. If neither file exists, it exits with `agent-tools=missing`.

The local overlay is `$HOME/.config/vsys/agent-tools.json`. It uses the same schema and adds entries. An overlay entry with a name the shipped file lists adds its mise directories to that tool. A missing overlay is normal. A malformed shipped file or overlay exits with `agent-tools=invalid` and names the file. The dashboard reads the same overlay. A diverging hand-written `config.toml` `agentTools` value still replaces the shared list for the dashboard.

D005 records why the dashboard and the warden share this data file. D006 records which Settings saves update the overlay and why they do not pin the layered list.

## Scratch and mise paths

`agent-confine` exports `TMPDIR`; vsys reads it to discover scratch, one root per agent. `AGENT_TMPDIR` overrides the parent path and never changes; default `${XDG_CACHE_HOME:-$HOME/.cache}/agents/tmp`. Each lane gets its own subdirectory under that parent, named after its `--unit` value for `systemd-run --scope`, so deleting one lane's `TMPDIR` cannot reach another's. A non-recursive `mkdir` of mode 700 creates it, only when creating a new scope; an in-use name fails the `mkdir` rather than reusing it. A capped-lineage nested launch, a launch with no user manager, and a failed `mkdir` all keep the inherited `TMPDIR`.

Owners set `AGENT_TMPDIR=$HOME/dev/.scratch/agents` before starting the wrappers, tmux shell or user manager, to keep scratch on the existing subvolume. The warden reads the mise path from `MISE_DATA_DIR`, defaulting to `${XDG_DATA_HOME:-$HOME/.local/share}/mise`; a systemd unit needs it set in `environment.d` when it differs, since it inherits no shell-only value.

`warden/agent_warden_test.py`'s portability rows cover mise and scratch, including `test_agent_confine_and_warden_scratch_parent_agree`, proving the two formulas agree under one environment. Their home-path scan reads only files git tracks under `warden/`, never `__pycache__`, and skips in a copy with no git metadata; `test_portability_scan_reads_only_tracked_files` enforces it.

## Tunables

The launcher and the warden read their limits, grace periods and switches from environment variables. [warden-tunables.md](warden-tunables.md) lists each variable with its consumer, default, accepted value and effect, and states how the warden treats an empty or out-of-format value.

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
