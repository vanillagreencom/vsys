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

- Home: the verdict for the machine, CPU, memory, disk and build tiles with history, and one card per current problem with its next step.
- Agents: every watched lane as a row with a CPU bar and a badge, a search, and an optional full table.
- Agent detail: resources against limits, history charts, the processes, launch and open files on request, and Freeze, Thaw and Stop for the lane's scope.
- A copy key that puts the selected command on the system clipboard through the terminal.
- Resources: the machine's meters and the cgroup tree, with idle groups hidden until asked.
- Builds: compile and link work against cores, cache hit rate, make token pools, and the building processes on request.
- Storage: bytes written per slice and per drive, drive lifetime writes, filesystems, scrub reports and scratch sizes.
- Timeline: charts over a chosen window, a time cursor, and what changed with its cause.
- Settings: what vsys can read on this machine, the sources it cannot, and every setting editable in place.
- A notice in the corner and a terminal notification when a serious problem appears.

## How it works

Home opens first. Its first line is the verdict: healthy, or the worst current cause. Select a card under Needs attention to read its detail, its next step and a command, press `y` to copy that command, then press Enter to open the agent or the screen it points at. Agents lists every lane; a lane name joins the account, the agent, the terminal pane and the workspace, so two agents in one worktree stay apart. Open a lane to compare its use with its limits and to unfold its processes. Timeline shows the last five minutes to the last day, and lists what changed and why: lanes starting and stopping, processes moving between cgroups, alerts opening and closing with how long they lasted, and each new verdict. Settings names the system interfaces vsys probed at start and the sources it could not read.

The dashboard uses the terminal's own sixteen colours. Red is serious, yellow is a warning, and the accent colour marks the selection and the active tab.

The collector reads system files with your permissions. Application writes are limited to settings, optional history, requested exports and, with `writeMode` on, a confirmed agent action. Desktop notifications through `notify-send` require an enabled rule.

## Controls

These are the default keys. The footer shows the keys for the current screen, and `?` lists them all.

| Action | Key |
| --- | --- |
| Open a screen | `1` to `7`, or click its tab |
| Next or previous screen | `Tab` / `Shift+Tab` |
| Select a row | `↑` `↓` or `k` `j` |
| Open the selection, or unfold a section | `Enter` |
| Back to the list | `Esc` |
| Find an agent | `/` |
| List or full table | `d` |
| Choose table columns | `c` |
| Sort column and direction | `s` / `r` |
| Move the time cursor | `←` `→` or `h` `l` |
| Change the time window | `w` |
| Show the machine at the cursor | `p` |
| Copy the selected command | `y` |
| Export JSON or Markdown | `e` / `m` |
| Quit | `q` or Ctrl+C |

## Settings

Settings are stored in `~/.config/vsys-view/config.toml`. The Settings screen groups them by what they change: display, history, thresholds, agents, builds, paths, program and keys. `laneNameParts` chooses which parts name a lane and in which order; the pane address and window title come from the variables the pane exports. vsys only reads system state unless `writeMode` is on: a card's remediation command is text to copy. With `writeMode` on, the Actions section of an agent detail can freeze, thaw or stop that lane's scope, each after a confirmation that names the scope and shows the exact line. An action needs live data: while a past sample is pinned it is refused, because another lane may hold that scope name by now. CPU use is measured per core, so one busy core reads as 100%.

The `theme` setting and the `overview`, `fleet`, `slices` and `alerts` keys are gone. A config file that still names them fails validation with the name of the setting to remove. The tabs are bound by `home`, `agents`, `resources`, `builds`, `storage`, `timeline` and `settings`.

History persistence is off by default. Enable it to replay incidents after a restart. A retention warning means the in-memory budget cannot hold the selected window.

Storage opens with the bytes written since boot by each watched slice and by each drive, then the drive lifetime writes. Device totals are read at the resource group root, so they include services outside your session. A `dm-` row repeats the writes of the disk beneath it.

Lifetime writes are read from `smartctl -A` output in the SMART report directory, which a privileged timer writes. Name each report after its device in `/sys/block`, with at most one extension: `/run/smartctl/nvme0n1.txt` matches the drive `nvme0n1`. A file matching no device is ignored. Every drive keeps its own row, so a drive with no report is named and shows "not available".

Scratch scans run separately from live refresh. Storage shows the measurement time and scan state. Scripted snapshots wait for the scan to finish. Use `bun run start -- --help` for export and scripting options.

## Development

See [Development](DEVELOPMENT.md) for validation, [UI behaviour](docs/architecture/ui.md) for rendering constraints, and [plan coverage](docs/architecture/plan-coverage.md) for verification references.
