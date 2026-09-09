# Plan coverage

Covers: src/ scripts/bench.ts scripts/bench-history.ts

The [application plan](../plans/2026-09-06-vsys-view-plan.md) defines the collection and replay requirements. The [UI constraints](ui.md) define refresh, navigation and display ownership.

## Screens

| Screen | Behaviour | Verification |
| --- | --- | --- |
| Overview | One ranked cause ladder: its first element is the verdict line, every element is a card with a next step and a copyable command; four meters that each name their biggest consumer; unreadable sources in a footer | `src/model/verdict.test.ts`, `src/model/launcher.test.ts`, `src/ui/overview.test.ts`, `src/ui/App.test.tsx` |
| Fleet | Searchable lane summaries naming account, agent, pane and workspace; optional full table with sorting, column visibility and order; resource and limit colours | Collector fixtures, `src/model/naming.test.ts`, `src/ui/format.test.ts`, `src/ui/screen.test.tsx`, `src/ui/theme.test.tsx` |
| Lane | Cgroup, memory, page cache, swap, CPU share, I/O rates, build work by kind, compiler cache clients, effective caps and the blocked reason; complete lane history; launch environment, process tree and live scratch descriptors | Collector fixtures, `src/model/lanes.test.ts`, `src/store/lane-series.test.ts`, `src/ui/App.test.tsx` |
| Slices | Cgroup tree, sibling CPU weight share, quotas, memory, swap, task limits and pressure | Typed source fixtures and rendered navigation test |
| Builds | Fleet compile and link total against cores, per-lane rows with linkers named, build cache effectiveness and make token pools, then per-process classification, threads, CPU, RSS, directory and elapsed time | Build classifier fixtures, summary and line tests, build cache parser and delta tests |
| Storage | Bytes written since boot per slice and per device, drive lifetime writes; below them mount state, device counters and deltas, scrub reports, free space, scratch sizes and measurement age | `src/model/writes.test.ts`, `src/ui/storage.test.ts`, `src/collect/devices.test.ts`, mount parser, Btrfs and scratch tests |
| Timeline | Resource series, corruption, escaped agents and builds; time cursor, alert markers and Fleet pinning | Time-bucket tests, CPU role tests, archive replay and rendered pinning test |
| Alerts | Rule transitions, pressure hold time, per-rule notifications and source errors | Rule and notification tests |
| Settings | Validated TOML, named settings, editable keys, display preferences and history configuration | Configuration, settings UI and runtime replacement tests |

## Storage and runtime

- The collector reads system state. Settings, optional SQLite, requested exports and enabled notifications are separate application effects.
- In-memory replay uses complete checkpoints and exact changes. A warning reports retention shortened by the memory budget.
- SQLite preserves replay across restarts and rejects databases owned by other applications. Records an older build wrote are normalized on load rather than discarded.
- Lane charts retain samples before display aggregation. Buckets preserve short spikes and collection gaps.
- Live scratch traversal runs separately from process refresh. Scripted collection waits for completion.
- The terminal has one mounted application tree. Repeated refresh updates its state and preserves navigation.
- Shutdown closes application tasks and restores terminal settings. Tests use terminals created for the test.

## Plan choices

- Fleet defaults to summaries. The full table retains column visibility, ordering and sorting. Other views use trees, grouped records or charts.
- Notifications use `notify-send` with explicit per-rule settings. Alert hook execution is absent.
- Lifetime writes are read from `smartctl -A` reports left in a configured directory, as scrub reports are. vsys runs no privileged helper of its own, so a drive with no report keeps its lifetime writes unknown.

## Verification

| Command | Scope |
| --- | --- |
| `python3 scripts/ci.py` | Dependency installation, lint, types, application tests and build; use the project runtime described in [Development](../../DEVELOPMENT.md) |
| `bun run bench` | Collection cost for the scope and process counts in the plan; regular-file fixtures do not guarantee live procfs latency |
| `bun run bench:history` | Default retention window with process churn and exact snapshot comparisons; generated data does not establish a universal memory bound |
| `npm outdated --json` | Direct dependency versions against the registry |
