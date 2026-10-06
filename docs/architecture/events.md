# An event is a change between two samples, derived once

Read before changing what the timeline records, when an alert opens or closes, or what a stored event holds.

## The approach

`EventLog` in `src/store/events.ts` derives every event from successive snapshots and the cause ladder: a lane starting or stopping, a process moving between cgroups, an alert opening or closing, a new verdict. An alert is one cause opening and closing on one subject, never a second detection. The store records a sample's events on that sample's history point, and `src/ui/timeline.ts` writes every word.

## Why

Deriving events where the samples meet keeps the Timeline and Home in agreement about what happened and when. A detection repeated in the timeline would drift from the ladder the moment either changed, and a word in an event would be stored for the life of the history.

## Rules

- Do open a level cause only after it holds for `pressureHoldSeconds` without a gap, and close every cause only after it stays away that long. An event cause opens on the sample that shows it, because a counter delta is gone by the next sample. `causeEvidence` in `src/model/verdict.ts` says which each is, and `src/store/events.test.ts` checks alternating samples against held ones.
- Do keep an alert open while its subject's input is unread, through `unjudged()`, and close an alert whose subject the sample no longer holds after the normal hold.
- Do record on the event the thresholds it was measured against and the identity of its subject beside its name. Two lanes can share a name, and a host cause has an empty identity, so host CPU pressure stays one alert while the busiest lane changes.
- Do judge a cgroup move by process id with start time, so a reused id is not a move, and judge both ends of a move against that one sample's slice probe.
- Do report the numbers of the alert's own subject, never the worst across the subjects its cause grouped.
- Never derive an event anywhere but the store, and never let a settings change restart an alert's clock or restate what an older event crossed.
- Never put a word in an event. The Timeline line is written in `src/ui/timeline.ts`, and `src/ui/timeline.test.ts` renders each kind.

## The canonical example

The lane-stop event: the store records the account, the slice, the tool and the age the sample read, and null for the age of a lane with no readable member; `src/ui/timeline.ts` turns the null into the line that says the age is not available. Copy the pair, data in the store and words in the UI.

## Revisit when

A cause needs a hold rule that is neither a level nor an event, or the timeline must record something that is not a change between two samples.

## Not governed

What a cause is: [verdict.md](verdict.md). How events are stored and replayed: [history.md](history.md).
