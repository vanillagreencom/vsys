# vsys

vsys is a Linux terminal dashboard for people who run several AI agents or AI coding tools on one machine. It shows each agent with its Linux control group, systemd slice, build processes, and resource use.

![A tour of the vsys screens](docs/media/vsys-tour.gif)

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/vanillagreencom/vsys/main/install.sh | bash
```

The installer downloads the correct release for your CPU. It checks the download and installs `vsys` in `~/.local/bin`. Set `VSYS_INSTALL_DIR` to use a different directory.

| Method | Command |
| --- | --- |
| Installer | `curl -fsSL https://raw.githubusercontent.com/vanillagreencom/vsys/main/install.sh \| bash` |
| Arch Linux | `paru -S vsys` |
| Arch Linux, main branch | `paru -S vsys-git` |
| Release archive | Download a Linux archive from [Releases](https://github.com/vanillagreencom/vsys/releases) |
| Source | `bun install && bun run start` |

vsys requires Linux with cgroup v2. It does not run on macOS or Windows.

## Features

- Lists each watched agent with its tool, account, worktree or branch, process ID, and tmux pane.
- Shows CPU, memory, swap, cache, disk I/O, task counts, resource pressure, and cgroup limits for each agent.
- Shows systemd slices and cgroups as a tree with their resource use and limits.
- Finds agents that run outside the configured agent slice or inherit a memory limit below the configured floor.
- Attributes compiler and linker processes to each agent, and shows active build jobs, GNU make job slots, and sccache use.
- Breaks disk writes down by systemd slice and storage device, and shows filesystem space, Btrfs errors, scrub reports, drive lifetime writes, and scratch directory sizes.
- Records agent starts, stops, cgroup moves, resource alerts, and system resource history.
- Shows an agent's process tree, launch command, open files, and tmux output.
- Lets you change which slices, agent tools, build tools, resource thresholds, and columns it tracks.
- Can freeze, thaw, or stop an agent's systemd scope after you enable write mode and confirm the action.

## How it works

vsys reads Linux cgroup v2, process files, and configured system reports with your user permissions. It finds configured AI tools and watched systemd scopes. It groups their processes by cgroup and records resource use over time. It reads compiler, linker, build cache, and GNU make data from the same processes. It can freeze, thaw, or stop a systemd scope only when write mode is on and you confirm the action.

## Settings

Settings are in `~/.config/vsys/config.toml`. You can edit them from the Settings screen or in the file.

| Setting | What it changes |
| --- | --- |
| `watchedSlices` | The Linux resource groups that appear in the agent list. |
| `agentTools` | The program names that vsys treats as agents. |
| `laneNameParts` | The information used to name each agent. |
| `historyHours` | The time range available in charts and the timeline. |
| `persistence` | Saves history across restarts. It is off by default. |
| `notifications` | Selects the problems that send desktop notifications. |
| `writeMode` | Allows freeze, resume, and stop actions. It is off by default. |

Run `vsys --help` for command options.

## Development

See [Development](DEVELOPMENT.md) for local development and tests. See [Architecture](docs/architecture/overview.md) for the code structure. See [Releasing](docs/RELEASING.md) for the release process.

## License

[MIT](LICENSE)
