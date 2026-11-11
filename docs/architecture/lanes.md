# Lane identity

Read before changing how a lane is found, named, judged against the agent slice, traced to its launcher or matched to a tmux pane, or changing shared agent-tool data.

## The approach

Derive lanes through `src/model/lanes.ts`. Use `escaped()` for confinement, `unitLabel()` and `laneText()` in `src/model/naming.ts` for names, and `ownPaneMark()` for terminal ownership. Shared tool data follows [D005](../decisions/D005-shared-agent-tool-data.md), install confirmation [D010](../decisions/D010-agent-names-confirmed-by-install-location.md), and inactive-slice discovery [D009](../decisions/D009-agent-slice-unit-file.md).

## Why

Multiple definitions let a card and timeline disagree about one process. Names can coincide, and tmux handles can coincide across servers. Neither is a safe identity by itself.

## Rules

Review holds boundaries without a named check.

- Compare confinement through `escaped()` and `sliceCompared()`. Only a probe establishing an absent or masked agent slice stops comparison. An unread probe or a stored sample without one must not silence an escape. `src/model/lanes.test.ts` checks this.
- Count a slice defined by a user unit file or drop-in as present even before its cgroup exists. `probeAgentSlice()` in `src/collect/capabilities.ts` and `src/collect/capabilities.test.ts` hold the discovery rule.
- Declare shipped tools and at least one install location in `data/agent-tools.json`. Keep machine additions and extra locations in `~/.config/vsys/agent-tools.json`. The overlay may add locations and names, never remove shipped names. `src/config/agent-tools.test.ts` checks the shipped data and rejects copied shipped names in non-test configuration source.
- Keep both language parsers rejecting the shared cases in `data/agent-tools-rejected.json`. `src/config/agent-tools.test.ts` and `warden/agent_warden_classify_test.py` check this contract.
- Preserve a rejected candidate as `unconfirmedTool` with the tested path and match kind, so a missed install location remains visible. Keep the candidate name when the path is unread; a read failure must not hide an escaped agent. Stand-ins keep these facts but raise no unconfirmed-tool cause.
- Judge a lane's test stand-in status only through `standInLane()` in `src/model/lanes.ts`, for both Home alerts and Timeline events. Use its working directory and owned members' paths, never its name or only its main process. A confirmed agent tool in the lane prevents stand-in status. An absolute working directory, command path, script argument as given or tested path is temporary when it has a `tmp` component or sits under a `scratchDirs` root. Take the script argument through the shared helper in `src/collect/builds.ts`. An unconfirmed process outside every lane uses `standIn()` with the same temporary-path rule. `src/model/lanes.test.ts` checks this boundary.
- Never classify prompt text as an agent or exclusion. Exclusions match executable names or whole flags. Never classify a desktop app's binary as an agent unless its tool location or bundled CLI engine confirms it. An added install location is not vetoed by a desktop prefix.
- Never let the warden move a process confirmed only by a `paths` fragment. It requires a mise directory, exact executable or bundled engine under a desktop prefix outside `/tmp`. A same-uid process can forge a path fragment. Reaping uses `Proc.is_named_agent`, the wider name match, so a paths-only live agent remains protected. `warden/agent_warden_classify_test.py` and `warden/agent_warden_orphan_test.py` check both boundaries.
- Name units only through `unitLabel()`. Keep process ids in `pidColumn` in `src/ui/columns.ts`, and use `laneText()` in prose. The summary `title`, an exported data field, is the one exception: it names a lane by its name alone and carries the process id in `processes` ([verdict.md](verdict.md)). Never append uniqueness data or a tmux handle to a lane name. `distinctNames()` serves Resources rows alone. `src/model/naming.test.ts` and `src/model/lanes.test.ts` check naming.
- Choose the account environment through `accountSource()`: use the confirmed agent member that supplies the tool, or an existing unconfirmed candidate when no member is confirmed. Fall back to the main process only when that agent's environment is unread. Both account naming and UI reasons use this selector. `accountName()` prefers listed variables beginning with the tool's uppercase name and `_`, then remaining list order, excluding prefixes belonging to other configured agent tools. A launcher can inherit another tool's account; it must not name this lane. A lane without confirmed or unconfirmed agent identity has no account, and only confirmed agents receive a default-account explanation. `src/model/naming.test.ts`, `src/model/lanes.test.ts` and `src/ui/agent.test.tsx` check these boundaries.
- Read age from the oldest member and memory from the member sum. No readable member means unknown main process, age and memory through `memberless()`; screens and exports must preserve the gap.
- Assign processes to their nearest lane before computing totals. Nested lanes never share a process, while cgroup counters retain their measured subtree values. `src/model/builds.test.ts` and `src/model/lanes.test.ts` check ownership.
- Bound tmux subprocesses through `spawnText()` in `src/collect/io.ts` and `tmuxTimeoutMs`. `src/collect/io.test.ts` checks termination of an unresponsive child.
- Capture, switch or copy a lane's pane command only when `ownPaneMark()` is `no`. `yes` identifies this screen; `unknown` cannot exclude it. Each needs its own explanation and no terminal operation. `src/model/lanes.test.ts` and `src/ui/agent.test.tsx` check this boundary.
- Resolve handles only against their own server. A known server mismatch resolves nothing. Keep the raw action handle apart from the displayed `session:window.pane` address.
- Name a launcher only when `launcherKnown()` in `src/model/launcher.ts` establishes the slice and configured confinement markers. Otherwise a missing marker establishes nothing about the launch.

## The canonical example

Copy `escaped()` in `src/model/lanes.ts`: all confinement consumers call one predicate rather than compare cgroup paths themselves. Copy the `codex` entry in `data/agent-tools.json` for a new tool, with `executables` for a shared install directory such as `/usr/bin`.

## Revisit when

A lane gains stable identity independent of its cgroup and leading process, or the discovery and data contracts meet the revisit conditions in [D009](../decisions/D009-agent-slice-unit-file.md), [D010](../decisions/D010-agent-names-confirmed-by-install-location.md) or [D005](../decisions/D005-shared-agent-tool-data.md).

## Not governed

Reading severity: [verdict.md](verdict.md). Automatic correction: [warden.md](warden.md). Build totals: [layers.md](layers.md).
