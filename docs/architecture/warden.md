# The warden corrects outside the dashboard

Read before changing what the optional warden under `warden/` moves, leaves alone, caps, reaps or reports, how it is installed, or what a package ships beside the binary.

## The approach

The dashboard observes; the warden corrects. `warden/agent-warden` is a Python oneshot that the timer in `warden/systemd/` runs in `background.slice`. It moves three classes of process into `agents.slice` through pidfds and systemd's `StartTransientUnit`, caps a scope's tasks, reaps orphaned scopes and their scratch directories, and writes `status.json` under `$XDG_RUNTIME_DIR/agent-warden/` for consumers. `warden/agent-confine` is the launcher that starts an agent in the slice and stamps `AGENT_CONFINE=1`. `src/` never imports `warden/`; `src/warden.ts` only dispatches `vsys warden` to the installer. [D004](../decisions/D004-warden-separate-component.md) records the split.

`vsys warden install` writes the warden's service, timer and `agents.slice` into the user's systemd unit directory, copies the shipped agent-tool data into the vsys data directory, reloads the user manager and enables the timer. Every unit it writes starts with the marker in `warden/install`, and the service unit records the data file's hash. The packages, the release archive and `install.sh` ship the warden tree under `lib/vsys/` through `packaging/vsys-runtime-files.txt`, and none of them installs a user unit or enables anything.

## Why

Importing automatic correction into the dashboard would break its promise to read without changing. The warden keeps working when the dashboard is closed, and it stays Python because it calls pidfd and libsystemd directly.

Automatic correction is a user's choice, so a package preset that turned it on would make it package policy. The owner workstation stows these unit files from dotfiles, and an installer that wrote through a symlink would edit another tool's files.

## Rules

- Do move only the three classes: an escaped launch, which carries `AGENT_CONFINE=1` and runs outside the slice; an unconfined agent or build tool the classification data confirms; and a nested session that shares a scope and needs a CPU share of its own. Re-read identity, cgroup and classification through a pidfd before each move. `warden/agent_warden_test.py` and the `--selftest` mode cover the planning rules.
- Do leave a contained job unit alone: one matching `AGENT_WARDEN_JOB_UNITS`, or one outside the slice whose own cgroup carries a real memory, swap, CPU, I/O or cpuset limit. `pids.max` alone is not a limit, because systemd sets a default task limit on every unit. `contained_unit()` is the rule.
- Do confirm an agent's name as [lanes.md](lanes.md) states, through `Proc.is_agent`, and judge whether a scope holds a live agent through `Proc.is_named_agent`, the name alone.
- Do reap only an orphaned `.scope` under the slice: every member lost its launcher, no member holds a terminal, none is a live agent, no live external parent holds it, the grace has passed, and `scope_harm()` holds on two ticks. Grace and harm history belong to one cgroup directory instance. A replacement directory starts fresh grace; an unreadable identity discards history and prevents a stop. Check that identity before and after the membership recheck. An unread `memory.stat` never makes a scope harmful. `warden/agent_warden_orphan_test.py` holds the rows.
- Do remove a lane's scratch directory under `AGENT_TMPDIR` only once its scope is gone and no readable process holds the directory. A process whose environment cannot be read keeps every unknown directory while it lives. `warden/agent_warden_scratch_test.py` covers it.
- Do read every tunable through `env_number()` in `warden/agent-warden`: an empty value is unset, and a value outside its format is logged and the default used, so a bad value never stops a tick. `warden/agent_warden_settings_test.py` covers the variables and their formats.
- Do write `status.json` with numbers and ids only, null for a reading that could not be taken, through a temporary file and a rename. `status_errors()` validates it, the fixtures under `warden/fixtures/` are its shapes, and `warden/agent_warden_status_test.py` holds both.
- Do send a desktop notice only when no consumer owns them, judged by the heartbeat file under the runtime directory, and send one notice per episode. `warden/agent_warden_notify_test.py` covers the handoff and the episodes.
- Do refuse the whole install when any target is a symlink or an unmarked file, when a unit or data directory is itself a symlink, or when a target cannot be read. A marked file is ours and can be rewritten. `warden/install_test.py` covers foreign, unreadable and linked targets.
- Do overwrite the copied data file only when it is absent or its hash matches one recorded in the marked service unit, and record both the new and the installed hash during an upgrade so an interrupted write can be retried.
- Do make `uninstall` remove only marked files and a data copy whose hash matches, stop only a marked service, and leave `agents.slice` and every running scope alone.
- Do make `status` read-only, and fail it on any read that could not be taken.
- Do add a shipped file to `packaging/vsys-runtime-files.txt`. `scripts/package_file_list_check.py` holds the payload, the modes, the reporter rows and the rule that no package installs or enables a user unit, and `scripts/package_file_list_check_test.py` runs each PKGBUILD's `package()`.
- Never kill an individual process, and never stop a live session.
- Never move a process already inside the slice as a descendant, and never move a desktop app or an excluded helper.
- Never fail open on the slice's memory counters: an absent slice is empty headroom, so the first move can create it, and an existing slice with unreadable counters stops every move.
- Never write `status.json` from `--status`, `--selftest` or a restricted `AGENT_WARDEN_ONLY` run.
- Never write, overwrite or remove the local overlay `~/.config/vsys/agent-tools.json` from the installer.
- Never install under `/usr/lib/systemd/user`, and never preset or enable a unit from a package.
- Never strip the compiled binary in a package. Stripping removes Bun's appended bundle, so both PKGBUILDs set `!strip` and `!debug`.

## The canonical example

`contained_unit()` in `warden/agent-warden`: one function that says whether a unit is left alone, read by the planner and nowhere else. Copy that: one rule, one set of readers. For any file the installer may own, copy the marker check in `warden/install`: read the first line, compare it to `MARKER`, and treat anything else as foreign.

## Revisit when

A Bun foreign-function interface port can call pidfd and libsystemd with the same safety ([D004](../decisions/D004-warden-separate-component.md)), or the dashboard must own an automatic correction under a new explicit promise. Packaging generates per-distribution units, or systemd offers a user-unit ownership record the marker duplicates.

## Not governed

The shared agent-tool data's shape: [lanes.md](lanes.md). The root-side reporters the same payload ships: [storage-integrity.md](storage-integrity.md).
