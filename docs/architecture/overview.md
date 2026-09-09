# Architecture

Each sample contains observed values and source errors. A failed read must remain distinguishable from a measured zero. The collector reads system files. Settings, history, exports, and optional notifications are separate application effects.

## Terms

- Scope: a systemd cgroup whose name ends in `.scope`.
- Lane: a watched scope or a group with an agent or resource alarm.
- Escaped agent: a configured agent tool outside the configured agent slice.
- CPU percent: utilization in units of one logical core.
- Pressure: the recent percentage of time that tasks stalled on a resource.
- Pinned Fleet: the recorded sample selected by the timeline cursor.
- Checkpoint: a complete snapshot followed by exact changes to its values.

## Boundaries

- Collectors depend on source files and typed configuration. They do not import the UI or write kernel state.
- Scratch traversal runs as a cooperative background task during interactive collection. Snapshots carry its measurement time and pending state. Scripted collection waits for a complete scan.
- The mount parser owns mount roots and path escaping for cgroup and filesystem collection.
- The model derives lanes and alert transitions. Desktop notifications require per-rule configuration.
- The runtime owns collection, history, and settings changes for a running dashboard.
- The history store owns application persistence. The collector does not depend on SQLite.
- The UI consumes snapshots. It reads open scratch descriptors only for a live selected lane.

## Invariants

- Process environment caching uses PID and start time. `src/collect/collector.test.ts` exercises PID reuse and environment selection.
- Scope launch metadata belongs to the scope's main process. `src/collect/collector.test.ts` checks a wrapper with an agent child.
- When a PID appears in sibling scope lists, its process membership file selects the row. `src/collect/collector.test.ts` checks that fallback.
- A source error does not turn into zero utilization. `src/collect/collector.test.ts` plants an invalid counter.
- Device error deltas use filesystem and device identity. `src/collect/btrfs.test.ts` checks sample and startup baselines.
- Missing mount information or device counters remain unknown in history. `src/store/point.test.ts` and `src/collect/btrfs.test.ts` check those failures.
- Aborted scrubs remain problems even when they counted no errors. `src/collect/btrfs.test.ts` checks that condition.
- Each new escaped agent can emit an alert within an already alarmed scope. `src/model/alerts.test.ts` checks process identity and rearming.
- Collection does not overlap itself when settings change. `src/runtime.test.ts` controls an in-flight source and checks rescheduling.
- Failed settings writes preserve active history. `src/runtime.test.ts` checks replacement failure.
- Saving settings through a file link preserves the link. `src/config/config.test.ts` checks the target contents.
- Historical snapshots remain independent of live objects and callers. `src/store/archive.test.ts` checks exact reconstruction and mutation isolation.
- Settings changes and persistence changes preserve retained incidents. `src/store/history.test.ts` checks transfer and database merging.
- History storage rejects a database with another application's schema. `src/store/history.test.ts` checks tables and views.
- Timeline positions follow timestamps. `src/ui/format.test.ts` checks collection gaps and alert alignment.
- Process text cannot emit terminal controls. `src/ui/format.test.ts` checks the display sanitizer.
- Interactive quit restores the terminal, including when history shutdown fails. `src/main.test.ts` checks isolated terminals. `src/runtime.test.ts` checks error delivery when collection and shutdown both fail.

## Validation limits

The archive caps compressed replay data. It reports shortened retention when the data exceeds that budget and persistence is off. SQLite retains snapshots beyond the memory cache and across restarts.

`scripts/bench-history.ts` checks the configured history window with changing process identities. It verifies selected complete snapshots against their originals. Its generated workload does not establish a memory bound for every possible command line or process workload.

The collector benchmark uses regular-file fixtures. Its result does not guarantee live procfs latency. [Plan coverage](plan-coverage.md) records the implementation and checks for each screen.
