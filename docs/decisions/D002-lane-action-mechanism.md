# D002: Freeze and thaw a lane by writing its cgroup.freeze

[← Decision Index](INDEX.md)

**Date**: 2026-09-09

**Status**: Revisited

**Research**: —

**Context**: The agent detail's Freeze, Thaw and Stop actions need one mechanism each. `systemctl --user freeze`, `thaw` and `kill` address all three by unit name; the kernel's `cgroup.freeze` attribute and a `systemctl kill` address the first two by path and the third by name.

**Decision**: Freeze and Thaw write `1` and `0` to `cgroup.freeze` in the lane's own cgroup directory. Stop runs `systemctl --user kill --signal=TERM <scope>`. `laneTarget()` in `src/model/actions.ts` refuses any lane whose cgroup is not a `.scope` under the configured root, so no action is ever aimed at a neighbouring group. Stop has a second refusal of its own: it is offered only for a scope systemd created as a unit, one where every directory between the configured root and the scope is a `.slice`. A scope with any other directory on the way, such as a container's own `init.scope` or a scope in the container's own `system.slice`, keeps Freeze and Thaw, which address its directory, but gets no Stop: the agent screen does not list it and `resolveIntent()` answers `unaddressable`. Its bare name could name a different unit to the user manager, here the manager's own `init.scope`, whose SIGTERM ends the reader's session.

**Rationale**:

- vsys already knows the lane's cgroup path and reads from it every sample. The attribute write needs no unit lookup and no second name to keep in step with the first.
- A signal has no such path: only systemd knows which processes the scope holds as they come and go, so Stop delegates rather than walking `cgroup.procs`.
- A freeze leaves the tasks and their state in place, which is what a reader who wants a busy agent to pause is asking for.

**Revisit When**: Stop needs to reach a scope systemd does not own, which would need a mechanism that addresses the scope by path rather than by unit name.

**Verification**: `src/model/actions.test.ts` pins the exact path, value and argv of each action, the refusal for a lane with no scope, the action set for a scope under the root, in a slice, in a nested slice, nested in another unit and in a slice inside another unit, and that a collected container's nested `init.scope` resolves Stop as `unaddressable` while `agents.slice/a.scope` still resolves it. `src/ui/agent.test.tsx` checks that the agent screen lists no Stop for a nested scope.

**References**: [D001](D001-clipboard-sequence.md)

## Revisit Outcome (2026-10-03)

The original trigger occurred: a watched lane ran in a cgroup systemd does not own, a scope nested inside a container. The mechanism stays. Freeze and Thaw keep writing `cgroup.freeze` by path. Stop keeps `systemctl --user kill`, but is refused for any scope with a directory other than a `.slice` between the configured root and the scope, because its bare unit name can resolve to a different unit, such as the user manager's own `init.scope`. The next trigger is Stop needing to reach such a scope, which needs a mechanism that addresses it by path rather than by unit name.
