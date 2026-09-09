# Lanes and processes

Covers: src/model/lanes.ts src/model/naming.ts src/model/launcher.ts src/model/scopes.ts src/model/alerts.ts src/collect/procs.ts

A lane is a watched scope, or a group an agent or a resource alarm made worth watching. The collector reads the processes, the model derives the lane, its name, its launch trail and the alert rules that fire on it.

## Boundaries

- The pane address and window title are read from the pane environment. vsys does not query the tmux server, so a pane that exports neither leaves both parts out of the lane name.

## Invariants

- An excluded argv pattern matches an executable name or a whole flag, never prompt text, and the configured linker names are the only linker list. `src/collect/collector.test.ts` checks a prompt naming a language server and an empty linker list.
- The environment of an escaped agent is read from that agent, not from its scope's main process. `src/collect/collector.test.ts` checks an agent child of a pane shell.
- A launcher trail states the ancestors and their cgroups, the confinement markers and any PATH prefix. Markers with the wrong cgroup mean a shadowed launcher, their absence a bare launch. `src/model/launcher.test.ts` checks both and an unreadable environment.
- A lane name joins the configured parts in the configured order and leaves out a part with no value. `src/model/naming.test.ts` checks the order and an unreadable environment; `src/model/lanes.test.ts` checks two accounts in one worktree and a lane that names no account.
- Per-lane page cache, I/O rates, CPU share and cgroup weight stay unknown when the kernel did not report them, and an unread cgroup tree leaves the effective memory cap unknown rather than unlimited. `src/model/lanes.test.ts` checks a group with no counters and a lane with no covering group.
- A cgroup limit file holds a number or the word max. A file that could not be read is neither, so the effective cap is known only when every covering ancestor was read. `src/collect/collector.test.ts` removes an ancestor's memory.max.
- A blocked lane counts its tasks in uninterruptible wait and names storage or memory by the higher stall share. `src/model/lanes.test.ts` checks both resources and unknown pressure.
- Process environment caching uses PID and start time. `src/collect/collector.test.ts` exercises PID reuse and environment selection.
- Scope launch metadata belongs to the scope's main process. `src/collect/collector.test.ts` checks a wrapper with an agent child.
- When a PID appears in sibling scope lists, its process membership file selects the row. `src/collect/collector.test.ts` checks that fallback.
- Each new escaped agent can emit an alert within an already alarmed scope. `src/model/alerts.test.ts` checks process identity and rearming.
