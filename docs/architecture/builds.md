# Build work

Covers: src/model/builds.ts src/collect/builds.ts src/collect/sccache.ts src/ui/builds.ts

Compile and link work is counted machine wide and per lane from one classification, so the Builds screen and the Home meter cannot disagree. The build cache and the make token pools are read alongside it.

## Boundaries

- The build cache reading queries the sccache server through an injected runner, rate limited between samples and bounded by its own deadline, so a wedged server cannot hold the sample the dashboard awaits. A collector built without a runner records no reading, so no test starts that server.

## Invariants

- The configured compiler names and the configured token pool variable are the only such lists: a name in them holds a build slot wherever slots are counted, and a pool is read from that variable alone. `src/model/builds.test.ts` checks a wrapper name through the classifier, the slot predicate, the fleet total and the lane rows, and `src/model/naming.test.ts` checks another build system's variable.
- One predicate decides every build slot total: a compiler or a configured linker. cargo, a running test binary and a build script runner are classified builds that hold no slot, while the per-process list keeps the broad classification. `src/model/builds.test.ts` checks a cargo parent with two compiler children.
- The Builds tile and the Home build tile are one `meterTile` result from one buildLoad. The rows read the build counts each lane already carries, and build processes in no lane form one more row, so the rows sum to that total. `src/ui/attention.test.ts` checks the tile wording and `src/model/builds.test.ts` checks the sum, including build processes outside every lane.
- Only a build process with an empty RUSTC_WRAPPER in a readable environment bypasses the build cache. `src/model/builds.test.ts` checks a set wrapper and an unreadable environment.
- A jobserver FIFO is never opened, because reading it would take a token from the build. One parser reads the configured variable for the lane's own pool and for the fleet pools. That variable is inherited, so tokens in use count only the outermost build process holding each pool, and a pool whose flags omit a job count has an unknown total. `src/model/builds.test.ts` checks a linker under its compiler, sibling compilers under one make, and a pool without a job count.
- Build cache counters are compared with the latest reading, so a server restarted at any point rebases rather than producing a negative delta or mixing two lifetimes. A missing sccache binary is an absent feature rather than a source error, and a query that does not answer in time is a source error with an unavailable reading. `src/collect/sccache.test.ts` checks a restart after the counters grew, the missing binary, a failing query and a query that never answers.
- A settings change replaces the collector and carries the build cache reader over, so the counts stay measured since vsys started. `src/runtime.test.ts` checks the handover and `src/collect/collector.test.ts` checks the continued delta.
- A build process's own environment supplies its compiler wrapper and make token pool. `src/collect/collector.test.ts` checks both fields against the unselected variables.
