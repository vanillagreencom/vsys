# D009: A defined agent slice is present before its group exists

[← Decision Index](INDEX.md)

**Date**: 2026-10-01

**Status**: Active

**Research**: —

**Context**: vsys stops calling agents escaped on a machine with no agent slice. systemd creates a slice's cgroup only while the slice runs, and a slice with no install section, such as the `agents.slice` the warden installs or the owner workstation's own, runs only from the first unit placed in it. Read from the cgroup tree alone, such a machine has no slice from login until the first agent starts through its launcher, and in that time an agent started bare raises no card.

**Decision**: Where the slice's cgroup does not exist, `probeAgentSlice()` in `src/collect/capabilities.ts` checks whether a unit file or a drop-in directory for the configured slice name exists in the directories the systemd user manager loads units from: `$XDG_CONFIG_HOME/systemd/user` and its `user.control` sibling, `$XDG_DATA_HOME/systemd/user`, `/etc/systemd/user` and `/usr/lib/systemd/user`. The system manager's directories are not read: the slice vsys reads belongs to the user manager, which never loads them, so a system-level slice of the same name would make an absent slice read present. Each check is one `stat`. A defined slice is present, so agents are compared against it and Settings offers no line to create one. A directory that does not exist is no answer. A path that exists but cannot be read leaves the slice unknown, never absent.

## Alternatives Considered

| Alternative | Why rejected |
| --- | --- |
| The cgroup tree alone | Reads a defined, inactive slice as absent, which silences escaped agents on the owner workstation between login and the first launch |
| `systemctl --user show` for the slice's load state | A subprocess for a fact a file read answers; every slice name reads as loaded, so it needs the fragment and drop-in paths anyway |
| The user manager over D-Bus | A new runtime dependency for a read |
| Parsing the unit file | The question is whether the slice is defined, not what its limits are |

**Rationale**:

- A file read keeps the dashboard's promise to read without changing anything, and needs no new dependency.
- The owner workstation defines its slice in `~/.config/systemd/user/agents.slice` with a drop-in, so the read finds it there.
- `user.control` is where the line Settings offers for a missing slice writes, so a slice a reader created that way is found too.

**Revisit When**: A slice is defined some other way vsys should honour, such as a unit generator or a directory outside this list, or reading the user manager's own state becomes available without a subprocess or a new dependency.

**Verification**: `src/collect/capabilities.test.ts` tables the probe in "the agent slice is present, defined, absent, or unknown", including a slice defined by a unit file and by a drop-in directory with no group, a missing unit directory, and a unit path that cannot be read; its "unit files are looked for where the user manager loads them, the reader's own first" pins the directory list. `src/collect/collector.test.ts` "the program's collector finds a slice defined only by a drop-in" builds the collector the program builds and finds a `user.control` drop-in.

**References**: `src/collect/capabilities.ts`, [lanes.md](../architecture/lanes.md)
