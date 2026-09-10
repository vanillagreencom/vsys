# D002: Freeze and thaw a lane by writing its cgroup.freeze

[← Decision Index](INDEX.md)

**Date**: 2026-09-09

**Status**: Active

**Research**: —

**Context**: The agent detail's Freeze, Thaw and Stop actions need one mechanism each. `systemctl --user freeze`, `thaw` and `kill` address all three by unit name; the kernel's `cgroup.freeze` attribute and a `systemctl kill` address the first two by path and the third by name.

**Decision**: Freeze and Thaw write `1` and `0` to `cgroup.freeze` in the lane's own cgroup directory. Stop runs `systemctl --user kill --signal=TERM <scope>`. `laneTarget()` in `src/model/actions.ts` refuses any lane whose cgroup is not a `.scope` under the configured root, so no action is ever aimed at a neighbouring group.

**Rationale**:

- vsys already knows the lane's cgroup path and reads from it every sample. The attribute write needs no unit lookup and no second name to keep in step with the first.
- A signal has no such path: only systemd knows which processes the scope holds as they come and go, so Stop delegates rather than walking `cgroup.procs`.
- A freeze leaves the tasks and their state in place, which is what a reader who wants a busy agent to pause is asking for.

**Revisit When**: A watched lane can run in a cgroup systemd does not own, which would leave `cgroup.freeze` reachable but `systemctl kill` not, and the two halves would need separate refusals.

**Verification**: `src/model/actions.test.ts` pins the exact path, value and argv of each action and the refusal for a lane with no scope.

**References**: [D001](D001-clipboard-sequence.md)
