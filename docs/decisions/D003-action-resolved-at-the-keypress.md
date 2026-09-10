# D003: Derive a lane action's effect at the keypress, not at the confirmation

[← Decision Index](INDEX.md)

**Date**: 2026-09-09

**Status**: Active

**Research**: —

**Context**: A confirmation names one scope and one line, and stands open until the reader answers. Collection publishes a new sample every tick underneath it. Twice now a review has found an action authorised against a lane the reader saw rather than the lane the machine has: once from a pinned past sample, once from a live sample the dialog had outlived.

**Decision**: What a screen holds is a `LaneIntent`: the action, the lane's id, its main process, the scope and the line the reader read. It carries no effect. `LaneCommand` extends it with the effect, and the function that builds one is private to `src/model/actions.ts`, so `resolveIntent()` is the only exported function returning a `LaneCommand` and it returns one only from the snapshot it is handed. It refuses when the lane ended, when another process leads it, when its cgroup no longer resolves to a scope, and when the rebuilt line is not the confirmed line.

**Rationale**:

- The two findings shared one cause. A third check at a third call site would have been a third chance to forget; a type that cannot carry an effect is checked by the compiler at every call site that will ever exist. Passing the held intent to the action hook does not compile.
- The identity is the lane id and its main process together. A scope name embeds the process id that opened it, so the name alone can return without the lane returning.
- Comparing the rebuilt line to the confirmed one is the last check rather than the only one, because it is the reader's own question: they agreed to that text.
- The refusals stay separate answers, so the notice says which and the reader knows nothing ran. A signal that reached nothing must never read as a completed stop.
- The module exports the intent builder and the resolver, and keeps the command builder to itself. A boundary a caller can walk around is a claim, not a boundary; the tests go through the resolver for the same reason. What remains open is a hand-written object literal that satisfies the interface, which no exported function will produce and nothing in the repository does.

**Revisit When**: A lane gains a stable identity of its own, independent of its cgroup path and its leading process. The `replaced` and `changed` answers would then collapse into one.

**Verification**: `src/model/actions.test.ts` covers the five answers over one intent; `src/ui/agent.test.tsx` lands a sample under an open confirmation, both one that changes the lane and one that does not. Every test that needs an effect goes through `resolveIntent`, and a call to the private builder from outside the module fails the type check.

**References**: [D002](D002-lane-action-mechanism.md)
