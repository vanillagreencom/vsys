# Lane actions

Read before adding or changing anything the dashboard does to a process, a cgroup or a unit.

## The approach

Screens hold an intent without an effect. Only `resolveIntent()` in `src/model/actions.ts` can turn it into a command against the current snapshot. Only `runEffect()` in `src/effect.ts` changes system state. [D003](../decisions/D003-action-resolved-at-the-keypress.md) governs this boundary.

## Why

Samples keep arriving while confirmation is open. The confirmed target and command must still describe the live machine when the reader accepts.

## Rules

Review holds boundaries without a named check.

- Build screen rows from `LaneIntent`. Keep the command builder private and resolve every confirmed intent against the current snapshot. Refuse a changed process instance, an unread main process, an ended lane, a lost scope or a changed command line. `src/model/actions.test.ts` checks these refusals.
- Refuse actions while write mode is off or a past sample is pinned. Confirm the exact command and scope before running it. `src/ui/agent.test.tsx` and `src/ui/App.test.tsx` check this boundary.
- Offer actions only for an addressable `.scope` under the configured root. Freeze and Thaw write its `cgroup.freeze`. Stop requires only slices between the root and scope, and a matching process kernel path under exactly one `user@<uid>.service` for the current user, with only slices elsewhere above the scope. A nested manager, a container subtree, another user's manager or an unknown manager must never receive a bare scope name through this user's manager. Keep Freeze and Thaw where Stop is unsafe. [D002](../decisions/D002-lane-action-mechanism.md) and `src/model/actions.test.ts` hold this boundary.
- An action another program asks for, such as `vsys --lane SCOPE --stop`, only opens vsys's own confirmation. The keypress that accepts it rebuilds the command through `resolveIntent()`, and vsys refuses the action while write mode is off. No one-shot command changes the system. `src/main.test.ts` and `src/ui/App.test.tsx` check this boundary.
- Report a refused effect as a refusal, never a completed stop.
- Keep every system change in `runEffect()`. Review holds the single-writer rule.
- A tmux view switch changes no process or cgroup. It bypasses write mode and the effect path through `switchToPane()` in `src/effect.ts`.

## The canonical example

Copy `LaneIntent`, `LaneCommand` and `resolveIntent()` in `src/model/actions.ts`: an inert intent, a private command builder and one resolver at the effect boundary.

## Revisit when

A lane gains a stable identity independent of its cgroup path and leading process ([D003](../decisions/D003-action-resolved-at-the-keypress.md)), or Stop must reach a scope systemd does not own ([D002](../decisions/D002-lane-action-mechanism.md)).

## Not governed

Automatic correction by the optional [warden](warden.md).
