# vsys

vsys is a Linux terminal dashboard for people who run several AI agents and AI coding tools. It shows how those processes use CPU, memory, storage, and other system resources.

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

- Shows CPU, memory, disk, and build activity.
- Lists each watched agent and its resource use.
- Shows the processes, open files, and terminal output for an agent.
- Shows Linux resource groups and their limits.
- Tracks compilers, linkers, build cache use, and make jobs.
- Shows filesystem space, disk writes, scrub reports, and scratch directories.
- Records changes and resource history for later review.
- Exports the current data as JSON or Markdown.
- Can freeze, resume, or stop an agent after you enable write mode and confirm the action.

## How it works

vsys reads Linux cgroup v2 and process files with your user permissions. It groups watched agent processes and shows their resource use. It refreshes the dashboard as the system changes. It keeps history in memory unless you enable saved history. It changes an agent only when write mode is on and you confirm the action.

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
