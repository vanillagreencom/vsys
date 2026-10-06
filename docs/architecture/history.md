# The store replays exactly and never rewrites what it stored

Read before changing replay, retention, persistence, the stored record shape or the history write path.

## The approach

`History` in `src/store/history.ts` keeps complete snapshots for replay and one point per sample for the charts. The archive holds checkpoints in memory, each a base snapshot and one delta line per later sample, sealed into immutable compressed segments. SQLite, when persistence is on, retains snapshots beyond the memory budget and across restarts. The load path fills what a stored record predates with the unknown value, in `src/store/migrate.ts`, and changes nothing else. The sample the timeline cursor selects is the pinned sample, and every screen reads it as it was recorded.

## Why

A replayed sample is evidence. A store that rewrote a record on what it looks like, or let a budget shorten retention silently, would show the reader a past that did not happen. The writes of one sample run on the dashboard thread, so their cost is what a keystroke waits behind.

## Rules

- Do add a stored field by giving `normalizeSnapshot()` and `normalizePoint()` its unknown value. They are idempotent and they are the whole migration. `src/store/history.test.ts` reads records older than each field.
- Do keep a stored snapshot independent of live objects: an exported snapshot can be edited without changing the replay cache. `src/store/archive.test.ts` checks mutation isolation.
- Do bound retention by time, and grow the points ring rather than dropping a point still inside the window.
- Do keep the writes of one sample within the write budget, half the shortest refresh interval the settings accept, `WRITE_BUDGET_MS` in `scripts/bench-history.ts`. `bun run bench:writes`, in `scripts/ci.py`, fails when the median exceeds it. Only the cost without disk load is held, because the cost under load depends on the disk as much as the code.
- Do wait for another dashboard's write lock up to `BUSY_TIMEOUT_MS` in `src/store/history.ts` and then fail, and read lane series a page at a time with no statement open between pages, so another dashboard's commit never refuses this one's next write. `src/store/history.test.ts` holds the lock from a second connection.
- Do fail visibly on a duplicate time or a checkpoint past the budget, and drop a sample at or before the newest stored time rather than ending the dashboard on a stepped clock.
- Do keep persisted snapshots and their sidecar files readable by the owner alone; they hold command lines and environment values. `src/store/history.test.ts` checks the modes.
- Never rewrite a stored record on what it looks like. A stored event's subject is decoded as a unit only where the record proves it held one.
- Never let an append compress more than the lines it added plus the one open run, and never inflate a sealed segment more than once in one walk. `src/store/archive.test.ts` counts the decompressions.
- Never open a database another application owns. `src/store/history.test.ts` checks the refusal.

## The canonical example

`normalizePoint()` in `src/store/migrate.ts`: one line per field a stored point can predate, each filled with null. Copy it for a new field.

## Revisit when

The write budget cannot hold on a target disk, or a reader needs two dashboards writing one database beyond what the lock wait allows.

## Not governed

What an event is: [events.md](events.md). What a point's numbers mean: [verdict.md](verdict.md).
