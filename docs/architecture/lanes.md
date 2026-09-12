# Lanes and processes

Covers: src/model/lanes.ts src/model/naming.ts src/model/launcher.ts src/model/scopes.ts src/model/alerts.ts src/collect/procs.ts src/collect/tmux.ts

A lane is a watched scope, or a group an agent or a resource alarm made worth watching. The collector reads the processes; the model derives the lane, its name, its launch trail and the alert rules that fire on it.

## Boundaries

- `unitLabel()` in `src/model/naming.ts` is the only place a systemd unit name becomes a name a screen shows. It drops the `app-` launcher prefix, the unit suffix and the generated field systemd adds for uniqueness, and decodes `\xNN` escapes.
- `distinctNames()` in `src/model/naming.ts` is the only rule for names that repeat, and its one caller is Resources. Lanes do not use it: a lane name is never added to, and two lanes resolving to one name are told apart by the process id column beside them.
- `laneText()` in `src/model/naming.ts` names a lane in prose, where there is no column to carry the process id: the name, then `PID` and the process leading it, or the name alone for a lane leading none.
- A lane name joins the configured parts in the configured order and leaves out a part with no value. `pane` is still accepted as a part so a stored config keeps loading, but it composes nothing.
- A tmux pane id such as `%9` is unique only within one server, so the lane keeps it as the handle `tmux switch-client -t` takes and never as a name. One `tmux list-panes` per sample resolves every lane at once into a `session:window.pane` address.
- `isPaneId` decides one thing: whether a value is `%N` and can be looked up in the pane map. A reader who configured an address instead already has what they would type, so it stands as the address and carries no window name, which only the server holds.
- A handle is resolved only against the server it belongs to. The lane carries the `TMUX` value its own shell exported, and a handle whose server is known to differ resolves to nothing rather than naming a stranger's pane.
- `scopeMain()` in `src/model/scopes.ts` picks a scope's main process: the oldest member whose parent sits outside the scope.
- `launcherTrail()` in `src/model/launcher.ts` reads the facts of one process and states no prose: the scope it names is the unit name, not a phrase. `launcherCopy()` writes the prose a card draws, and is the only place that writes it: it groups the trails by the four facts a sentence states, keyed on the whole cgroup path, and gives each group a conclusion and an ancestor clause the card can drop on its own, taken from a member whose ancestors the sample still holds.

## Invariants

1. An escaped agent is a configured tool outside the configured agent slice, decided once by `escaped()`. `src/collect/collector.test.ts` checks an escaped agent against an inherited cap.
2. An excluded argv pattern matches an executable name or a whole flag, never prompt text. `src/collect/collector.test.ts` checks a prompt naming a language server, and that exclusion hides a helper but never an agent lane.
3. The environment of an escaped agent is read from that agent, not from its scope's main process, and scope launch metadata belongs to the scope's main process. `src/collect/collector.test.ts` checks an agent child of a pane shell and a wrapper with an agent child.
4. A launcher trail states the ancestors and their cgroups, the confinement markers and any PATH prefix, and names a repeated neighbour in the chain once. Markers with the wrong cgroup mean a shadowed launcher, their absence a bare launch, and an unreadable environment neither. `src/model/launcher.test.ts` checks all three.
5. One sentence covers every process agreeing on all four facts it states: the conclusion, the cgroup, the markers set on them and the PATH entries ahead of the login shell's own. It names the markers once, the scope once with the count of processes in it, and the ancestors once for an example process it names by PID. `src/model/launcher.test.ts` groups six processes in one scope, ten over two, and pairs differing only by marker set, only by PATH prefix, and only by the slice above a scope of one unit name.
6. A lane name joins the configured parts in the configured order and leaves out a part with no value. `src/model/naming.test.ts` checks the order; `src/model/lanes.test.ts` checks two accounts in one worktree and a lane naming no account.
7. No lane name carries a pane address or a disambiguator, and no unit name reaches a screen carrying a `\xNN` escape, the `app-` prefix or a `.scope` suffix. `src/model/naming.test.ts` checks the unit forms; `src/model/lanes.test.ts` checks that a name holds no separator the server gave it.
8. No two resource groups in one sample render the same name, and hiding the idle rows never renames one. `src/ui/resources.test.tsx` checks the separation and the filtered list.
9. Per-lane page cache, I/O rates, CPU share and cgroup weight stay unknown when the kernel did not report them, and an unread cgroup tree leaves the effective memory cap unknown rather than unlimited. `src/model/lanes.test.ts` checks a group with no counters and a lane with no covering group.
10. A cgroup limit file holds a number or the word max, so a file that could not be read leaves the effective cap known only when every covering ancestor was read. `src/collect/collector.test.ts` removes an ancestor's `memory.max`.
11. A blocked lane counts its tasks in uninterruptible wait and names storage or memory by the higher stall share, naming neither when the pressure is unknown. `src/model/lanes.test.ts` checks both resources and unknown pressure.
12. Process environment caching uses the PID with its start time, so a reused PID is a different process. `src/collect/collector.test.ts` exercises PID reuse and environment selection.
13. When a PID appears in sibling scope lists, its process membership file selects the row. `src/collect/collector.test.ts` checks that fallback.
14. Each new escaped agent emits its own alert even inside an already alarmed scope, and every rule clears before it rearms. `src/model/alerts.test.ts` checks process identity and rearming.
15. One tmux read resolves every lane's pane whatever the number of lanes, and a server that stops answering costs the addresses rather than the sample. `src/collect/collector.test.ts` counts the reads and fails one on purpose.
16. A configured pane address is a target tmux accepts rather than one vsys refuses, and a pane on another server resolves to nothing. `src/model/lanes.test.ts` and `src/collect/tmux.test.ts` check both, including a restarted server on one socket path.
