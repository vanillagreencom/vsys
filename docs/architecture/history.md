# History store

Covers: src/store/archive.ts src/store/history.ts src/store/migrate.ts src/store/point.ts src/store/lane-series.ts src/store/archive.test.ts scripts/bench-history.ts

The store keeps complete snapshots for replay and one point per sample for the charts. It owns application persistence; the collector does not depend on SQLite.

## Boundaries

- The archive holds compressed checkpoints in memory and reports shortened retention when the data exceeds its budget and persistence is off. SQLite retains snapshots beyond that cache and across restarts.
- A checkpoint is a base snapshot and one delta line per later sample. A sample appends its line and compresses nothing else: lines wait in an open run and are compressed once, into an immutable segment, when that run reaches its limit. No append ever compresses a line an earlier append already compressed.
- The open run is capped at 1 MiB of text, which is both the uncompressed memory an open checkpoint costs and the largest input any one compression takes. A checkpoint seals its open run when it rolls over, so the seal is never a pause proportional to the whole checkpoint.
- The memory budget charges an open line as text, at two bytes per code unit, and a sealed segment at its compressed size. Independent segments compress a little worse than one pass over the whole checkpoint, so a given budget retains slightly fewer samples than it did when every append rewrote the whole checkpoint.
- Replay reads only the lines it does not already hold. The cursor keeps the snapshot it last rebuilt, and the newest lines are the open ones, so advancing to the newest sample decompresses nothing.
- `normalizeSnapshot()` and `normalizePoint()` in `src/store/migrate.ts` are the whole of the load path's migration. They fill the fields a stored record predates and are idempotent.
- The load path never rewrites a stored record on what it looks like. An event subject becomes the unit it was only where the record proves it held one: the event kind carries a unit field, that field is absent, and the subject equals the last segment of its own cgroup-path identity.
- Retention is bounded by time, and the points ring grows rather than dropping a point still inside the window.

## Invariants

1. A snapshot a previous build stored is filled with the unknown value for every field it predates before any screen reads it, and a stored point takes the same step. `src/store/history.test.ts` checks a stored lane and a snapshot older than the capability probe.
2. A stored event is decoded only where the record proves it held a unit. `src/store/history.test.ts` checks four stored events a suffix cannot tell apart.
3. Historical snapshots stay independent of live objects and of callers, so an exported snapshot can be edited without changing the replay cache. `src/store/archive.test.ts` checks exact reconstruction and mutation isolation.
4. A duplicate time and a checkpoint past the budget fail visibly rather than silently, and the uncompressed lines a checkpoint has not sealed yet count against that budget. `src/store/archive.test.ts` checks all three.
5. An append compresses only the lines it added, and no single compression exceeds the open-run limit plus one line. `src/store/archive.test.ts` counts the compression input over 400 appends and replays across the checkpoint boundary.
6. Settings changes and persistence changes preserve retained incidents, and event derivation continues across them so an alert opened before the change still closes with its full duration. `src/store/history.test.ts` checks transfer and database merging.
7. History refuses an existing database owned by another application, and a database holding only a view still belongs to its existing application. `src/store/history.test.ts` checks both.
8. Persisted snapshots and their sidecar files stay readable only by the owner, because they hold command lines and environment values. `src/store/history.test.ts` checks the modes.
9. Expired snapshots cannot be replayed after a sampling gap. `src/store/history.test.ts` checks the cutoff.
10. Reading recent changes costs the same whether or not there is much to read, and a change aged out by a push leaves the index with its point. `src/store/history.test.ts` checks both.
11. Lane charts keep brief spikes across checkpoints, and reopened history loads complete lane series without duplicating concurrent requests. `src/store/lane-series.test.ts` checks both.
12. Unknown memory readings stay unknown in a point instead of becoming zero. `src/store/point.test.ts` checks them.

## Limits of the checks

`bun run bench:history` fills the configured history window with counters that move by a different amount per row at every sample, compares every retained checkpoint against its original, and reports the median, 95th percentile and slowest append for both `History.add` and `Archive.add`. Its generated workload does not establish a memory bound for every possible command line or process mix, and its timings come from one machine under whatever else it was running.
