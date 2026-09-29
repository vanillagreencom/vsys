# Architectural Decision Log

| Date | ID | Research | Decision | Rationale | Revisit When | Status | Link |
|------|----|----------|----------|-----------|--------------|--------|------|
| 2026-09-09 | D001 | — | Build the OSC 52 clipboard sequence in vsys | The renderer's own call writes through its native core, where no test can read it | The renderer exposes the bytes it sends, or a writable test stream | Active | [Full](D001-clipboard-sequence.md) |
| 2026-09-09 | D002 | — | Freeze and thaw a lane by writing its cgroup.freeze | It reaches the lane's own cgroup with no unit lookup and no second name to resolve | A lane can run in a cgroup systemd does not own | Active | [Full](D002-lane-action-mechanism.md) |
| 2026-09-09 | D003 | — | Derive a lane action's effect at the keypress, not at the confirmation | What a screen holds carries no effect, so a stale command cannot reach the system from any call site | A lane gains an identity independent of its cgroup path and leading process | Active | [Full](D003-action-resolved-at-the-keypress.md) |
| 2026-09-28 | D004 | VGS agent-warden research | Ship the warden as a separate vsys component | Keeps automatic correction outside the dashboard promise | Bun ffi port matches Python safety | Active | [Full](D004-warden-separate-component.md) |
| 2026-09-28 | D005 | VSY-51 | Use shared agent tool data | Prevents copied classification lists | Packaging generates richer data | Active | [Full](D005-shared-agent-tool-data.md) |
| 2026-09-29 | D006 | VSY-57 | Save only changed Settings keys | Prevents derived defaults from becoming pins | Shared schema can record removals | Active | [Full](D006-settings-save-writes-only-changed-keys.md) |

---

## Format Reference

Log a decision when the implementation weighed a real alternative: a mechanism, a boundary, or a contract that a later reader would otherwise reverse without knowing what it cost.

Do not log a choice with no alternative, a naming preference, or anything the code and its tests already state plainly.

Status values in use: `Active`, `Superseded by [ID]`, `Revisited`. Rows are append-only and never re-sorted. Row format: `.agents/skills/decider/templates/index-row.md`.
