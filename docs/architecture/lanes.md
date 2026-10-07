# A lane is found, judged and named in one place

Read before changing how a lane is found, named, judged against the agent slice, traced to its launcher, or matched to its tmux pane, or which processes count as agent tools.

## The approach

A lane is a watched scope, or a group an agent or a resource alarm made worth watching. A scope is a systemd cgroup whose name ends in `.scope`, the only kind of group `systemctl` can be told to act on. The collector reads processes and groups, and `src/model/lanes.ts` derives the lane. `escaped()` there is the only definition of an agent running outside the agent slice. `unitLabel()` and `laneText()` in `src/model/naming.ts` are the only places a unit name becomes a name a reader sees. `ownPaneMark()` in `src/model/lanes.ts` is the only answer to whether a lane's tmux pane is the one vsys draws in.

A process is an agent when its name is a configured agent tool and its executable lies where that tool installs. `data/agent-tools.json` holds the shipped names and their install locations, and the dashboard and the warden both read it, with the machine overlay `~/.config/vsys/agent-tools.json` merged in. `toolName()` in `src/collect/builds.ts` is the dashboard's one rule, and `Proc.is_agent` in `warden/agent-warden` is the warden's.

## Why

Lanes, alerts, history points, timeline events and Home cards all say whether an agent escaped. Two definitions would let a card and the timeline disagree about one process. Two lanes can share a name, so a name that doubled as an identity would mislead the reader about which agent to stop.

A name alone matches anyone's program: `pi` or `dsh` can be any script. An install location is a second signal a coincidence does not carry. One data file keeps the dashboard and the warden agreeing on which names exist, because a copied list drifts ([D005](../decisions/D005-shared-agent-tool-data.md)). [D010](../decisions/D010-agent-names-confirmed-by-install-location.md) records the confirmation rule.

## Rules

- Do decide an escaped agent through `escaped()`, and whether to compare at all through `sliceCompared()`: only a probe that found the slice absent or masked stops the comparison. A slice vsys could not read, and a sample recorded before the probe, keep comparing, so a failed read never silences an escaped agent. `src/model/lanes.test.ts` tables the present, unreadable, unrecorded, absent and masked slice.
- Do count a slice as present when its unit file or drop-in directory exists in the user manager's unit directories, before its group does. `probeAgentSlice()` in `src/collect/capabilities.ts` reads them per [D009](../decisions/D009-agent-slice-unit-file.md), and `src/collect/capabilities.test.ts` tables the probe.
- Do add a shipped tool to `data/agent-tools.json` with at least one install location. `src/config/agent-tools.test.ts` fails a shipped tool with none, and fails a shipped name quoted in non-test `src/config/` source.
- Do add a machine-local tool, or another location for a shipped name, to the overlay; Settings writes it there. An overlay adds locations and never removes a shipped name.
- Do carry a rejected name on the process as `unconfirmedTool`, with the one path tested and which check tested it, so a missed install layout shows in the snapshot and on a Home card rather than vanishing.
- Do keep the agent name where a path could not be read. A failed read never hides an escaped agent.
- Do keep both parsers refusing the same malformed documents: `src/config/agent-tools.test.ts` and `warden/agent_warden_classify_test.py` both read `data/agent-tools-rejected.json`.
- Do confirm a match under a desktop prefix where the tool's own location or a bundled CLI suffix names it; a location a reader adds is never vetoed by the prefix.
- Do name a unit through `unitLabel()`. It drops the `app-` launcher prefix, the unit suffix, systemd's uniqueness field and `\xNN` escapes. `src/model/naming.test.ts` checks each form.
- Do put the process id in a column of its own, `pidColumn` in `src/ui/columns.ts`, on every view that draws lane names, and name a lane in prose through `laneText()`.
- Do take a lane's age from its oldest member and its memory from the sum over its members. A lane with no readable member has an unknown age, memory and main process, judged by `memberless()` in `src/model/lanes.ts`, and every screen and export draws the gap.
- Do assign each process to its nearest lane before calculating process totals. Nested lanes never share a process. The configured root contains every collected child group. `src/model/builds.test.ts` checks ownership and fleet totals; `src/model/lanes.test.ts` checks unread root members. Measured cgroup counters retain their subtree values.
- Do run every tmux read through `spawnText()` in `src/collect/io.ts`, bounded by `tmuxTimeoutMs`, so a wedged server costs one call rather than every future sample. `src/collect/io.test.ts` kills a real child that ignores SIGTERM.
- Do read a lane's pane, switch to it, or copy its command only where `ownPaneMark()` answered `no`. `yes` means the pane is this screen, and `unknown` means vsys cannot tell; each draws a line of its own and offers nothing, because the capture either would replace draws vsys inside itself. `src/model/lanes.test.ts` tables the three answers and `src/ui/agent.test.tsx` counts the captures for each.
- Do name a launcher on a card only where `launcherKnown()` in `src/model/launcher.ts` holds: the slice is present and confinement markers are configured. Otherwise a missing marker says nothing about how an agent started.
- Never match on prompt arguments: `bash -c claude` is not claude. An excluded argv pattern matches an executable name or a whole flag.
- Never call a desktop app's own binary an agent. An executable under a desktop prefix is an agent only where a bundled CLI suffix or the tool's install location names it.
- Never let the warden move a process confirmed only by a `paths` fragment. A fragment is a substring any same-uid process can reproduce under a writable directory, so the warden confirms by mise directory, exact executable path, or a bundled CLI engine under a desktop prefix outside `/tmp`, while the dashboard's display match reads fragments too. `Proc.is_named_agent`, the name alone, decides whether a scope holds a live agent for reaping, so a paths-only install is still protected. `warden/agent_warden_classify_test.py` and `warden/agent_warden_orphan_test.py` hold both rules.
- Never append anything to a lane name to make it unique; `distinctNames()` is for Resources rows alone. `src/model/lanes.test.ts` checks that a name holds no separator the server gave it.
- Never let a tmux pane id enter a name. It is the handle an action addresses, and the resolved `session:window.pane` address is a column of its own.
- Never resolve a pane handle against a server other than the lane's own. A handle whose server is known to differ resolves to nothing rather than naming a stranger's pane.

## The canonical example

`escaped()` in `src/model/lanes.ts`: it takes the process, the collection settings and the capability list, and the point, the event log, the alert rules and the cards all call it rather than comparing a cgroup path themselves. Copy that: one function, many readers. For a new agent tool, copy the shape of the `codex` entry in `data/agent-tools.json`, adding `executables` where a package installs into a shared directory such as `/usr/bin`.

## Revisit when

A lane gains an identity of its own, independent of its cgroup path and leading process, or the agent slice is defined some way the unit directories do not show ([D009](../decisions/D009-agent-slice-unit-file.md)). An agent ships an install layout no fragment, executable path or mise directory describes ([D010](../decisions/D010-agent-names-confirmed-by-install-location.md)), or packaging generates per-component data from a richer schema ([D005](../decisions/D005-shared-agent-tool-data.md)).

## Not governed

What a lane's numbers mean and when they alarm: [verdict.md](verdict.md). What the warden does with a confirmed agent: [warden.md](warden.md). How build work is counted: [layers.md](layers.md).
