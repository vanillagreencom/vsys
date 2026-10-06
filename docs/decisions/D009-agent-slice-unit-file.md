# D009: A defined agent slice is present before its group exists

[← Decision Index](INDEX.md)

**Date**: 2026-10-01

**Status**: Active

**Research**: [VSY-39](https://linear.app/vanillagreen/issue/VSY-39)

**Decision**: Where the agent slice's cgroup does not exist, `probeAgentSlice()` in `src/collect/capabilities.ts` looks for a unit file or a drop-in directory of the slice's name in the directories the systemd user manager loads units from, in its order. The first directory holding a unit file decides; a unit file resolving to `/dev/null` reads `masked`; a path that exists but cannot be read leaves the slice unknown, never absent.

**Why**: systemd creates a slice's cgroup only while the slice runs, so read from the tree alone a defined slice is absent from login until the first agent starts through its launcher, and an agent started bare in that time raises no card. A file read keeps the promise to read without changing anything and needs no new dependency.

**Rejected**: `systemctl --user show` for the load state, a subprocess that reports every name as loaded and needs the paths anyway; and the user manager over D-Bus, a new runtime dependency for one read.

**Revisit when**: A slice is defined some other way vsys should honour, such as a unit generator or a directory outside the list, or the manager's own state becomes readable without a subprocess or a new dependency.
