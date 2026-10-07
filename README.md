# vsys

A Linux terminal dashboard for people who run several AI coding agents on one machine. It shows each agent with its control group, systemd slice, build processes and resource use, and can freeze, thaw or stop an agent you choose.

![A tour of the vsys screens](docs/media/vsys-tour.gif)

## Features

- Lists each agent with its tool, account, worktree or branch, process id and tmux pane.
- Shows CPU, memory, swap, disk I/O, task counts, resource pressure and cgroup limits per agent and per systemd slice.
- Finds agents running outside the agent slice or under a memory limit below the floor.
- Attributes compiler and linker processes to the agent that started them, and shows make job slots and sccache use.
- Shows filesystem space, Btrfs damage, scrub reports, drive lifetime writes and scratch directory sizes.
- Records agent starts, stops, cgroup moves and resource alerts, with history charts.
- Prints a verdict summary for scripts with `vsys --once --summary`.
- Freezes, thaws or stops an agent after you enable write mode and confirm.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/vanillagreencom/vsys/main/install.sh | bash
```

```sh
paru -S vsys
```

```sh
paru -S vsys-git
```

Linux with cgroup v2 only. Release installations need `flock` from util-linux on PATH to save filesystem error times. This requirement also applies when you unpack a release archive directly. The installer puts `vsys` in `~/.local/bin`, or in `VSYS_INSTALL_DIR`. Release archives are on the [Releases](https://github.com/vanillagreencom/vsys/releases) page.

## How it works

vsys reads the kernel's process and control-group files with your own permissions. It groups each agent's processes by control group, samples their use every second, and keeps the history for the charts and the timeline. Nothing on the machine changes until you turn write mode on and confirm an action.

## Optional components

The warden is separate from the dashboard. It runs from a systemd user timer, moves escaped agent processes back into `agents.slice`, caps agent scopes and stops abandoned ones. Every install route ships it, and none turns it on.

```sh
vsys warden install
```

Naming the files a Btrfs scrub found damaged and reading a drive's lifetime writes both need root, so vsys reads reports that two root-side reporters write. Settings and Storage show the matching line while a reporter is missing.

```sh
curl -fsSL https://raw.githubusercontent.com/vanillagreencom/vsys/main/scripts/scrub-reporter/install | sudo bash
```

```sh
curl -fsSL https://raw.githubusercontent.com/vanillagreencom/vsys/main/scripts/smart-reporter/install | sudo bash
```

## Setup

Settings live in `~/.config/vsys/config.toml`. Edit them from the Settings screen or in the file.

| Setting | What it changes |
| --- | --- |
| `watchedSlices` | The control groups shown in the agent list. |
| `agentTools` | The program names vsys treats as agents. Settings saves additions to `~/.config/vsys/agent-tools.json`, which the warden also reads. |
| `historyHours` | The time range of the charts and the timeline. |
| `persistence` | Keeps history across restarts. Off by default. |
| `writeMode` | Allows freeze, thaw and stop. Off by default. |

Run `vsys --help` for the command options.

## Licence

[MIT](LICENSE)
