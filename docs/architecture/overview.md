# vsys architecture

vsys is a Linux terminal dashboard for agent processes and system health. It reads cgroup v2, procfs and a few user-space reports, derives one ranked account of what is wrong, and draws it in one mounted terminal tree. It changes system state only through a confirmed lane action.

## The one idea

A sample is observed values together with the source errors met while reading them, and the two never collapse into each other. A counter the kernel did not report, a file this user may not read and a parse that failed each stay unknown; none of them becomes a zero. Every screen, meter and alert reads that one sample, so a reading a dashboard cannot make is drawn blank rather than as an untroubled number.

## Vocabulary

Scope: a systemd cgroup whose name ends in `.scope`. Only a scope can be named to `systemctl`, so only a lane in one can be acted on.

Lane: a watched scope, or a group an agent or a resource alarm made worth watching.

Escaped agent: a configured agent tool running outside the configured agent slice. `escaped()` in `src/model/lanes.ts` is its only definition.

Account: the basename of the agent configuration directory the lane's main process names, unknown when it names none.

Cause: one detected problem held as data, with its level, its subjects, its named consumer and its numbers. Every lane hitting the same problem shares one cause.

Ladder: the causes ranked worst first. Its first verdict-worthy element is the verdict, and every element is one attention card.

Verdict-worthy: a cause that may speak for the machine. A housekeeping cause is a card but never the verdict.

Capability: a system interface a reading needs, probed once at start. Whether a tmux server answers is the exception and is re-read each sample.

Point: the per-sample record the charts and the timeline strip read, kept for every retained sample.

Checkpoint: a complete stored snapshot, followed by exact changes to its values.

Pinned sample: the recorded sample the timeline cursor selects.

CPU percent: utilization in units of one logical core, so one saturated core reads as 100%.

Pressure: the recent percentage of time that tasks stalled on a resource.

## Boundaries

- `src/collect/`: reads source files and takes `CollectionConfig`. It never imports the UI and never writes kernel state. Enforced by the type in `src/collect/settings.ts`, which is the only declaration of what collection may read.
- `src/model/`: derives lanes, the cause ladder, the meters and the alert transitions as numbers. Every word and every formatted number belongs to the UI.
- `src/store/`: owns application persistence and derives the timeline events. The collector does not depend on SQLite.
- `src/runtime.ts`: owns scheduling and settings changes. Samples never overlap, and a replaced source is handed its predecessor so readings measured since vsys started survive the replacement.
- `src/ui/`: consumes snapshots. It opens views and exports evidence, and reaches the system only through a confirmed lane action.
- `runEffect()` in `src/effect.ts` is the one function that changes system state. Moving the reader's own tmux view is not one of its effects, because it changes no process.
- OpenTUI's React root builds a new reconciler container on each `render` call, so `mountScreen` renders once and live samples reach the tree through React's external-store subscription.

## Invariants

1. A source error never becomes a measured zero. `src/collect/collector.test.ts` plants an invalid counter.
2. An agent outside its slice is decided in one place, and lanes, alerts, points and timeline events all read that decision. `src/collect/collector.test.ts` checks an escaped agent against an inherited cap.
3. Repeated refresh leaves one mounted screen, a stable listener count and the selected view. `src/ui/screen.test.tsx` drives the production mount function.
4. No lane action reaches an effect while write mode is off, while a past sample is pinned, or when the current sample no longer names the confirmed line. `src/ui/agent.test.tsx` checks all four answers and `src/model/actions.test.ts` pins each command.
5. Every host-specific name ships a systemd user-session default, and write mode ships off. `src/config/config.test.ts` checks both.

## Decisions

- [D001](../decisions/D001-clipboard-sequence.md): vsys builds its own OSC 52 clipboard sequence, because the renderer's own call writes through a native core no test can read.
- [D002](../decisions/D002-lane-action-mechanism.md): Freeze and Thaw write the lane's own `cgroup.freeze`; Stop asks systemd to signal the scope.
- [D003](../decisions/D003-action-resolved-at-the-keypress.md): what a screen holds carries no effect, so a stale confirmation cannot reach the system.

## Topics

- [lanes.md](lanes.md): read when changing how a lane is found, named, or traced back to its launcher.
- [verdict.md](verdict.md): read when changing what counts as a problem or how problems rank.
- [builds.md](builds.md): read when changing how compile and link work, the build cache or the token pools are counted.
- [storage.md](storage.md): read when changing filesystem, device, drive or scratch collection.
- [events.md](events.md): read when changing what the timeline records or when a change counts.
- [history.md](history.md): read when changing replay, retention or persistence.
- [settings.md](settings.md): read when adding a setting or changing what a settings change replaces.
- [ui.md](ui.md): read when changing the shell, a screen, colour, or what the reader can act on.

Subsystems with no topic file of their own: `src/model/export.ts` writes the JSON and Markdown exports and strips terminal controls from display text; `src/model/shell.ts` quotes a copied command so a paste survives an escaped scope name; `src/collect/io.ts` holds the `Reader` that records a source error against the source that failed; `src/collect/system.ts` and `src/collect/cgroups.ts` read machine totals and the cgroup tree; `src/config/editor.ts` parses a setting a reader typed.
