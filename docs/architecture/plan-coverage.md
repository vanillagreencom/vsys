# Plan coverage

Covers: src/ scripts/bench.ts scripts/bench-history.ts

The [architecture overview](overview.md) defines the collection and replay requirements. The [UI constraints](ui.md) define refresh, navigation and display ownership.

## Screens

| Screen | Behaviour | Verification |
| --- | --- | --- |
| [Home](verdict.md) | The verdict line, four meter tiles with sparklines, one card per cause with a next step and a command the copy key sends to the clipboard, the busiest agents, and the unreadable-source footer | `src/model/verdict.test.ts`, `src/model/launcher.test.ts`, `src/ui/attention.test.ts`, `src/ui/clipboard.test.ts`, `src/ui/home.test.ts`, `src/ui/App.test.tsx` |
| [Agents](lanes.md) | Searchable rows naming account, agent, pane and workspace with a CPU bar and a badge; optional full table with sorting, column visibility and order | Collector fixtures, `src/model/naming.test.ts`, `src/ui/format.test.ts`, `src/ui/agents.test.ts`, `src/ui/screen.test.tsx`, `src/ui/theme.test.tsx` |
| [Agent](lanes.md) | Cgroup, memory, page cache, swap, CPU share, I/O rates, build work by kind, compiler cache clients, effective limits and the blocked reason; CPU, memory and wait history; processes, launch, open files and the Freeze, Thaw and Stop actions in closed sections | Collector fixtures, `src/model/lanes.test.ts`, `src/model/actions.test.ts`, `src/store/lane-series.test.ts`, `src/ui/App.test.tsx` |
| Resources | Meter facts, swap, the cgroup tree with CPU and memory bars, idle leaves hidden until asked, limits and pressure for the selected group | `src/ui/resources.test.ts`, rendered navigation test |
| [Builds](builds.md) | Compile and link against cores, cache hit rate and make token pools as tiles, per-lane rows with linkers named, the processes of the selected lane on request | Build classifier fixtures, `src/ui/builds-screen.test.ts`, `src/ui/attention.test.ts`, build cache parser and delta tests |
| [Storage](storage.md) | Bytes written since boot per slice and per device as bars, drive lifetime writes, filesystems with free space and read-only state, error counters and options for the selected one, scrub reports, scratch sizes against the quota | `src/model/writes.test.ts`, `src/ui/storage-screen.test.ts`, `src/collect/devices.test.ts`, mount parser, Btrfs and scratch tests |
| [Timeline](events.md) | Agents CPU and memory charts, wait and build sparklines, a time cursor with the values under it, change markers, and what changed with its cause; sample pinning | `src/store/events.test.ts`, `src/ui/timeline.test.ts`, `src/ui/timeline-screen.test.ts`, time-bucket tests, archive replay and rendered pinning test |
| [Settings](settings.md) | Probed capabilities, unreadable sources on request, then validated settings by group with in-place editing | Configuration, `src/ui/settings.test.ts`, `src/ui/settings-screen.test.ts` and runtime replacement tests |

## Storage and runtime

The [history store](history.md) and [settings and the runtime](settings.md) hold the invariants behind this section.

- The collector reads system state. Settings, optional SQLite, requested exports, enabled notifications and confirmed lane actions are separate application effects.
- A lane action changes system state and runs only with `writeMode` on, after a confirmation naming the scope. `src/model/actions.ts` returns the command without running it, so the exact line is pinned by a test.
- In-memory replay uses complete checkpoints and exact changes. A warning reports retention shortened by the memory budget.
- SQLite preserves replay across restarts and rejects databases owned by other applications. Records an older build wrote are normalized on load rather than discarded.
- Lane charts retain samples before display aggregation. Buckets preserve short spikes and collection gaps.
- Live scratch traversal runs separately from process refresh. Scripted collection waits for completion.
- The terminal has one mounted application tree. Repeated refresh updates its state and preserves navigation.
- Shutdown closes application tasks and restores terminal settings. Tests use terminals created for the test.

## Plan choices

- Agents defaults to rows. The full table retains column visibility, ordering and sorting. Other views use trees, grouped records or charts.
- Rule transitions have no screen of their own: alerts opening and closing appear in the Timeline change list, and unreadable sources under Settings.
- Notifications use `notify-send` with explicit per-rule settings. Alert hook execution is absent.
- Lifetime writes are read from `smartctl -A` reports left in a configured directory, as scrub reports are. Each file is named after its `/sys/block` device with at most one extension, and a file matching no device is ignored. vsys runs no privileged helper of its own, so a drive with no report keeps its lifetime writes unknown.

## Verification

| Command | Scope |
| --- | --- |
| `python3 scripts/ci.py` | Dependency installation, lint, types, application tests and build; use the project runtime described in [Development](../../DEVELOPMENT.md) |
| `bun run bench` | Collection cost for the scope and process counts in the plan; regular-file fixtures do not guarantee live procfs latency |
| `bun run bench:history` | Default retention window with process churn and exact snapshot comparisons; generated data does not establish a universal memory bound |
| `npm outdated --json` | Direct dependency versions against the registry |
