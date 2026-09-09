# vsys-view

vsys-view is a Linux terminal dashboard for people who run AI agents. It shows which work needs attention, where resources go, and what happened before a problem.

## Install

Run these commands from the repository:

```sh
bun install
bun run start
```

The project includes its Bun runtime. The system Bun installation stays separate.

## Features

- Overview of current problems, CPU use, memory, build work and storage.
- Searchable Fleet summaries with an optional full table.
- Lane details with memory limits, charged resources, build work, resource history and process ancestry.
- Resource groups, build activity, Btrfs health and scratch measurements.
- A timeline of what changed with its cause, and Fleet at a past sample.
- Editable settings, mouse navigation and incident exports.

## How it works

Start with Overview and select an item under Needs attention now to inspect its cause. Open Fleet to find a lane by name, account, pane, branch or worktree. A lane name joins the account, the agent, the terminal pane and the workspace, so two agents in one worktree stay apart. Open a lane to compare resource use with its limits. Open Timeline to read what changed and why: lanes starting and stopping, processes moving between cgroups, alerts opening and closing with how long they lasted, and each new verdict. Use Alerts for the recorded rule transitions; Overview shows current observations. A partial-data notice means some sources could not be read.

The collector reads system files with your permissions. Application writes are limited to settings, optional history and requested exports. Desktop notifications require an enabled rule.

## Controls

These are the default keys. The footer shows controls for the current screen.

| Action | Key |
| --- | --- |
| Open Overview | `0` |
| Open Fleet | `1` |
| Select a lane or concern | Up / Down |
| Inspect the selection | Enter |
| Find a lane in Fleet | `/` |
| Apply search / clear search | Enter / Esc while searching |
| Switch Fleet summary / full table | `d` |
| Choose table columns | `c` |
| Open Settings | `,` |
| Quit the dashboard | `q` or Ctrl+C |

## Settings

Settings are stored in `~/.config/vsys-view/config.toml`. The menu controls watched slices, paths, thresholds, table columns, colours, units and keys. `laneNameParts` chooses which parts name a lane and in which order; the pane address and window title come from the variables the pane exports. CPU use is measured per core; the Overview explains the scale.

History persistence is off by default. Enable it to replay incidents after a restart. A retention warning means the in-memory budget cannot hold the selected window.

Storage opens with the bytes written since boot by each watched slice and by each drive, then the drive lifetime writes. Device totals are read at the resource group root, so they include services outside your session. A `dm-` row repeats the writes of the disk beneath it.

Lifetime writes are read from `smartctl -A` output in the SMART report directory, which a privileged timer writes. Name each report after its device in `/sys/block`, with at most one extension: `/run/smartctl/nvme0n1.txt` matches the drive `nvme0n1`. A file matching no device is ignored. Every drive keeps its own row, so a drive with no report is named and shows "not available".

Scratch scans run separately from live refresh. Storage shows the measurement time and scan state. Scripted snapshots wait for the scan to finish. Use `bun run start -- --help` for export and scripting options.

## Development

See [Development](DEVELOPMENT.md) for validation, [UI behaviour](docs/architecture/ui.md) for rendering constraints, and [plan coverage](docs/architecture/plan-coverage.md) for verification references.
