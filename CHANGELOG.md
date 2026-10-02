# Changelog

Notable changes, per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are written when a change lands, not batched at release. Write each one at 200 characters or fewer: the outcome for a person using vsys, a migration note inline on a **Breaking:** change, and credit (`— thanks @name`) when the change came from an outside contributor.

## [Unreleased]

## [0.10.0] - 2026-10-02

### Added

- Add the optional agent warden component with launcher scripts, user-unit templates, documentation, and CI checks. Refuse warden CI when the warden unit test file is missing.
- Storage says whether a filesystem's data is damaged, lists the files at the start of each damaged block, and says when the disk was last checked. An unchecked one never reads healthy.
- The mouse wheel moves the selection on Storage and on the Timeline change list, one row per notch. On Storage it first scrolls through a detail taller than the screen.
- Read checksum failures from the kernel log, so Storage dates the last new error and names the inode with no reporter, and say which source gave each time and which were read.
- Ship a Btrfs scrub reporter that lists the files at each damaged block's start or marks the block unnamed, with a one-command installer offered until the default report directory appears.
- Storage measures the temporary directories running agents name, except one another user owns such as `/tmp`, and a selected scratch root says where it came from.
- An agent-tools overlay entry with a shipped CLI's name adds where this machine installed it, and `vsys --once` names a process whose agent name was not confirmed.
- Ship a drive reporter, a root timer that leaves one smartctl report per drive where vsys reads lifetime writes, with a one-command installer.
- Show drive lifetime writes from udisks2 without root where no drive reporter is installed, and name the source of each total.
- Add `vsys warden install`, `vsys warden uninstall` and `vsys warden status` for marked user units, copied warden data and safer status checks.
- Ship warden files and shared data in archives, AUR packages and the curl installer. AUR keeps Bun bundles, and installer keeps shared file modes.
- `vsys --once --summary` prints a cheap verdict JSON for flyouts and skips scratch collection.
- Settings names the file an edit here will save to, beside the history database and error-memory rows.

### Changed

- An open concern card writes its detail as paragraphs, one per idea, with a blank row before `Next` and `Copy`.
- An open concern card writes as much as the screen has room for, measured from what is drawn around it, instead of a fixed six rows. Its key line no longer falls off the bottom.
- Recording a sample no longer recompresses the samples before it, so the dashboard stays responsive as history builds up. Memory holds slightly fewer samples before retention shortens.
- The dashboard reads processes on a thread of its own. Process collection uses a quarter to a third less processor time, and a keystroke no longer waits while `/proc` is read.
- Scratch measurement runs on a thread of its own and holds no more than the share of a processor core the new Scratch scan share setting allows. Readings arrive a little less often.
- **Breaking:** `vsys --once` reports `sccache.state` in place of `sccache.available`. Read `true` as `"read"`; `false` is now `"absent"` or `"failed"`.
- Settings follow `XDG_CONFIG_HOME` and history `XDG_STATE_HOME`. Existing files in `~/.config/vsys/` and `~/.local/state/vsys/` stay in use until you move them. `agent-tools.json` stays put.
- Dashboard defaults add cursor-agent and antigravity and drop dsh/agy. Warden defaults drop dsh/agy/omp/ori/fx/muse. Keep any in ~/.config/vsys/agent-tools.json, or config.toml agentTools.
- The warden now moves a mise or listed-executable agent under a desktop folder, and no longer moves an overlay tool listed by `paths` alone; add `executables` to such an entry.
- Agent Warden no longer duplicates a consumer's desktop notices, repeats near-limit or headroom warnings only after the condition clears, and reads status without rewriting its state file.

### Fixed

- What a reader opens is drawn at one indent everywhere, right of the row's own text, so an expansion on Home, Storage, Settings or an agent reads as a child of its row.
- Narrowing `Pane variables` to your own name no longer stops vsys recognising the pane it draws in, which had left the Terminal section unable to tell for a pane vsys was drawing in.
- The Terminal section no longer captures the pane vsys draws in when `VSYS_PANE` holds a zero-padded pane id, a pane id in the pane position, or a tmux selector such as `+` or `{last}`.
- The Terminal section no longer captures the pane vsys draws in when `VSYS_PANE` spells it any other way tmux takes, such as `vsys:build.1` or `vsys:2`, and says so when it cannot tell.
- Storage no longer says no scratch directory is configured while the first measurement is still running, or above rows for directories it has just measured.
- A failed scratch scan keeps the last complete sizes and their measurement time and names the failure beside them, rather than reporting what it had counted so far.
- A filesystem's last scrub check survives a reboot instead of reading as never checked again; the installer carries an existing check over on upgrade.
- The scrub reporter installer's missing-unit refusal, and the README, now name Fedora's and Ubuntu's btrfs-progs packages as not shipping `btrfs-scrub@.service`.
- The scrub reporter installer now carries legacy reports into the directory the installed release's own config names, not a separate hardcoded one that could differ for an older release.
- The scrub reporter installer no longer leaves a half-copied legacy report behind if interrupted, and its success message always names the real persisted directory.
- The scrub reporter installer no longer aborts silently, with no error shown, on a coreutils build where a skipped-destination rename reports failure.
- The scrub reporter installer no longer risks deleting or overwriting a report the reporter is actively writing while it carries old reports over from the previous tmpfs directory.
- The scrub reporter installer no longer claims a report survives a reboot when the release it installed still writes reports to a tmpfs directory.
- Settings saves no longer pin the default agent list in `config.toml`. They keep overlay-only tools, a newer overlay edit and a hand-written list that removes shipped names.
- The Terminal section no longer captures the pane vsys draws in, which showed the detail page inside itself, and its `Go to terminal` row no longer offers a move to the pane the reader is in.
- The card for agents outside the agent slice writes one sentence per group of processes that started alike, counts what it cannot fit, and stops at six rows so its next step stays on screen.
- A failed sccache query stays an unreadable source on every sample, and the Builds cache tile says the query failed rather than that sccache is not running.
- Timeline no longer reports a confinement change when a process that was not an agent moves cgroups, and lane start and stop lines no longer claim a watched scope or that the lane's processes left.
- Timeline records a Btrfs device error seen for one sample, and keeps host CPU pressure one alert while the busiest lane changes.
- Per-group disk writes no longer read as available when the session does not hand the io controller to its groups; Settings names that as the cause.
- Closing the terminal vsys draws in, dropping its SSH session or killing its tmux pane now ends vsys the way the quit key does, instead of leaving it sampling with nothing attached.
- The Agents trend column fills in one read for all rows on screen, stops rereading whole windows as time passes, and shows its trends at once when you return to the screen.
- Lane charts no longer skip rows a destination database already held before history was merged into it.
- A Settings change no longer stalls the dashboard by rereading the whole retained history when the history database itself did not change.
- Clicking a Home, Settings or agent detail row opens it as Enter does, and stacked mounts can each be selected.
- Storage and agent detail keep the selected row when rows change above it, and two quick arrow presses move two rows.
- A fast flick of the mouse wheel over a list moves the selection one row per notch, not one row in all.
- A list entry vsys looks up and does not find is now handled as missing at the lookup, rather than left to fail at a later read; the type check refuses code that reads one without a guard.
- Cards naming lanes with CJK characters or control bytes stay inside their rows, wide characters keep table columns aligned, and the verdict keeps `agents.slice` whole.
- Desktop apps whose binary carries an agent's name no longer appear as escaped agent lanes, and a bundled agent engine stays an agent after an update replaces it.
- Agents on a machine with no agent slice defined or running no longer raise a danger card that never clears; Settings says they are not compared against a shared limit.
- Missing default scratch directories no longer show as sources vsys cannot read, even under a path that is a file. A list that differs from the default still reports its missing directories.
- A script or program that only shares an agent CLI's name, such as `bash pi.sh`, no longer appears as an agent lane.
- An agent installed under a desktop prefix such as `/opt` counts as an agent when an agent-tools install location names it.
- vsys no longer stops sampling when a udisks drive query fails to start; that drive's lifetime writes stay unknown instead.
- A stalled udisks SMART query over D-Bus no longer freezes vsys; the read is abandoned after a bounded wait and storage reports it as unreadable.
- An open card on a terminal narrower than 28 columns wraps its text and command instead of dropping what passes the edge.
- Quitting while a scratch scan is stuck on a stalled mount now exits at once instead of waiting for a second Ctrl-C.
- Timeline keeps host memory pressure one alert while the swap holder changes, instead of closing and reopening it or missing it when two scopes trade the top spot.
- Settings' editor and a row a capture pushes down now stay in view across the layout change under the terminal's own frame timing, instead of sometimes landing at the top of the list.
- The desktop-swap card no longer offers an `agents.slice` command or next step on a machine with no agent slice; it names the agent lanes holding the swap instead.
- Settings no longer reports agent-slice io delegation as available when an unreadable ancestor, or a second agent slice, actually withholds it.
- Settings' per-group io-delegation note now names Storage too when the slice withholding io sits above the configured agent slice, since that also blanks the slice's own Storage total.
- Per-group disk writes no longer read as available when any real instance of the agent slice withholds the io controller; Settings names that slice as the cause.
- Settings no longer claims Storage's slice total is blank when the withholding directory sits below the slice's own occurrence, including a same-named nested instance.
- Settings: the settings-file row's help text now describes only where an edit saves, not where vsys read the running configuration from.
- Settings now shows the settings file path the next save will actually use, even after the reader moves it mid-session or saves before the next sample.
- The unconfirmed-tool card no longer tells the reader to cover a path it could not read; it points at checking the process directly instead.
- A process is no longer dropped from the sample entirely when vsys cannot read the script of a configured agent name with no install location.
- A process whose configured agent name sits outside every install location vsys knows now raises a Home card naming it, instead of staying visible only in the `--once` snapshot.
- The unconfirmed-tool card now names the exact path it checked, so its advice no longer points a scripted agent at the wrong directory.
- The unconfirmed-tool card now names every process it carries and every distinct path, instead of collapsing a fifth process or a shared tool name into one path.
- The scrub reporter now checks every 4 KiB sector of a damaged 64 KiB block, not just its start, and still flags an unresolved block even with no diagnostic text.
- Storage marks a damaged address unresolved, not dropped, when a name holds a line-separator character, and never lists a partial name set for an unresolved address.
- The new-errors card says no full check has ever run on a filesystem that was never checked, instead of claiming one ran longer ago than some unstated time.
- The scrub reporter installer now installs from a tagged release and checks its SHA256SUMS, refusing an unverified or mismatched download.
- The drive reporter installer now installs from a tagged release and checks its SHA256SUMS, refusing an unverified or mismatched download.
- The drive reporter installer's checksum-mismatch refusal now names both the downloaded file's digest and the release's expected one.
- The optional warden now removes a finished agent's scratch folder on a desktop that runs programs hiding their environment, such as ssh-agent or op, instead of keeping every folder forever.
- vsys no longer hangs on every future sample when journalctl stalls or tmux's server wedges; both now give up after a bounded wait.
- vsys now force-kills a kernel log or tmux read that ignores its shutdown signal, instead of leaving every future sample waiting on it forever.
- vsys no longer reports udisks2 as absent when it refuses a drive query with permission denied or operation not permitted; the drive's lifetime writes stay unknown instead.

### Security

- The drive reporter systemd service now runs with NoNewPrivileges, ProtectSystem=full, ProtectHome and PrivateTmp, keeping only the /dev access it needs.

## [0.9.0] - 2026-09-11

### Added

- Arch Linux users can install `vsys` from the AUR, or `vsys-git` to track the main branch.
- Install vsys without a clone: one `curl … | bash` line from the README puts a verified standalone binary in `~/.local/bin`. A download that fails its checksum is not installed.

### Changed

- **Breaking:** the program is now `vsys`. Move `~/.config/vsys-view/` to `~/.config/vsys/`, move `~/.local/state/vsys-view/` to `~/.local/state/vsys/`, and repoint `sqlitePath` in your config.
