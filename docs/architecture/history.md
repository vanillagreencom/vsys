# Retained evidence

Read before changing replay, retention, persistence, stored records, history writes, timeline events or alert holds.

## The approach

The store retains accepted snapshots and derives changes between them. Replay preserves recorded readings; normalization in `src/store/migrate.ts` supplies unknown values for missing fields. `EventLog` in `src/store/events.ts` consumes the same cause judgments as the live dashboard. Event records carry data, and `src/ui/timeline.ts` writes their words.

## Why

Replay is evidence. Changing a stored value based only on its appearance invents a past reading. A second alert detector can disagree with Home. Unbounded synchronous writes delay keystrokes.

## Rules

Review holds boundaries without a named check.

- Give a stored field its unknown value when an older record cannot establish it, never zero. Keep normalization idempotent and share reading rules between replay and chart projections. `src/store/history.test.ts` checks older records.
- Keep a service's average so far and its span null when a stored snapshot predates them. Never reconstruct them from its hour average; `normalizeSnapshot()` in `src/store/migrate.ts` owns this load rule.
- Keep exported snapshots independent of the replay cache. `src/store/archive.test.ts` checks mutation isolation.
- Bound retention by time. Grow the points ring rather than drop a point still in the retained window.
- Keep each sample's history writes within `WRITE_BUDGET_MS` in `scripts/bench-history.ts`, half the shortest accepted refresh interval. `bun run bench:writes`, in `scripts/ci.py`, holds the median without competing disk load; loaded cost depends on the disk too.
- Bound lock waits by `BUSY_TIMEOUT_MS` in `src/store/history.ts` and fail visibly on expiry. Release read statements between lane-series pages so another dashboard's commit cannot prevent this connection's next write. `src/store/history.test.ts` checks concurrent writers.
- Fail visibly on a duplicate stored time or a checkpoint beyond budget. Reject a sample at or before the latest stored time without ending the dashboard; a stepped clock must not rewrite stored timestamps.
- Read the accepted snapshot predecessor under the same write lock as the next append. A rejected sample changes no event state. Keep alert thresholds and watches local to the dashboard. `src/store/history.test.ts` checks predecessor ownership.
- Keep persisted snapshots and sidecars readable by the owner alone: they contain command lines and environment values. `src/store/history.test.ts` checks modes.
- Open level causes only after an uninterrupted `pressureHoldSeconds`; open event causes on the sample carrying the change. Close every cause only after it stays absent for the hold. Read evidence kind from `causeEvidence` in `src/model/verdict.ts`. `src/store/events.test.ts` checks hold behavior.
- An unread subject is not absent. Use `unjudged()` in `src/model/verdict.ts` to keep its alert open. A subject no longer present closes after the normal hold. Compare process-derived changes against the last accepted sample that read processes; a missed process deadline establishes no lane start, stop or move. Persist that predecessor atomically with its sample so restarts and other writers see the same evidence. `src/store/events.unread.test.ts` and `src/collect/process-thread.audit6.test.ts` check this rule.
- Store the thresholds and the subject's own numbers with each event. Keep identity separate from display name. Host causes use the empty identity so a changing busiest lane cannot split an episode.
- Identify a cgroup move by pid and start time. Judge both ends against the later sample's slice probe; pid reuse is not a move.
- Never rewrite a stored event's subject as a unit unless the record proves that association.
- Never compress more than an append's new lines and its one open run, or inflate a sealed segment more than once per walk. `src/store/archive.test.ts` checks the work.
- Never open another application's database. `src/store/history.test.ts` checks refusal.
- Derive events only in the store. A settings edit must neither restart an alert clock nor restate an older event's threshold. Keep prose out of stored events.

## The canonical example

Copy `normalizePoint()` in `src/store/migrate.ts`: fill each missing reading with its unknown value on the load path. Keep event data separate from its rendering in `src/ui/timeline.ts`.

## Revisit when

A target disk cannot meet the write budget, concurrent dashboards need more than the bounded lock wait, or a cause needs evidence beyond levels, events and changes between samples.

## Not governed

Cause definitions and number semantics: [verdict.md](verdict.md).
