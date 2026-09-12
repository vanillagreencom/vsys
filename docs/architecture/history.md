# History store

Covers: src/store/archive.ts src/store/history.ts src/store/migrate.ts src/store/point.ts src/store/lane-series.ts

The store keeps complete snapshots for replay and one point per sample for the charts. It owns application persistence; the collector does not depend on SQLite.

## Boundaries

- The archive holds compressed checkpoints in memory and reports shortened retention when the data exceeds its budget and persistence is off. SQLite retains snapshots beyond that cache and across restarts.
- `normalizeSnapshot()` and `normalizePoint()` in `src/store/migrate.ts` are the whole of the load path's migration. They fill the fields a stored record predates and are idempotent.
- The load path never rewrites a stored record on what it looks like. An event subject becomes the unit it was only where the record proves it held one: the event kind carries a unit field, that field is absent, and the subject equals the last segment of its own cgroup-path identity.
- Retention is bounded by time, and the points ring grows rather than dropping a point still inside the window.

## Invariants

1. A snapshot a previous build stored is filled with the unknown value for every field it predates before any screen reads it, and a stored point takes the same step. `src/store/history.test.ts` checks a stored lane and a snapshot older than the capability probe.
2. A stored event is decoded only where the record proves it held a unit. `src/store/history.test.ts` checks four stored events a suffix cannot tell apart.
3. Historical snapshots stay independent of live objects and of callers, so an exported snapshot can be edited without changing the replay cache. `src/store/archive.test.ts` checks exact reconstruction and mutation isolation.
4. A duplicate time and a checkpoint past the budget fail visibly rather than silently. `src/store/archive.test.ts` checks both.
5. Settings changes and persistence changes preserve retained incidents, and event derivation continues across them so an alert opened before the change still closes with its full duration. `src/store/history.test.ts` checks transfer and database merging.
6. History refuses an existing database owned by another application, and a database holding only a view still belongs to its existing application. `src/store/history.test.ts` checks both.
7. Persisted snapshots and their sidecar files stay readable only by the owner, because they hold command lines and environment values. `src/store/history.test.ts` checks the modes.
8. Expired snapshots cannot be replayed after a sampling gap. `src/store/history.test.ts` checks the cutoff.
9. Reading recent changes costs the same whether or not there is much to read, and a change aged out by a push leaves the index with its point. `src/store/history.test.ts` checks both.
10. Lane charts keep brief spikes across checkpoints, and reopened history loads complete lane series without duplicating concurrent requests. `src/store/lane-series.test.ts` checks both.
11. Unknown memory readings stay unknown in a point instead of becoming zero. `src/store/point.test.ts` checks them.

## Limits of the checks

`bun run bench:history` replays the configured history window with changing process identities and compares selected complete snapshots against their originals. Its generated workload does not establish a memory bound for every possible command line or process mix.
