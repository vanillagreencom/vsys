# D003: Derive a lane action's effect at the keypress, not at the confirmation

[← Decision Index](INDEX.md)

**Date**: 2026-09-09

**Status**: Active

**Research**: —

**Decision**: A screen holds a `LaneIntent` with no effect. `resolveIntent()` in `src/model/actions.ts` is the only exported function returning a `LaneCommand`, and it returns one only from the snapshot it is handed, refusing when the lane ended, another process leads it, its cgroup no longer resolves to a scope, or the rebuilt line is not the confirmed line.

**Why**: A confirmation stands open while samples land under it, and twice a review found an action authorised against the lane the reader saw rather than the lane the machine had. A type that cannot carry an effect is checked by the compiler at every call site that will ever exist, where a third check at a third site is a third chance to forget.

**Rejected**: A check at each call site that the lane still exists. The two findings shared one cause, and a boundary a caller can walk around is a claim rather than a boundary.

**Revisit when**: A lane gains a stable identity of its own, independent of its cgroup path and its leading process, so the replaced and changed refusals collapse into one.
