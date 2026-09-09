# Timeline events

Covers: src/store/events.ts src/store/events.test.ts src/ui/timeline.ts src/ui/timeline.test.ts

An event is one change between two consecutive samples, held as data with its cause, its subjects and its numbers: a lane starting or stopping, a process moving between cgroups, an alert opening or closing, or a new verdict. The store derives every event from successive snapshots and the one cause ladder, so an alert is a cause opening and closing rather than a second detection of the same problem.

## Boundaries

- The store owns the derivation. It records the events for a sample on that sample's history point, and nothing else derives them.
- An event carries data: the cause, the subject with its identity, the names and the numbers. Every word, duration and byte count belongs to `src/ui/timeline.ts`.
- An event records the thresholds it was measured against, so a later settings change cannot restate what an older line crossed.

## Invariants

- A lane start or stop names its account and slice, and a process moves cgroups only when its PID keeps its start time. `src/store/events.test.ts` checks a reused PID and a process that stayed put.
- A move event names the cgroup it left and the one it entered, and calls the slice changed only when it differs. A move between two slices outside the agent slice is not a confinement change. `src/store/events.test.ts` and `src/ui/timeline.test.ts` check a move inside one slice against one that leaves the agent slice.
- An alert is one cause on one subject. Every lane, group and path a grouped cause names watches on its own, so two lanes hitting one cause are two alerts with two durations. `src/store/events.test.ts` checks two lanes escaping at once and one replacing another.
- An alert reports the numbers of its own subject, never the worst or largest across the subjects its cause grouped. `src/store/events.test.ts` checks two over-quota paths and two stalling lanes.
- An alert closes with the time the cause was observed, and a settings change does not restart that clock. `src/store/events.test.ts` checks the duration across a reconfigure.
- A cause must hold for `pressureHoldSeconds` without a gap before it opens, and stay away that long before it closes. A value alternating either side of a threshold therefore records nothing. `src/store/events.test.ts` checks 100 alternating samples against 100 held ones.
- The verdict follows the alerts that opened, including one waiting out its close, so a cause that steps away for a sample cannot flip it. Severity ranks them and `causeRank()` breaks a tie, never a position in the ladder the alert may no longer appear in. `src/store/events.test.ts` checks the verdict across a close hold and against a cause of equal severity.
- A verdict is a cause and its level, so a cause turning from a warning into danger is a new verdict. `src/store/events.test.ts` checks a lane stalling harder.
- Desktop swap crossing its floor is the desktop-swap cause opening, and a housekeeping cause is an event but never a verdict change. `src/store/events.test.ts` checks both.
- An event carries the identity of its subject as well as its name, since two lanes can show one name. `src/store/events.test.ts` checks two lanes named alike.
- A point marks the timeline strip when it recorded an event. Only a point persisted before events existed falls back to its alerts, so an alert still inside its hold marks nothing. `src/store/point.test.ts` and `src/ui/App.test.tsx` check an empty list against a missing one.
- Every event renders as one line that states its cause. `src/ui/timeline.test.ts` checks each kind, the swap numbers and an escalating verdict.
