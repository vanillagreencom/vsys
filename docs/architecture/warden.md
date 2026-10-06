# The warden corrects outside the dashboard

Read before changing what the optional warden under `warden/` moves, leaves alone, caps, reaps or reports.

## The approach

The dashboard observes; the warden corrects. `warden/agent-warden` is a Python oneshot that the timer in `warden/systemd/` runs in `background.slice`. It moves three classes of process into `agents.slice` through pidfds and systemd's `StartTransientUnit`, caps a scope's tasks, reaps orphaned scopes and their scratch directories, and writes `status.json` under `$XDG_RUNTIME_DIR/agent-warden/` for consumers. `warden/agent-confine` is the launcher that starts an agent in the slice and stamps `AGENT_CONFINE=1`. `src/` never imports `warden/`; `src/warden.ts` only dispatches `vsys warden` to the installer. [D004](../decisions/D004-warden-separate-component.md) records the split.

## Why

Importing automatic correction into the dashboard would break its promise to read without changing. The warden keeps working when the dashboard is closed, and it stays Python because it calls pidfd and libsystemd directly.

## Rules

- Do move only the three classes: an escaped launch, which carries `AGENT_CONFINE=1` and runs outside the slice; an unconfined agent or build tool the classification data confirms; and a nested session that shares a scope and needs a CPU share of its own. Re-read identity, cgroup and classification through a pidfd before each move. `warden/agent_warden_test.py` and the `--selftest` mode cover the planning rules.
- Do leave a contained job unit alone: one matching `AGENT_WARDEN_JOB_UNITS`, or one outside the slice whose own cgroup carries a real memory, swap, CPU, I/O or cpuset limit. `pids.max` alone is not a limit, because systemd sets a default task limit on every unit. `contained_unit()` is the rule.
- Do confirm an agent's name as [agent-tools.md](agent-tools.md) states, through `Proc.is_agent`, and judge whether a scope holds a live agent through `Proc.is_named_agent`, the name alone.
- Do reap only an orphaned `.scope` under the slice: every member lost its launcher, no member holds a terminal, none is a live agent, no live external parent holds it, the grace has passed, and `scope_harm()` holds on two ticks. An unread `memory.stat` never makes a scope harmful. `warden/agent_warden_orphan_test.py` holds the rows.
- Do remove a lane's scratch directory under `AGENT_TMPDIR` only once its scope is gone and no readable process holds the directory. A process whose environment cannot be read keeps every unknown directory while it lives. `warden/agent_warden_scratch_test.py` covers it.
- Do read every tunable through `env_number()` in `warden/agent-warden`: an empty value is unset, and a value outside its format is logged and the default used, so a bad value never stops a tick. The variables, their defaults and formats are the constants beside it, and `warden/agent_warden_settings_test.py` covers them.
- Do write `status.json` with numbers and ids only, null for a reading that could not be taken, through a temporary file and a rename. `status_errors()` validates it, the fixtures under `warden/fixtures/` are its shapes, and `warden/agent_warden_status_test.py` holds both.
- Do send a desktop notice only when no consumer owns them, judged by the heartbeat file under the runtime directory, and send one notice per episode. `warden/agent_warden_notify_test.py` covers the handoff and the episodes.
- Never kill an individual process, and never stop a live session.
- Never move a process already inside the slice as a descendant, and never move a desktop app or an excluded helper.
- Never fail open on the slice's memory counters: an absent slice is empty headroom, so the first move can create it, and an existing slice with unreadable counters stops every move.
- Never write `status.json` from `--status`, `--selftest` or a restricted `AGENT_WARDEN_ONLY` run.

## The canonical example

`contained_unit()` in `warden/agent-warden`: one function that says whether a unit is left alone, read by the planner and nowhere else. Copy that: one rule, one set of readers.

## Revisit when

A Bun foreign-function interface port can call pidfd and libsystemd with the same safety ([D004](../decisions/D004-warden-separate-component.md)), or the dashboard must own an automatic correction under a new explicit promise.

## Not governed

How the warden is installed: [warden-install.md](warden-install.md). The shared data file's shape: [agent-tools.md](agent-tools.md).
