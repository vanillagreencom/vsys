# Agent warden

Covers: warden/ src/warden.ts

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

A scope is an orphan only when every member has lost its launcher, no member has a controlling terminal, no member is a live agent session and no live external parent still holds it. A scope named `agent-confine-<pid>-<n>.scope` is not an orphan while `<pid>` is a live member and its parent is outside the scope. A scope named `agent-warden-<pid>-<start>.scope` uses the same rule and also requires the member start time to match. Those rules protect unlisted agent CLIs started through `agent-confine` or adopted by the warden, such as a marked `node server.js`, while their launch root runs. A scope named `agent-warden-build-<pid>-<start>.scope` is not protected by its root, because an adopted build root can still leak leftover work. The reaper waits at least 300 s. It then stops the whole scope only when it is harmful: at least 40 processes or at least 0.5 core on two ticks.

The warden never kills an individual process. It never kills a live session. A scope with a tty, a live agent, a live launch root or a live external parent is not an orphan. The final pre-stop recheck refuses to reap when it cannot enumerate every `cgroup.procs` file that still exists under the scope. The orphan rows in `warden/agent_warden_test.py` and `warden/agent-warden --selftest` enforce this claim.

## Classification data

The shipped classification data is `data/agent-tools.json`. It contains published agent CLI names, mise install directory names, desktop executable prefixes and bundled CLI suffixes.

At startup, the warden first looks beside a checkout at `data/agent-tools.json`. If that file is absent, it looks at `${XDG_DATA_HOME:-$HOME/.local/share}/vsys/agent-tools.json`. If neither file exists, it exits with `agent-tools=missing`.

The local overlay is `$HOME/.config/vsys/agent-tools.json`. It uses the same schema and adds entries. A missing overlay is normal. A malformed shipped file or overlay exits with `agent-tools=invalid` and names the file. In the dashboard, `config.toml` `agentTools` wins over the overlay once that key exists, including after a Settings save. Remove that key to follow the overlay again.

D005 records why the dashboard and the warden share this data file.

## Scratch and mise paths

`agent-confine` exports `TMPDIR` into the agent environment. vsys uses the running agent's `TMPDIR` to discover scratch. `AGENT_TMPDIR` overrides the path. The default is `${XDG_CACHE_HOME:-$HOME/.cache}/agents/tmp`. The launcher creates that directory with mode 700 before exec. If creation fails, it warns and keeps the inherited `TMPDIR`.

The owner must set `AGENT_TMPDIR=$HOME/dev/.scratch/agents` in the environment that starts the per-account wrappers, tmux pane shell or user manager before switching to the vsys copy. That keeps scratch on the existing scratch subvolume.

The warden derives the mise install path from `MISE_DATA_DIR`. If `MISE_DATA_DIR` is unset, it uses `${XDG_DATA_HOME:-$HOME/.local/share}/mise`, which is mise's default. A systemd user unit does not inherit a shell-only value. Put `MISE_DATA_DIR` in the user manager environment, such as `environment.d`, when it differs from the default.

The portability rows in `warden/agent_warden_test.py` cover the mise and scratch portability rules.

## Tunables

| Variable | Consumer | Default | Effect |
| --- | --- | --- | --- |
| `AGENT_WARDEN_ONLY` | warden | unset | Limits one scan to listed process ids. |
| `AGENT_WARDEN_SPLIT_SESSIONS` | warden | `1` | Splits nested agent sessions when the lineage is not capped. |
| `AGENT_WARDEN_ORPHAN_GRACE` | warden | `300` | Seconds an orphan must stay orphaned before a reap can happen. |
| `AGENT_WARDEN_REAP` | warden | `1` | Enables orphan reaping. |
| `AGENT_WARDEN_JOB_UNITS` | warden | `orch-*.service` | Whitespace-separated systemd unit patterns left in place. |
| `AGENT_WARDEN_ORPHAN_PROCS` | warden | `40` | Process count that makes an orphan harmful. |
| `AGENT_WARDEN_ORPHAN_CPU` | warden | `0.5` | CPU cores that make an orphan harmful. |
| `AGENT_SCOPE_TASKS_MAX` | both | `8192` | Per-session task ceiling. |
| `AGENT_SCOPE_TASKS_WARN` | warden | `6144` | Per-session task warning threshold. |
| `AGENT_SCOPE_MEM_HIGH` | launcher | `64G` | Per-session soft memory ceiling passed to systemd. |
| `AGENT_SCOPE_MEM_HIGH_BYTES` | warden | `68719476736` | Per-session soft memory ceiling used for warden-created scopes and lineage baseline. |
| `AGENT_SCOPE_MEM_WARN_BYTES` | warden | 75% of `AGENT_SCOPE_MEM_HIGH_BYTES` | Per-session memory warning threshold. |
| `AGENT_TMPDIR` | launcher | unset | Overrides the launcher scratch directory. |
| `AGENT_TEST_THREADS` | launcher | `8` | Test-thread cap exported by the launcher. |
| `AGENT_BUILD_JOBS` | launcher | `16` | Build-job cap exported by the launcher. |
| `AGENT_MOLD_JOBS` | launcher | `1` | Mold linker concurrency cap. Empty disables it. |

`AGENT_SCOPE_MEM_HIGH` and `AGENT_SCOPE_MEM_HIGH_BYTES` must name the same size. The launcher reads the systemd size string. The warden reads the byte value for warden-created scopes and for the lineage baseline.

## Files and install

`vsys warden install` installs the systemd user units in `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/`. It writes `agent-warden.service`, `agent-warden.timer` and `agents.slice`, copies the shipped shared agent-tool list from `<warden dir>/../data/agent-tools.json` to `${XDG_DATA_HOME:-$HOME/.local/share}/vsys/agent-tools.json`, then reloads the user manager and enables `agent-warden.timer`. It refuses before writing when the shipped list is missing, because VSY-51's data file contract makes that file the warden classifier input. `warden/install_test.py` checks the written files, the copied data, the missing-list refusal, the reload call and the enable call with a stub `systemctl`.

`src/warden.ts` resolves the warden directory in one place and dispatches to `warden/install`. The source checkout wins when `../warden/install` exists beside `src/`. An installed `vsys` binary otherwise looks for `../lib/vsys/warden` relative to the real path of the executable. This is the packaging contract for release archives and `install.sh`. `src/warden.test.ts` checks the order and the error that lists every path tried.

The service template keeps `ExecStart=@WARDEN_DIR@/agent-warden --correct`. The installer fills it with the resolved warden tree. It escapes `%` for systemd and quotes paths with whitespace or quotes. It refuses the install when `agent-warden` is not executable. `warden/install_test.py` covers the path substitution and percent escaping.

Each installed unit starts with the vsys warden marker. The installer refuses the whole install when any target is a symlink or an unmarked file, so it does not write through a dotfiles stow link. It also refuses when the systemd unit directory, its `user` child, or the vsys data directory is itself a symlink, because stow can fold whole directories. A marked file is ours and can be rewritten. `warden/install_test.py` covers foreign files, symlinks, folded directory symlinks and reinstalling marked files.

The shared agent-tool list is JSON, so the installer does not add a marker to it or add schema keys to it. Instead, the installer records `# vsys-warden-data: sha256=<hex>` in the marked service unit. A later install overwrites `${XDG_DATA_HOME:-$HOME/.local/share}/vsys/agent-tools.json` only when the file is absent or its hash matches the hash in the existing service unit. Otherwise the data file is foreign and the whole install refuses. `warden/install_test.py` covers the hash record, reinstall and foreign-data refusal.

Machine-local agent names live in `${XDG_CONFIG_HOME:-$HOME/.config}/vsys/agent-tools.json`. The installer never writes, overwrites or removes that file. `warden/install_test.py` covers install and uninstall with a pre-existing local file.

`vsys warden uninstall` disables only `agent-warden.timer`, removes only marked files, removes the copied shared agent-tool list only when its hash matches the service unit record, and removes a leftover `timers.target.wants/agent-warden.timer` symlink only when it points at the marked timer. It never stops `agents.slice` and never touches scopes, so running agents keep running. After daemon reload, removing the slice file removes the template limits for future units. `warden/install_test.py` covers removal and foreign files left in place.

`vsys warden status` is read-only. It reports whether each unit and the copied shared agent-tool list are installed by vsys, foreign or missing. It reports whether the timer is enabled and active, the timer's last trigger, the service result and whether `cpu`, `memory` and `pids` are delegated to `user@.service`. A failed read stays unknown. `warden/install_test.py` covers complete delegation, missing delegation and unknown delegation.

The installer does not install the root desktop-protection pack. That pack owns the `MemoryLow` chain and cgroup recursive protection. It remains a separate root-owned setup.

The manual fallback is to copy `warden/agent-warden`, `warden/agent-confine` and `warden/agent-confine-lineage-capped` into a directory on `PATH`, copy the templates from `warden/systemd/` into the systemd user-unit directory, replace `@WARDEN_DIR@` with the script directory, copy `data/agent-tools.json` into the vsys data directory, add the data hash comment to the service unit, then reload the user manager and enable `agent-warden.timer`. Remove any symlink target first; do not write through it.

On a fresh install, `agents.slice` can be absent until the first scope enters it. The warden treats an absent slice as empty headroom so the first move can create it. It still fails closed when the slice exists but its memory counters are missing or unparsable.

## Requirements

- Linux with cgroup v2.
- A systemd user manager with CPU, memory and pids delegated below `user@.service`.
- Python 3.9 or newer.
- `libsystemd.so.0`.
- Kernel pidfd support.

## Owner workstation migration

Do not run two wardens.

The owner workstation currently gets the scripts and units from dotfiles. In the migration pass, dotfiles stops stowing `agent-warden`, `agent-confine`, `agent-confine-lineage-capped`, `agent-warden.service`, `agent-warden.timer` and `agents.slice`. `vsys warden install` writes only the marked unit files and shared data file. It does not install the launchers. The owner keeps the absolute `agents.slice` memory values tuned for that machine as a local drop-in under `agents.slice.d/*.conf`, because the installer writes the percentage template.

Migration order:

1. Set `AGENT_TMPDIR=$HOME/dev/.scratch/agents` in the environment that starts agent wrappers.
2. Remove the dotfiles stow links for `agent-warden`, `agent-confine`, `agent-confine-lineage-capped`, `agent-warden.service`, `agent-warden.timer` and `agents.slice`.
3. Link or copy `<warden dir>/agent-confine` and `<warden dir>/agent-confine-lineage-capped` into one directory on `PATH`, such as `~/.local/bin`, before new panes depend on them. Keep both launchers from the same warden tree.
4. Run `vsys warden install`.
5. Put the owner `agents.slice` values in a local drop-in under `agents.slice.d/*.conf`.
6. Verify that no warden script or unit points into dotfiles.
7. Check that exactly one `agent-warden.timer` exists.

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
- `python3 -m unittest discover -s warden -p '*_test.py'` covers module loading, classification data lookup, the owner overlay, portability, mutant controls, launcher scratch creation and the job-unit regression.
- `python3 scripts/ci.py` runs both warden checks before the Bun checks when `warden/` exists.
