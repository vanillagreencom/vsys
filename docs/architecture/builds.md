# Build work

Covers: src/model/builds.ts src/collect/builds.ts src/collect/sccache.ts src/ui/builds-screen.tsx

Compile and link work is counted machine wide and per lane from one classification, so the Builds screen and the Home build tile cannot disagree. The build cache and the make token pools are read alongside it.

## Boundaries

- `compileOrLink()` in `src/collect/builds.ts` is the one predicate behind every build slot total. The per-process classification stays broader: cargo, a running test binary and a build script runner are builds that hold no slot.
- The configured compiler, linker and cache names are the only such lists, and the configured variable is the only place a token pool is read from.
- `SccacheCollector` queries the cache server through an injected runner, so a collector given none spawns nothing and no test starts a server. The query is rate limited between samples and carries its own deadline, so a wedged server cannot hold the sample the dashboard awaits.
- A jobserver FIFO is never opened, because reading it would take a token from the build. The pool is read from the environment variable alone.

## Invariants

1. A configured wrapper name holds a build slot wherever slots are counted. `src/model/builds.test.ts` checks a wrapper through the classifier, the slot predicate, the fleet total and the lane rows.
2. A supervising cargo is not a build slot beside the compilers it runs. `src/model/builds.test.ts` checks a cargo parent with two compiler children.
3. The per-lane rows sum to the fleet total the meter shows, with build processes in no lane forming one more row. `src/model/builds.test.ts` checks the sum including work outside every lane.
4. Only a build process with an empty compiler wrapper in a readable environment bypasses the build cache. `src/model/builds.test.ts` checks a set wrapper and an unreadable environment.
5. A cache that served nothing has no hit rate, and an unstated pool size is not reported as an unreadable one. `src/model/builds.test.ts` and `src/ui/builds-screen.test.ts` check both.
6. The token pool variable is inherited, so only the outermost build process holding each pool counts its tokens, and a pool whose flags omit a job count has an unknown total. `src/model/builds.test.ts` checks a linker under its compiler, sibling compilers under one make, and a pool without a job count.
7. Qualified cache lines are subsets of the totals and never add to them. `src/collect/sccache.test.ts` checks the parser.
8. Cache counters are compared with the latest reading, so a server restarted at any point rebases rather than producing a negative delta. `src/collect/sccache.test.ts` checks a restart after the counters grew.
9. A missing cache binary is an absent feature rather than a source error, and a query that does not answer in time is a source error with an unavailable reading. `src/collect/sccache.test.ts` checks the missing binary, a failing query and one that never answers.
10. A settings change replaces the collector and carries the cache reader over, so the counts stay measured since vsys started. `src/runtime.test.ts` checks the handover and `src/collect/collector.test.ts` checks the continued delta.
11. A build process's own environment supplies its compiler wrapper and its make token pool. `src/collect/collector.test.ts` checks both fields against the unselected variables.
