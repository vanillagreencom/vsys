# vsys architecture

vsys is a Linux terminal dashboard for agent processes and system health. The dashboard reads cgroup v2, procfs and a few user-space reports, derives one ranked account of what is wrong, and draws it in one mounted terminal tree. It changes system state only through a confirmed lane action. The optional warden in `warden/` is the exception: it corrects agent process placement automatically.

## The one idea

A sample is observed values together with the source errors met while reading them, and the two never collapse into each other. A counter the kernel did not report, a file this user may not read and a parse that failed each stay unknown; none of them becomes a zero. Every screen, meter and alert reads that one sample, so a reading a dashboard cannot make is drawn blank rather than as an untroubled number.

## Vocabulary

Scope: a systemd cgroup whose name ends in `.scope`. Only a scope can be named to `systemctl`, so only a lane in one can be acted on.

Lane: a watched scope, or a group an agent or a resource alarm made worth watching.

Escaped agent: a configured agent tool running outside the configured agent slice, on a machine that has that slice. `escaped()` in `src/model/lanes.ts` is its only definition.

Account: the basename of the agent configuration directory the lane's main process names, unknown when it names none.

Cause: one detected problem held as data, with its level, its subjects, its named consumer and its numbers. Every lane hitting the same problem shares one cause.

Ladder: the causes ranked worst first. Its first verdict-worthy element is the verdict, and every element is one attention card.

Verdict-worthy: a cause that may speak for the machine. A housekeeping cause is a card but never the verdict.

Capability: a system interface a reading needs, probed once at start. Three answers are re-read each sample: whether a tmux server answers, whether the agent slice exists, and whether the scrub report directory exists, which the storage read of the reports answers. The kernel log is a capability too, because whether this user can read the system journal depends on group membership.

Point: the per-sample record the charts and the timeline strip read, kept for every retained sample.

Checkpoint: a complete stored snapshot, followed by exact changes to its values.

Pinned sample: the recorded sample the timeline cursor selects.

CPU percent: utilization in units of one logical core, so one saturated core reads as 100%.

Pressure: the recent percentage of time that tasks stalled on a resource.

## Boundaries

- `src/collect/`: reads source files and takes `CollectionConfig`. It never imports the UI and never writes kernel state. Enforced by the type in `src/collect/settings.ts`, which is the only declaration of what collection may read. Three reads sit outside it, and the program hands the collector each. One is the tmux server: vsys's own `TMUX` and `TMUX_PANE` and the `tmux list-panes` that `src/collect/tmux.ts` runs. Another is whether the agent slice's systemd unit file or drop-in directory exists in the standard unit directories ([D009](../decisions/D009-agent-slice-unit-file.md)). The third is the desktop paths of the shared agent-tool data with the machine overlay merged in ([D005](../decisions/D005-shared-agent-tool-data.md)). A collector given none of them reads no tmux server, no unit directory and only the shipped desktop paths, so no test reaches the host's tmux server, its systemd configuration or its overlay unless it asks to. `src/collect/capabilities.test.ts` and `src/collect/collector.test.ts` check the unit-file read. The program reads processes on a thread of its own, which the collector owns and the runtime never schedules.
- `src/model/`: derives lanes, the cause ladder, the meters and the alert transitions as numbers. Every word and every formatted number belongs to the UI.
- `src/store/`: owns application persistence and derives the timeline events. The collector does not depend on SQLite.
- `src/runtime.ts`: owns scheduling and settings changes. Samples never overlap, and a replaced source is handed its predecessor so readings measured since vsys started survive the replacement.
- `src/ui/`: consumes snapshots. It opens views and exports evidence, and reaches the system only through a confirmed lane action.
- `runEffect()` in `src/effect.ts` is the one dashboard function that changes system state. Moving the reader's own tmux view is not one of its effects, because it changes no process. `src/warden.ts` only dispatches to the optional warden before the dashboard starts. The optional warden changes process placement outside the dashboard runtime.
- OpenTUI's React root builds a new reconciler container on each `render` call, so `mountScreen` renders once and live samples reach the tree through React's external-store subscription.

## Invariants

1. A source error never becomes a measured zero. `src/collect/collector.test.ts` plants an invalid counter.
2. An agent outside its slice is decided in one place, and lanes, alerts, points and timeline events all read that decision. Where the probe finds no agent slice, no agent is escaped. `src/collect/collector.test.ts` checks an escaped agent against an inherited cap, and two agents with and without the slice.
3. Repeated refresh leaves one mounted screen, a stable listener count and the selected view. `src/ui/screen.test.tsx` drives the production mount function.
4. No lane action reaches an effect while write mode is off, while a past sample is pinned, or when the current sample no longer names the confirmed line. `src/ui/agent.test.tsx` checks all four answers and `src/model/actions.test.ts` pins each command.
5. Every host-specific name ships a systemd user-session default, and write mode ships off. `src/config/config.test.ts` checks both.
6. An indexed read that may find nothing is guarded where it is made. `tsconfig.json` sets `noUncheckedIndexedAccess`, so the type check treats every array element, record entry and match group as possibly undefined, including one read into a binding annotated that way, which the compiler would otherwise narrow to its initializer. `src/test/indexed-access.test.ts` type-checks an unguarded read and its guarded twin under the repository's own settings.

## Decisions

- [D001](../decisions/D001-clipboard-sequence.md): vsys builds its own OSC 52 clipboard sequence, because the renderer's own call writes through a native core no test can read.
- [D002](../decisions/D002-lane-action-mechanism.md): Freeze and Thaw write the lane's own `cgroup.freeze`; Stop asks systemd to signal the scope.
- [D003](../decisions/D003-action-resolved-at-the-keypress.md): what a screen holds carries no effect, so a stale confirmation cannot reach the system.
- [D004](../decisions/D004-warden-separate-component.md): the warden ships as a separate optional component, so the dashboard observes while the warden corrects.
- [D005](../decisions/D005-shared-agent-tool-data.md): the dashboard and the warden read the shipped agent-tool classification data instead of copying lists.
- [D006](../decisions/D006-settings-save-writes-only-changed-keys.md): Settings saves only changed keys, and agent-tool edits go to the shared overlay.
- [D007](../decisions/D007-scratch-scan-duty.md): scratch traversal runs on its own thread under a duty cycle, rather than keeping a filesystem index.
- [D008](../decisions/D008-process-reads-on-their-own-thread.md): processes are read on a thread the collector keeps, one file at a time, trading the 20 ms elapsed fixture target for lower processor time.
- [D009](../decisions/D009-agent-slice-unit-file.md): a slice whose unit file exists is present before its group does, so a defined, inactive agent slice still holds agents to it.

## Topics

- [lanes.md](lanes.md): read when changing how a lane is found, named, or traced back to its launcher.
- [agent-tools.md](agent-tools.md): read when changing which processes count as agent tools, or the shared agent-tool data.
- [processes.md](processes.md): read when changing how processes are read, the thread that reads them, or the lifecycle every collection thread shares.
- [verdict.md](verdict.md): read when changing what counts as a problem, how problems rank, or the summary JSON.
- [builds.md](builds.md): read when changing how compile and link work, the build cache or the token pools are counted.
- [storage.md](storage.md): read when changing filesystem, device, drive or scratch collection.
- [storage-integrity.md](storage-integrity.md): read when changing whether a filesystem reads as damaged or checked, the check report format, the kernel log reading or the scrub reporter under `scripts/scrub-reporter/`.
- [events.md](events.md): read when changing what the timeline records or when a change counts.
- [history.md](history.md): read when changing replay, retention or persistence.
- [settings.md](settings.md): read when adding a setting or changing what a settings change replaces.
- [ui.md](ui.md): read when changing the shell, colour, columns, regions, row expansions, cut marks, or what the reader can act on.
- [ui-screens.md](ui-screens.md): read when changing Home's cards, Storage's integrity rows, or the Agents list and agent detail.
- [warden.md](warden.md): read when changing the optional process-placement corrector under `warden/`.
- [warden-install.md](warden-install.md): read when changing `vsys warden install`, `warden/install` or the warden unit templates.
- [warden-status.md](warden-status.md): read when changing the warden status file or its fixtures.

Subsystems with no topic file of their own: `src/model/shell.ts` quotes a copied command so a paste survives an escaped scope name; `src/collect/io.ts` holds the `Reader` that records a source error against the source that failed, and `spawnText()`, which [lanes](lanes.md) describes; `src/collect/system.ts` and `src/collect/cgroups.ts` read machine totals and the cgroup tree; `src/config/editor.ts` parses a setting a reader typed.
