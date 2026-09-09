# Architecture

Each sample contains observed values and source errors. A failed read must remain distinguishable from a measured zero. The collector reads system files. Settings, history, exports, and optional notifications are separate application effects.

## Terms

- Scope: a systemd cgroup whose name ends in `.scope`.
- Lane: a watched scope or a group with an agent or resource alarm.
- Escaped agent: a configured agent tool outside the configured agent slice.
- Account: the basename of the agent configuration directory the lane's main process names, unknown when it names none.
- Cause: one detected problem, held as data with its level, subjects, named consumer and numbers. Every lane with the same cause shares one cause.
- Ladder: the causes ranked by impact on the person at the keyboard. Its first element is the verdict; every element is one attention card.
- CPU percent: utilization in units of one logical core.
- Pressure: the recent percentage of time that tasks stalled on a resource.
- Pinned Fleet: the recorded sample selected by the timeline cursor.
- Checkpoint: a complete snapshot followed by exact changes to its values.

## Boundaries

- Collectors depend on source files and typed configuration. They do not import the UI or write kernel state.
- The model derives lanes, the cause ladder, the meters and alert transitions as numbers. Every word and every formatted number belongs to the UI.
- The runtime owns collection, history, and settings changes for a running dashboard. A replaced source is handed its predecessor, so readings measured since vsys started survive the replacement.
- The history store owns application persistence. The collector does not depend on SQLite.
- `escaped()` in `src/model/lanes.ts` is the only definition of an agent outside its slice. Lanes, alerts, history points and timeline events all call it.
- The UI consumes snapshots. It reads open scratch descriptors only for a live selected lane.

## Invariants

- A source error does not turn into zero utilization. `src/collect/collector.test.ts` plants an invalid counter.

## Topics

- [Lanes and processes](lanes.md): how a lane is found, named and traced back to its launcher.
- [Cause ladder and verdict](verdict.md): how one detection becomes the verdict and its attention card.
- [Build work](builds.md): how compile and link work, the build cache and the token pools are counted.
- [Storage and devices](storage.md): filesystem state, bytes written, drive reports and scratch sizes.
- [Timeline events](events.md): what the timeline records, and how a change is held until it counts.
- [History store](history.md): replay, retention, persistence and their validation limits.
- [Settings and the runtime](settings.md): what a settings change replaces and what it preserves.
- [UI behaviour](ui.md): the mounted tree, navigation, and the words and units every view prints.
- [Plan coverage](plan-coverage.md): the implementation and the checks for each screen.
