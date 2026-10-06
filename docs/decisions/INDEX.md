# Architectural Decision Log

| Date | ID | Research | Decision | Rationale | Revisit When | Status | Link |
|------|----|----------|----------|-----------|--------------|--------|------|
| 2026-09-09 | D001 | — | Build the OSC 52 clipboard sequence in vsys | The renderer's own call writes through its native core, where no test can read it | The renderer exposes the bytes it sends, or a readable test stream | Active | [Full](D001-clipboard-sequence.md) |
| 2026-09-09 | D002 | — | Freeze and thaw a lane by writing its cgroup.freeze; Stop only for a scope under slices alone | The lane's cgroup path needs no unit lookup, and a nested scope's bare name can be another unit's | Stop needs to reach a scope systemd does not own | Active | [Full](D002-lane-action-mechanism.md) |
| 2026-09-09 | D003 | — | Derive a lane action's effect at the keypress, not at the confirmation | A screen holds no effect, so a stale command cannot reach the system from any call site | A lane gains an identity independent of its cgroup path and leading process | Active | [Full](D003-action-resolved-at-the-keypress.md) |
| 2026-09-28 | D004 | — | Ship the warden as a separate vsys component | Keeps automatic correction outside the dashboard promise | A Bun ffi port matches Python's safety, or the dashboard owns a correction | Active | [Full](D004-warden-separate-component.md) |
| 2026-09-28 | D005 | [VSY-51](https://linear.app/vanillagreen/issue/VSY-51) | Use shared agent tool data | One JSON file keeps the dashboard and the warden agreeing | Packaging generates richer data, or the dashboard needs a warden-only desktop signal | Active | [Full](D005-shared-agent-tool-data.md) |
| 2026-09-29 | D006 | [VSY-57](https://linear.app/vanillagreen/issue/VSY-57) | Save only changed Settings keys | A save must not turn a derived default into user intent | The shared schema can record removals | Active | [Full](D006-settings-save-writes-only-changed-keys.md) |
| 2026-09-15 | D007 | [cpu-performance.md](https://uploads.linear.app/09589536-0763-447e-a0ed-6d9bf346d4cc/f407de70-ef2c-4341-9f06-d3fbc8eec56a/8d035065-919e-4fd3-8cd6-e4e482d6b025) | Bound scratch traversal with a duty cycle on its own thread | Resting bounds the cost a large root can demand | A root outgrows what a bounded traversal can finish in time | Active | [Full](D007-scratch-scan-duty.md) |
| 2026-10-01 | D008 | [cpu-performance.md](https://uploads.linear.app/09589536-0763-447e-a0ed-6d9bf346d4cc/f407de70-ef2c-4341-9f06-d3fbc8eec56a/8d035065-919e-4fd3-8cd6-e4e482d6b025) | Read processes on a persistent thread, one file at a time | Less processor time, and no keystroke waits on /proc reads | The 20 ms elapsed fixture target becomes a requirement again | Active | [Full](D008-process-reads-on-their-own-thread.md) |
| 2026-10-01 | D009 | [VSY-39](https://linear.app/vanillagreen/issue/VSY-39) | Read a slice unit file as a present slice before its group exists | A defined, inactive slice still holds agents to its limits | A slice is defined by a generator or an unlisted directory | Active | [Full](D009-agent-slice-unit-file.md) |
| 2026-10-01 | D010 | [VSY-41](https://linear.app/vanillagreen/issue/VSY-41) | Confirm a configured agent name by the tool's install location | A name alone matches anyone's program or script of that name | An agent ships a layout no path fragment or executable path describes | Active | [Full](D010-agent-names-confirmed-by-install-location.md) |

---

## Format Reference

Format: [decision-format.md](../../.agents/skills/decider/schemas/decision-format.md). Bar: [the decider skill](../../.agents/skills/decider/SKILL.md#what-warrants-a-decision-record-and-why).
