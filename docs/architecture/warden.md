# Agent warden

Covers: warden/

The agent warden is an optional Python component shipped beside the `vsys` dashboard. The dashboard observes the machine. The warden changes process placement automatically.

## Boundary

- `warden/agent-confine` starts agent harnesses in `agents.slice`, exports `AGENT_CONFINE=1`, exports build caps, and exports `TMPDIR` for scratch discovery.
- `warden/agent-warden` runs as a Python oneshot from a systemd user timer every 30 s in `background.slice`.
- `warden/agent-warden` corrects escaped processes with pidfds and systemd `StartTransientUnit`.
- `warden/agent-warden` never belongs to the dashboard read-only promise. D004 records that split.
- `src/` does not import `warden/`. vsys can observe the processes and cgroups that the warden creates.

## What it moves

The warden moves three process classes into `agents.slice`.

- Escaped launches carry `AGENT_CONFINE=1` but run outside `agents.slice`.
- Unconfined agent CLIs or build tools run outside `agents.slice` and match the warden classification table.
- Nested agent sessions share one scope and need a sibling scope so each session gets its own CPU share.

Before a move, the warden opens a pidfd for each process. It re-reads identity, cgroup and classification. It then asks the user systemd manager to create one transient scope with those pidfds. `warden/agent_warden_test.py` and `warden/agent-warden --selftest` cover these planning rules.

## What it leaves alone

A contained job unit is never a move root and never rides along with a moved tree. The default job-unit pattern is `orch-*.service`.

A unit also counts as contained when it is outside `agents.slice` and its own cgroup directory has a real memory, CPU, I/O or cpuset limit. `pids.max` is not enough, because systemd can set a default task limit on every unit.

This rule protects transient validation services such as `orch-validate-vsy-50-12345.service`. The service owns its own process group and time limit. Moving it into an `agent-warden-*.scope` would make the orphan reaper stop a long validation run after the launcher exits. The job-unit rows in `warden/agent_warden_test.py` and `warden/agent-warden --selftest` cover this regression.

## What it caps

The launcher gives each new scope `CPUWeight=99`, `TasksMax=8192` and `MemoryHigh=64G` by default. The non-default CPU weight enables the CPU controller below `agents.slice`; CPUWeight 100 was measured not to enable it. The default per-scope `MemoryHigh=64G` is not a deliberate nested cap even when `agents.slice` has a higher `MemoryHigh`. The warden also caps an unbounded scope it finds under `agents.slice`. `warden/agent_warden_test.py` covers task-cap report mode, capped and plain lineage rows, the default memory-high baseline, and the CPUWeight value. `warden/agent-warden --selftest` covers contained lineage in planning.

The template `warden/systemd/agents.slice` uses percentages for fleet installs: `MemoryHigh=65%` and `MemoryMax=90%`. The owner workstation can keep its tuned absolute values instead.

## What it reaps

The warden reaps only orphaned `.scope` units under `agents.slice`.

A scope is an orphan only when every member has lost its launcher, no member has a controlling terminal, no member is a live agent session and no live external parent still holds it. A scope named `agent-confine-<pid>-<n>.scope` is not an orphan while `<pid>` is a live member and its parent is outside the scope. That protects unlisted agent CLIs started through `agent-confine`. The rule does not apply to `agent-warden-*.scope`, because an adopted build root can still leak leftover work. The reaper waits at least 300 s. It then stops the whole scope only when it is harmful: at least 40 processes or at least 0.5 core on two ticks.

The warden never kills an individual process. It never kills a live session. A scope with a tty, a live agent, a live launch root or a live external parent is not an orphan. The final pre-stop recheck refuses to reap when it cannot enumerate every `cgroup.procs` file that still exists under the scope. The orphan rows in `warden/agent_warden_test.py` and `warden/agent-warden --selftest` enforce this claim.

## Scratch and mise paths

`agent-confine` exports `TMPDIR` into the agent environment. vsys uses the running agent's `TMPDIR` to discover scratch. `AGENT_TMPDIR` overrides the path. The default is `${XDG_CACHE_HOME:-$HOME/.cache}/agents/tmp`. The launcher creates that directory with mode 700 before exec. If creation fails, it warns and keeps the inherited `TMPDIR`.

The owner must set `AGENT_TMPDIR=$HOME/dev/.scratch/agents` in the environment that starts the per-account wrappers, tmux pane shell or user manager before switching to the vsys copy. That keeps scratch on the existing scratch subvolume.

The warden derives the mise install path from `MISE_DATA_DIR`. If `MISE_DATA_DIR` is unset, it uses `${XDG_DATA_HOME:-$HOME/.local/share}/mise`, which is mise's default. A systemd user unit does not inherit a shell-only value. Put `MISE_DATA_DIR` in the user manager environment, such as `environment.d`, when it differs from the default.

The portability rows in `warden/agent_warden_test.py` cover the mise and scratch portability rules.

## Tunables

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENT_WARDEN_ONLY` | unset | Limits one scan to listed process ids. |
| `AGENT_WARDEN_SPLIT_SESSIONS` | `1` | Splits nested agent sessions when the lineage is not capped. |
| `AGENT_WARDEN_ORPHAN_GRACE` | `300` | Seconds an orphan must stay orphaned before a reap can happen. |
| `AGENT_WARDEN_REAP` | `1` | Enables orphan reaping. |
| `AGENT_WARDEN_JOB_UNITS` | `orch-*.service` | Whitespace-separated systemd unit patterns left in place. |
| `AGENT_WARDEN_ORPHAN_PROCS` | `40` | Process count that makes an orphan harmful. |
| `AGENT_WARDEN_ORPHAN_CPU` | `0.5` | CPU cores that make an orphan harmful. |
| `AGENT_SCOPE_TASKS_MAX` | `8192` | Per-session task ceiling. |
| `AGENT_SCOPE_TASKS_WARN` | `6144` | Per-session task warning threshold. |
| `AGENT_SCOPE_MEM_HIGH_BYTES` | `68719476736` | Per-session soft memory ceiling. |
| `AGENT_SCOPE_MEM_WARN_BYTES` | `51539607552` | Per-session memory warning threshold. |
| `AGENT_TMPDIR` | unset | Overrides the launcher scratch directory. |
| `AGENT_TEST_THREADS` | `8` | Test-thread cap exported by the launcher. |
| `AGENT_BUILD_JOBS` | `16` | Build-job cap exported by the launcher. |
| `AGENT_MOLD_JOBS` | `1` | Mold linker concurrency cap. Empty disables it. |

## Files and install

The install path is manual until VSY-54 adds `vsys warden install`.

- Install scripts with `install -D -m 755 warden/agent-warden ~/.local/bin/agent-warden`, repeated for `agent-confine` and `agent-confine-lineage-capped`.
- Install units with `install -D -m 644 warden/systemd/agent-warden.service ~/.config/systemd/user/agent-warden.service`, repeated for the timer and slice.
- If a target path is a symlink, remove the symlink first or use a copy command with `--remove-destination`; do not write through a dotfiles stow link.
- Run `systemctl --user daemon-reload`.
- Run `systemctl --user enable --now agent-warden.timer`.

The service runs `%h/.local/bin/agent-warden --correct`.

On a fresh install, `agents.slice` can be absent until the first scope enters it. The warden treats an absent slice as empty headroom so the first move can create it. It still fails closed when the slice exists but its memory counters are missing or unparsable.

## Requirements

- Linux with cgroup v2.
- A systemd user manager with CPU, memory and pids delegated below `user@.service`.
- Python 3.9 or newer.
- `libsystemd.so.0`.
- Kernel pidfd support.

## Owner workstation migration

Do not run two wardens.

The owner workstation currently gets the scripts and units from dotfiles. In the migration pass, dotfiles stops stowing `agent-warden`, `agent-confine`, `agent-confine-lineage-capped`, `agent-warden.service`, `agent-warden.timer` and `agents.slice`. The owner installs the vsys copies in the same locations. The owner keeps the absolute `agents.slice` memory values tuned for that machine by skipping the template slice or by using a local drop-in.

Migration order:

1. Set `AGENT_TMPDIR=$HOME/dev/.scratch/agents` in the environment that starts agent wrappers.
2. Remove the dotfiles stow links for `agent-warden`, `agent-confine`, `agent-confine-lineage-capped`, `agent-warden.service`, `agent-warden.timer` and `agents.slice`.
3. Install the vsys scripts and units into the now-unlinked target paths.
4. Keep the owner `agents.slice` values instead of the percentage template, or install those values as a local drop-in.
5. Run `systemctl --user daemon-reload`.
6. Restart `agent-warden.timer`.
7. Verify with `systemctl --user cat agent-warden.service` and `readlink` that no warden script or unit points into dotfiles.
8. Check that exactly one `agent-warden.timer` exists.

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
- `python3 -m unittest discover -s warden -p '*_test.py'` covers module loading, portability, mutant controls, launcher scratch creation and the job-unit regression.
- `python3 scripts/ci.py` runs both warden checks before the Bun checks when `warden/` exists.
