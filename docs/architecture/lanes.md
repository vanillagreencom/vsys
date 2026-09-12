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
- One pane on that server is vsys's own, the one it draws in. `lanes()` marks the lane holding it in either form a lane carries a pane, the `%N` handle from `TMUX_PANE` and the `session:window.pane` address from `VSYS_PANE`, and under one rule for both: only where the lane names the server vsys is attached to. Neither form names the server it belongs to, since every fresh server hands out `%1` and a second server holds a session named `vsys` with a window 2 and a pane 1 as readily. A target naming a window rather than an index, such as `vsys:build.1`, is a third spelling of the same pane and matches neither.
- Both halves that mark rests on, the server vsys is attached to and the handle of the pane it draws in, come from vsys's own environment rather than from the server's answer, so the handle form still marks its lane after a `list-panes` that failed. Only the address form needs the read, because only the map says which pane an address names. A vsys running outside tmux is a client of no server and draws in no pane, so it marks nothing.
- `scopeMain()` in `src/model/scopes.ts` picks a scope's main process: the oldest member whose parent sits outside the scope.

## Invariants

1. An escaped agent is a configured tool outside the configured agent slice, decided once by `escaped()`. `src/collect/collector.test.ts` checks an escaped agent against an inherited cap.
2. An excluded argv pattern matches an executable name or a whole flag, never prompt text. `src/collect/collector.test.ts` checks a prompt naming a language server, and that exclusion hides a helper but never an agent lane.
3. The environment of an escaped agent is read from that agent, not from its scope's main process, and scope launch metadata belongs to the scope's main process. `src/collect/collector.test.ts` checks an agent child of a pane shell and a wrapper with an agent child.
4. A launcher trail states the ancestors and their cgroups, the confinement markers and any PATH prefix. Markers with the wrong cgroup mean a shadowed launcher, their absence a bare launch, and an unreadable environment neither. `src/model/launcher.test.ts` checks all three.
5. A lane name joins the configured parts in the configured order and leaves out a part with no value. `src/model/naming.test.ts` checks the order; `src/model/lanes.test.ts` checks two accounts in one worktree and a lane naming no account.
6. No lane name carries a pane address or a disambiguator, and no unit name reaches a screen carrying a `\xNN` escape, the `app-` prefix or a `.scope` suffix. `src/model/naming.test.ts` checks the unit forms; `src/model/lanes.test.ts` checks that a name holds no separator the server gave it.
7. No two resource groups in one sample render the same name, and hiding the idle rows never renames one. `src/ui/resources.test.tsx` checks the separation and the filtered list.
8. Per-lane page cache, I/O rates, CPU share and cgroup weight stay unknown when the kernel did not report them, and an unread cgroup tree leaves the effective memory cap unknown rather than unlimited. `src/model/lanes.test.ts` checks a group with no counters and a lane with no covering group.
9. A cgroup limit file holds a number or the word max, so a file that could not be read leaves the effective cap known only when every covering ancestor was read. `src/collect/collector.test.ts` removes an ancestor's `memory.max`.
10. A blocked lane counts its tasks in uninterruptible wait and names storage or memory by the higher stall share, naming neither when the pressure is unknown. `src/model/lanes.test.ts` checks both resources and unknown pressure.
11. Process environment caching uses the PID with its start time, so a reused PID is a different process. `src/collect/collector.test.ts` exercises PID reuse and environment selection.
12. When a PID appears in sibling scope lists, its process membership file selects the row. `src/collect/collector.test.ts` checks that fallback.
13. Each new escaped agent emits its own alert even inside an already alarmed scope, and every rule clears before it rearms. `src/model/alerts.test.ts` checks process identity and rearming.
14. One tmux read resolves every lane's pane whatever the number of lanes, and a server that stops answering costs the addresses rather than the sample. `src/collect/collector.test.ts` counts the reads and fails one on purpose.
15. A configured pane address is a target tmux accepts rather than one vsys refuses, and a pane on another server resolves to nothing. `src/model/lanes.test.ts` and `src/collect/tmux.test.ts` check both, including a restarted server on one socket path.
16. The lane holding the pane vsys draws in is marked as its own in both forms a lane can carry it, under one rule for both: only where the lane names the server vsys is attached to. The handle form marks its lane still when the pane read failed; the address form needs the map that read carries. `src/model/lanes.test.ts` tables both forms against vsys's own server, another server and no server, and checks a pane that is not vsys's, a vsys outside tmux and an empty map; `src/collect/tmux.test.ts` checks what one read carries; `src/collect/collector.test.ts` checks a sample whose read answered and one whose read failed.
