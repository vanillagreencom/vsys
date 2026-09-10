# Lanes and processes

Covers: src/model/lanes.ts src/model/naming.ts src/model/launcher.ts src/model/scopes.ts src/model/alerts.ts src/collect/procs.ts src/collect/tmux.ts

A lane is a watched scope, or a group an agent or a resource alarm made worth watching. The collector reads the processes, the model derives the lane, its name, its launch trail and the alert rules that fire on it.

## Boundaries

- The pane handle and window title are read from the pane environment, and a pane that exports neither leaves both parts out of the lane name. The address and the window name beside them are read from the tmux server, in one `list-panes` for the whole machine rather than one call per lane.
- The pane handle never reaches a lane name. `%9` is a server-global tmux pane id, so the number says nothing about which session or window holds the pane, and two agents in one worktree are told apart by their window rather than by anything the number shows. The lane keeps it as the handle it is: `tmux switch-client -t %9` reaches that pane. The address a reader types is resolved beside it, from the server rather than from the handle.
- A pane handle is resolved only when it is one: `%N` and nothing else, which is tmux's own grammar. `paneEnv` reads `VSYS_PANE` first, and that is configured with an address like `work:2.1` rather than a handle. An address configured directly is already what a reader types, so it stands as the address and carries no window name, which only the server holds.
- `unitLabel()` in `src/model/naming.ts` is the only place a systemd unit name becomes a name a screen shows. Lanes, resource groups and every meter consumer call it.
- `distinctNames()` in `src/model/naming.ts` is the only rule for names that repeat. Lanes call it through `distinguish()`; Resources calls it over every group, so hiding the idle rows cannot rename a row the reader is looking at.

## Invariants

- An excluded argv pattern matches an executable name or a whole flag, never prompt text, and the configured linker names are the only linker list. `src/collect/collector.test.ts` checks a prompt naming a language server and an empty linker list.
- The environment of an escaped agent is read from that agent, not from its scope's main process. `src/collect/collector.test.ts` checks an agent child of a pane shell.
- A launcher trail states the ancestors and their cgroups, the confinement markers and any PATH prefix. Markers with the wrong cgroup mean a shadowed launcher, their absence a bare launch. `src/model/launcher.test.ts` checks both and an unreadable environment.
- A lane name joins the configured parts in the configured order and leaves out a part with no value. `src/model/naming.test.ts` checks the order and an unreadable environment; `src/model/lanes.test.ts` checks two accounts in one worktree and a lane that names no account.
- No two lanes in one sample render the same name, and no two resource groups do either. A colliding set takes the first candidate that separates every member of it: for a lane the working directory basename, then the process id, then the lane id; for a group its parent, then its first process id, then its path. `src/model/lanes.test.ts` and `src/ui/resources.test.ts` check each step and that the result is distinct.
- No lane name carries a pane address, and no unit name reaches a screen carrying a `\xNN` escape, the `app-` launcher prefix or a `.scope` suffix. `src/model/naming.test.ts` checks the unit forms and asserts the absence; `src/model/lanes.test.ts` checks that a name holds no `%`.
- Per-lane page cache, I/O rates, CPU share and cgroup weight stay unknown when the kernel did not report them, and an unread cgroup tree leaves the effective memory cap unknown rather than unlimited. `src/model/lanes.test.ts` checks a group with no counters and a lane with no covering group.
- A cgroup limit file holds a number or the word max. A file that could not be read is neither, so the effective cap is known only when every covering ancestor was read. `src/collect/collector.test.ts` removes an ancestor's memory.max.
- A blocked lane counts its tasks in uninterruptible wait and names storage or memory by the higher stall share. `src/model/lanes.test.ts` checks both resources and unknown pressure.
- Process environment caching uses PID and start time. `src/collect/collector.test.ts` exercises PID reuse and environment selection.
- Scope launch metadata belongs to the scope's main process. `src/collect/collector.test.ts` checks a wrapper with an agent child.
- When a PID appears in sibling scope lists, its process membership file selects the row. `src/collect/collector.test.ts` checks that fallback.
- Each new escaped agent can emit an alert within an already alarmed scope. `src/model/alerts.test.ts` checks process identity and rearming.
