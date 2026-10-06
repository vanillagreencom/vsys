# Build work is counted from one classification

Read before changing how compile and link work, the build cache or the make token pools are counted.

## The approach

`compileOrLink()` in `src/collect/builds.ts` is the one predicate behind every build slot total, machine wide and per lane, so the Builds screen and the Home build tile cannot disagree. The configured compiler, linker and cache names are the only such lists. `SccacheCollector` in `src/collect/sccache.ts` queries the build cache through an injected runner, rate limited between samples and with a deadline of its own. A make token pool is read from the configured environment variable alone.

## Why

Two classifications let a tile and a table disagree about one machine. A jobserver FIFO hands out tokens, so opening it would take one from the build vsys is watching.

## Rules

- Do classify a process once. A supervising cargo, a running test binary and a build script runner are builds that hold no slot. `src/model/builds.test.ts` checks a cargo parent with two compiler children and requires the per-lane rows to sum to the fleet total.
- Do count a token pool once, on the outermost process holding it, since the variable is inherited. A pool whose flags omit a job count has an unknown total.
- Do give a collector in a test no runner, so no test starts a cache server.
- Do carry the cache reader over to a replaced collector, so counts stay measured since vsys started ([settings.md](settings.md)).
- Do keep a missing cache binary an absent feature and a failed or late query a source error with a null reading ([unknown-readings.md](unknown-readings.md)). The Cache hits tile names the two apart.
- Never open a jobserver FIFO.
- Never let a counter that went backwards produce a negative delta. A restarted cache server rebases, and `src/collect/sccache.test.ts` checks a restart.

## The canonical example

`compileOrLink()` and its callers: the per-lane rows, the fleet total and the slot predicate all call it. Copy that for a new kind of build work.

## Revisit when

A build system hands out work through something other than process names and an environment variable.

## Not governed

Which processes are agents: [agent-tools.md](agent-tools.md).
