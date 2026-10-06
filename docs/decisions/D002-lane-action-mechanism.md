# D002: Freeze and thaw a lane by writing its cgroup.freeze

[← Decision Index](INDEX.md)

**Date**: 2026-09-09

**Status**: Active

**Research**: —

**Decision**: Freeze and Thaw write `1` and `0` to `cgroup.freeze` in the lane's own cgroup directory. Stop runs `systemctl --user kill --signal=TERM <scope>`, and `laneTarget()` in `src/model/actions.ts` offers it only for a scope whose every directory below the configured root is a `.slice`.

**Why**: vsys reads the lane's cgroup path every sample, so the attribute write needs no unit lookup and no second name to keep in step. Only systemd knows which processes a scope holds as they come and go, so Stop delegates to it. A scope nested in another unit's subtree can share its bare name with a different unit, such as the user manager's own `init.scope`, whose SIGTERM would end the reader's session.

**Rejected**: `systemctl --user freeze` and `thaw` for every action. It adds a unit name to keep in step with the path, and it refuses every scope systemd does not own, where the attribute write still works.

**Revisit when**: Stop must reach a scope systemd does not own, which needs a mechanism that addresses the scope by path rather than by unit name.
