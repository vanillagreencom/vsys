# History store

Covers: src/store/archive.ts src/store/history.ts src/store/migrate.ts src/store/point.ts src/store/lane-series.ts

The store keeps complete snapshots for replay and one point per sample for the charts. It owns application persistence; the collector does not depend on SQLite.

## Invariants

- A snapshot a previous build stored is filled with the unknown value for every field it predates before any screen reads it. `src/store/history.test.ts` checks a stored lane and a snapshot older than the capability probe.
- Historical snapshots remain independent of live objects and callers. `src/store/archive.test.ts` checks exact reconstruction and mutation isolation.
- Settings changes and persistence changes preserve retained incidents. `src/store/history.test.ts` checks transfer and database merging.
- History storage rejects a database with another application's schema. `src/store/history.test.ts` checks tables and views.

## Validation limits

The archive caps compressed replay data. It reports shortened retention when the data exceeds that budget and persistence is off. SQLite retains snapshots beyond the memory cache and across restarts.

`scripts/bench-history.ts` checks the configured history window with changing process identities. It verifies selected complete snapshots against their originals. Its generated workload does not establish a memory bound for every possible command line or process workload.

The collector benchmark uses regular-file fixtures. Its result does not guarantee live procfs latency.
