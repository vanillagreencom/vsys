# Only a command rebuilt against the current sample reaches the system

Read before adding or changing anything the dashboard does to a process, a cgroup or a unit.

## The approach

A screen holds a `LaneIntent`: the action, the lane id, its main process, the scope and the line the reader read. It carries no effect. `resolveIntent()` in `src/model/actions.ts` rebuilds it against the snapshot of the moment into a `LaneCommand`, and refuses when the lane ended, another process leads it, its cgroup no longer resolves to a scope, or the rebuilt line differs from the confirmed one. `runEffect()` in `src/effect.ts` performs the command. Write mode ships off, and every action stands behind a confirmation naming the scope.

## Why

A confirmation stays open while samples land under it. Twice a review found an action authorised against the lane the reader saw rather than the lane the machine had. A type that cannot carry an effect is checked at every call site by the compiler, where a third check at a third call site would be a third chance to forget ([D003](../decisions/D003-action-resolved-at-the-keypress.md)).

## Rules

- Do build intents on the screen and commands only through `resolveIntent()`. It is the only exported function returning a `LaneCommand`, and the builder is private to `src/model/actions.ts`. `src/model/actions.test.ts` pins each command and each refusal.
- Do refuse every action while write mode is off, while a past sample is pinned, and when the current sample no longer names the confirmed line. `src/ui/agent.test.tsx` lands a sample under an open confirmation and checks all four answers.
- Do offer actions only to a lane whose cgroup is a `.scope` under the configured root, through `laneTarget()`, and offer Stop only where every directory between the root and the scope is a `.slice`. A scope nested in another unit's subtree keeps Freeze and Thaw and gets no Stop ([D002](../decisions/D002-lane-action-mechanism.md)).
- Do report each refusal as its own answer, so a signal that reached nothing never reads as a completed stop.
- Never change system state anywhere but `runEffect()`. Review holds this; no check refuses a second writer.
- Moving the reader's own tmux view, `switchToPane()` in `src/effect.ts`, is not an effect: it changes no process, so it waits on neither write mode nor `runEffect()`.

## The canonical example

`src/model/actions.ts`: `LaneIntent` without an effect, `LaneCommand` with one, a private builder, and `resolveIntent()` as the only exported way from one to the other. Copy the shape for a new action.

## Revisit when

A lane gains a stable identity independent of its cgroup path and leading process ([D003](../decisions/D003-action-resolved-at-the-keypress.md)), or Stop must reach a scope systemd does not own ([D002](../decisions/D002-lane-action-mechanism.md)).

## Not governed

What the optional warden changes automatically: [warden.md](warden.md).
