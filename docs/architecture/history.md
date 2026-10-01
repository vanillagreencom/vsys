# History store

<<<<<<< HEAD
Covers: src/store/archive.ts src/store/history.ts src/store/migrate.ts src/store/point.ts src/store/lane-series.ts src/store/archive.test.ts src/store/lane-series.test.ts scripts/bench-history.ts scripts/percentile.ts
=======
Covers: src/store/archive.ts src/store/history.ts src/store/migrate.ts src/store/point.ts src/store/lane-series.ts src/store/archive.test.ts src/store/history.test.ts scripts/bench-history.ts scripts/percentile.ts
>>>>>>> a125c87 (docs(VSY-40): Cover the history suite)

The store keeps complete snapshots for replay and one point per sample for the charts. It owns application persistence; the collector does not depend on SQLite.

## Boundaries

- The archive holds compressed checkpoints in memory and reports shortened retention when the data exceeds its budget and persistence is off. SQLite retains snapshots beyond that cache and across restarts.
- A checkpoint is a base snapshot and one delta line per later sample. A sample appends its line and compresses nothing else: lines wait in an open run and are compressed once, into an immutable segment, when that run reaches its limit. No append ever compresses a line an earlier append already compressed.
- An open run seals once it reaches 1 Mi code units of text, so it holds that many plus the one line that crossed it, and that whole run is the input of one compression and of nothing else. At two bytes per code unit an open checkpoint costs about 2 MiB of live memory. A checkpoint seals its open run when it rolls over, so the seal is never a pause proportional to the whole checkpoint.
- One sealed segment at a time is inflated while a checkpoint is read, so reading one never holds more than one segment's text. A reader made before a seal cannot place a line after it and is built again.
- The memory budget charges an open line as text, at two bytes per code unit, and a sealed segment at its compressed size. Independent segments compress a little worse than one pass over the whole checkpoint, so a given budget retains slightly fewer samples than it did when every append rewrote the whole checkpoint.
- Replay reads only the lines it does not already hold. The cursor keeps the snapshot it last rebuilt and the reader that inflated the lines it walked, and a seal retires that reader. Invariant 6 owns what a walk costs in decompression.
- A lane-series read takes every lane a screen asks for at once. The archive keeps, per checkpoint, the lane columns it projected and the line it reached; the store keeps the series it read back from SQLite over one span of rows. Lanes already held take only the lines and rows the read reaches past what is held, before it or after it. A read that adds a lane walks the checkpoints and stored rows in its span once for all the lanes it adds. Both caches keep a lane only while the newest sample still holds it, and let go of what lies before the window: the archive drops a checkpoint's projection once the window starts after it, and the store trims its series to the window's start once the rows before it outnumber those inside it or a lane is added, and drops them once the window starts after the last stored row. A stored pass writes nothing to the cache until every pass has finished, and a held lane that gains no rows is not copied.
- `normalizeSnapshot()` and `normalizePoint()` in `src/store/migrate.ts` are the whole of the load path's migration. They fill the fields a stored record predates and are idempotent.
- The load path never rewrites a stored record on what it looks like. An event subject becomes the unit it was only where the record proves it held one: the event kind carries a unit field, that field is absent, and the subject equals the last segment of its own cgroup-path identity.
- Retention is bounded by time, and the points ring grows rather than dropping a point still inside the window.

## Invariants

1. A snapshot a previous build stored is filled with the unknown value for every field it predates before any screen reads it, and a stored point takes the same step. `src/store/history.test.ts` checks a stored lane, a snapshot older than the capability probe, and a scratch row older than root origins.
2. A stored event is decoded only where the record proves it held a unit. `src/store/history.test.ts` checks four stored events a suffix cannot tell apart.
3. Historical snapshots stay independent of live objects and of callers, so an exported snapshot can be edited without changing the replay cache. `src/store/archive.test.ts` checks exact reconstruction and mutation isolation.
4. A duplicate time and a checkpoint past the budget fail visibly rather than silently, and the uncompressed lines a checkpoint has not sealed yet count against that budget. `src/store/archive.test.ts` checks all three.
5. An append compresses only the lines it added, and no single compression exceeds the open-run limit plus one line. `src/store/archive.test.ts` checks both.
6. A sealed line is read at the line it is, a seal retires a cursor parked before it, and a walk through a checkpoint inflates each of its segments once rather than once per sample. `src/store/archive.test.ts` checks all three.
7. A checkpoint that rolled over is charged what it compressed to, so retention is never shortened inside a budget it did not reach, and no checkpoint but the one still taking lines holds any it has not sealed. `src/store/archive.test.ts` checks both.
8. Settings changes and persistence changes preserve retained incidents, and event derivation continues across them so an alert opened before the change still closes with its full duration. `src/store/history.test.ts` checks transfer and database merging.
9. History refuses an existing database owned by another application, and a database holding only a view still belongs to its existing application. `src/store/history.test.ts` checks both.
10. Persisted snapshots and their sidecar files stay readable only by the owner, because they hold command lines and environment values. `src/store/history.test.ts` checks the modes.
11. Expired snapshots cannot be replayed after a sampling gap. `src/store/history.test.ts` checks the cutoff.
12. Reading recent changes costs the same whether or not there is much to read, and a change aged out by a push leaves the index with its point. `src/store/history.test.ts` checks both.
13. Lane charts keep brief spikes across checkpoints, and reopened history loads complete lane series without duplicating concurrent requests. `src/store/lane-series.test.ts` checks both.
14. Unknown memory readings stay unknown in a point instead of becoming zero. `src/store/point.test.ts` checks them.
15. One read of many lanes inflates each sealed segment and decompresses each stored row once, whatever the number of lanes, and the same read again decompresses nothing and duplicates no sample. A lane that ends, and a checkpoint or stored row the window has passed, leaves its cache, and two readers of one window length whose starts differ by a trend bucket reread at most the rows between. `src/store/archive.test.ts` and `src/store/lane-series.test.ts` count the decompressions for forty lanes and read the caches back.

## Limits of the checks

`bun run bench:history` fills the configured history window with counters that move by a different amount per row at every sample, compares selected replayed snapshots against their originals, and reports the median, 95th percentile and slowest append for both `History.add` and `Archive.add`, as nearest-rank percentiles from `scripts/percentile.ts`, the rule `bun run bench` also uses. Its generated workload does not establish a memory bound for every possible command line or process mix, and its timings come from one machine under whatever else it was running.
