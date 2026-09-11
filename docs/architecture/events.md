# Timeline events

Covers: src/store/events.ts src/ui/timeline.ts src/ui/timeline-screen.tsx

An event is one change between two consecutive samples, held as data: a lane starting or stopping, a process moving between cgroups, an alert opening or closing, or a new verdict. `EventLog` derives every event from successive snapshots and the one cause ladder, so an alert is a cause opening and closing rather than a second detection of the same problem.

## Boundaries

- The store owns the derivation and records a sample's events on that sample's history point. Nothing else derives them.
- An event carries data: the cause, the subject with its identity, the names and the numbers. Every word, duration and byte count belongs to `src/ui/timeline.ts`.
- A subject that is a cgroup is named through `consumerName()`, and the raw unit stays beside it so the Timeline row can show the handle under the selection.
- An event records the thresholds it was measured against, so a later settings change cannot restate what an older line crossed.

## Invariants

1. The first sample records the state it observes and reports no change. `src/store/events.test.ts` checks it.
2. A lane start or stop names its account and its slice. `src/store/events.test.ts` checks both.
3. A process moves cgroups only when its PID keeps its start time, so a reused PID is not a move. `src/store/events.test.ts` checks a reused PID and a process that stayed put.
4. A move between two slices outside the agent slice is not a confinement change. `src/store/events.test.ts` and `src/ui/timeline.test.ts` check it against a move that leaves the agent slice.
5. An alert is one cause on one subject, so two lanes hitting one cause are two alerts with two durations. `src/store/events.test.ts` checks two lanes escaping at once and a second subject opening and closing on its own.
6. A cause must hold for `pressureHoldSeconds` without a gap before it opens, and stay away that long before it closes, so a value alternating across a threshold records nothing. `src/store/events.test.ts` checks alternating samples against held ones.
7. An alert closes with the time the cause was observed, and a settings change does not restart that clock. `src/store/events.test.ts` checks the duration across a reconfigure.
8. An alert reports the numbers of its own subject, never the worst or largest across the subjects its cause grouped. `src/store/events.test.ts` checks two over-quota paths and two stalling lanes.
9. An alert's subject and unit are the ones the sample that opened it read, so a scope becoming a lane during the hold renames a watch that has not opened and never one that has. `src/store/events.test.ts` checks a scope that becomes a lane mid-hold.
10. A cause naming one thing twice opens one alert, and that alert carries the unit. `src/store/events.test.ts` checks it.
11. The verdict follows the alerts that opened, including one waiting out its close, so a cause that steps away for a sample cannot flip it. Severity ranks them and the cause order table breaks a tie. `src/store/events.test.ts` checks the verdict across a close hold and against a cause of equal severity.
12. A verdict is a cause and its level, so a cause turning from a warning into danger is a new verdict. `src/store/events.test.ts` checks a lane stalling harder.
13. A housekeeping cause is an event but never a verdict change. `src/store/events.test.ts` checks it.
14. An event carries the identity of its subject as well as its name, since two lanes can show one name. `src/store/events.test.ts` and `src/ui/timeline.test.ts` check two lanes named alike.
15. A point marks the timeline strip when it recorded an event, so an alert still inside its hold marks nothing. `src/store/point.test.ts` and `src/ui/timeline-screen.test.tsx` check an empty list against a missing one.
16. Every event renders as one line that states its cause. `src/ui/timeline.test.ts` checks each kind, the swap numbers and an escalating verdict.
17. The Timeline change list is a list: the arrows move the selection, Enter moves the time cursor to the selected change, and the selected row shows the raw unit its subject decoded from. `src/ui/timeline-screen.test.tsx` drives it from the keyboard alone.
18. The change list takes one row per event and stops at the rows the viewport has, and a shorter window leaves the selection on a row that exists. `src/ui/timeline-screen.test.tsx` checks a short terminal and a shortened window.
