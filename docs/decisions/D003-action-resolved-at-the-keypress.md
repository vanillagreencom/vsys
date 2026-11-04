# D003: Derive a lane action's effect at the keypress, not at the confirmation

[← Decision Index](INDEX.md)

**Date**: 2026-09-09

**Status**: Active

**Research**: —

**Decision**: A screen holds a `LaneIntent` with no effect. `resolveIntent()` in `src/model/actions.ts` is the only exported function returning a `LaneCommand`, and it returns one only from the snapshot it is handed, refusing when the lane ended, another process leads it, its cgroup no longer resolves to a scope, or the rebuilt line is not the confirmed line.

**Why**: Samples keep arriving while a confirmation is open. A type that carries no effect forces every caller through the current-snapshot resolver. Checks repeated at call sites can be omitted.

**Rejected**: A check at each call site that the lane still exists. A caller can omit or bypass a local check.

**Revisit when**: A lane gains a stable identity of its own, independent of its cgroup path and its leading process, so the replaced and changed refusals collapse into one.
