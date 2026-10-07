# The store replays exactly and never rewrites what it stored

Read before changing replay, retention, persistence, the stored record shape, the history write path, what the timeline records, or when an alert opens or closes.

## The approach

`History` in `src/store/history.ts` keeps complete snapshots for replay and one point per sample for the charts. The archive holds checkpoints in memory, each a base snapshot and one delta line per later sample, sealed into immutable compressed segments. SQLite, when persistence is on, retains snapshots beyond the memory budget and across restarts. The load path fills what a stored record predates with the unknown value, in `src/store/migrate.ts`, and changes nothing else. The sample the timeline cursor selects is the pinned sample, and every screen reads it as it was recorded.

`EventLog` in `src/store/events.ts` derives lane starts, lane stops and cgroup moves from successive accepted snapshots. With persistence on, the predecessor is the newest stored snapshot, including one another dashboard saved or a previous session left. Alert watches and verdicts follow this dashboard's cause ladder and settings. An alert is one cause opening and closing on one subject, never a second detection. The store records a sample's events on that sample's history point, and `src/ui/timeline.ts` writes every word.

## Why

A replayed sample is evidence. A store that rewrote a record on what it looks like, or let a budget shorten retention silently, would show the reader a past that did not happen. The writes of one sample run on the dashboard thread, so their cost is what a keystroke waits behind.

Deriving events where the samples meet keeps the Timeline and Home in agreement about what happened and when. A detection repeated in the timeline would drift from the ladder the moment either changed, and a word in an event would be stored for the life of the history.

## Rules

- Do add a stored field by giving the normalization functions in `src/store/migrate.ts` its unknown value when the record cannot establish the reading, never zero. Snapshot replay and chart projections use the same reading rules. The functions are idempotent and they are the whole migration. `src/store/history.test.ts` reads older records through snapshot replay, archive charts and disk charts.
- Do keep a stored snapshot independent of live objects: an exported snapshot can be edited without changing the replay cache. `src/store/archive.test.ts` checks mutation isolation.
- Do bound retention by time, and grow the points ring rather than dropping a point still inside the window.
- Do keep the writes of one sample within the write budget, half the shortest refresh interval the settings accept, `WRITE_BUDGET_MS` in `scripts/bench-history.ts`. `bun run bench:writes`, in `scripts/ci.py`, fails when the median exceeds it. Only the cost without disk load is held, because the cost under load depends on the disk as much as the code.
- Do wait for another dashboard's write lock up to `BUSY_TIMEOUT_MS` in `src/store/history.ts` and then fail, and read lane series a page at a time with no statement open between pages, so another dashboard's commit never refuses this one's next write. `src/store/history.test.ts` holds the lock from a second connection.
- Do fail visibly on a duplicate time or a checkpoint past the budget, and drop a sample at or before the newest stored time rather than ending the dashboard on a stepped clock.
- Do read the persisted snapshot predecessor under the same write lock that accepts the next sample. A rejected sample changes no event state. `src/store/history.test.ts` checks foreign appends, collisions, restarts and settings changes.
- Do keep persisted snapshots and their sidecar files readable by the owner alone; they hold command lines and environment values. `src/store/history.test.ts` checks the modes.
- Do open a level cause only after it holds for `pressureHoldSeconds` without a gap, and close every cause only after it stays away that long. An event cause opens on the sample that shows it, because a counter delta is gone by the next sample. `causeEvidence` in `src/model/verdict.ts` says which each is, and `src/store/events.test.ts` checks alternating samples against held ones.
- Do judge a subject whose own input could not be read as unread, not as absent: `unjudged()` in `src/model/verdict.ts` names those subjects, and an alert on one of them stays open. Close an alert whose subject the sample no longer holds after the normal hold.
- Do record on the event the thresholds it was measured against and the identity of its subject beside its name. Two lanes can share a name, and a host cause has an empty identity, so host CPU pressure stays one alert while the busiest lane changes.
- Do judge a cgroup move by process id with start time, so a reused id is not a move, and judge both ends of a move against that one sample's slice probe.
- Do report the numbers of the alert's own subject, never the worst across the subjects its cause grouped.
- Never rewrite a stored record on what it looks like. A stored event's subject is decoded as a unit only where the record proves it held one.
- Never let an append compress more than the lines it added plus the one open run, and never inflate a sealed segment more than once in one walk. `src/store/archive.test.ts` counts the decompressions.
- Never open a database another application owns. `src/store/history.test.ts` checks the refusal.
- Never derive an event anywhere but the store, and never let a settings change restart an alert's clock or restate what an older event crossed.
- Never put a word in an event. The Timeline line is written in `src/ui/timeline.ts`, and `src/ui/timeline.test.ts` renders each kind.

## The canonical example

`normalizePoint()` in `src/store/migrate.ts`: one line per field a stored point can predate, each filled with null. Copy it for a new field. For a new event, copy the lane-stop event: the store records the account, the slice, the tool and the age the sample read, and null for the age of a lane with no readable member, and `src/ui/timeline.ts` turns the null into the line that says the age is not available.

## Revisit when

The write budget cannot hold on a target disk, or a reader needs two dashboards writing one database beyond what the lock wait allows. A cause needs a hold rule that is neither a level nor an event, or the timeline must record something that is not a change between two samples.

## Not governed

What a cause is and what a point's numbers mean: [verdict.md](verdict.md).
