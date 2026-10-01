# D008: Read processes on a persistent thread, one file at a time

[← Decision Index](INDEX.md)

**Date**: 2026-10-01

**Status**: Active

**Research**: [cpu-performance.md § Process reads](../research/cpu-performance.md#process-reads)

**Context**: Process collection sent one asynchronous read for each process's `stat` and `cmdline`, in batches of 64, on the dashboard's own thread. The research measured that these reads cost more processor time than reading the same files synchronously. It also measured that synchronous reads on the dashboard's thread raise the elapsed sample time, and a keystroke would wait behind that time.

**Decision**: The program reads processes on a worker thread. The collector keeps the thread until one of its collection settings changes. The thread reads each file synchronously, one after another. It holds the environment cache and the last reading's counters. A sample sends one request with the sample time, the uptime and the watched membership. The thread answers with JSON text. The dashboard and `--once` use the same thread.

## Alternatives Considered

| Alternative | Why rejected |
| --- | --- |
| Asynchronous batched reads on the dashboard's thread, the previous reader | Costs the most processor time per sample |
| Synchronous reads on the dashboard's thread | The thread is blocked for the whole read, so a keystroke waits |
| A new thread for each sample | Pays the thread startup at every refresh and loses the environment cache each time |
| Start the process read before the cgroup tree, then send membership | Needs two messages per sample and a reading that stops halfway; the issue asks for one request per sample |
| Structured clone for the reply | Measured 3.5 ms for a 2000-process reading against 1.5 ms for a JSON round trip, and the clone is read on the dashboard's thread |
| The previous sample's processes sent with each request | Copies the whole previous reading every sample; the thread already holds the counters it needs |
| In-thread reads for `--once` only | A second production path; the thread costs the one-shot summary 13 ms of wall time and saves it 24 ms of processor time |

## Trade-off

From the fixture of 50 scopes and 2000 processes in [DEVELOPMENT.md](../../DEVELOPMENT.md#benchmarks-and-what-they-do-not-prove):

| Measurement | Before | After |
| --- | --- | --- |
| Median processor time per sample | 40.7 to 41.5 ms | 27.0 to 28.4 ms |
| Median elapsed time per sample | 17.6 to 18.3 ms | 23.0 to 23.8 ms |
| Samples under the 20 ms elapsed target | 32 to 35 of 40 | 0 of 40 |
| Median input event delay while sampling | 0.29 to 0.32 ms | 0.010 to 0.012 ms |
| Resident memory | 97.8 to 100.7 MiB | 107.7 to 108.8 MiB |

The decision accepts the missed elapsed target for lower processor time and a dashboard thread that `/proc` reads no longer block. The asynchronous reader overlapped its reads, so its samples finished sooner while costing more processor time.

**Rationale**:

- Processor time is the cost the owner reported, and it falls by about a third on the fixture and a quarter on the live `/proc`.
- The elapsed time a sample takes on another thread does not delay a keystroke.
- State kept where the reading is taken means a request carries no copy of the previous sample.
- Bun hands a string between threads without cloning it, and every value in a reading survives JSON exactly.

**Revisit When**: The 20 ms elapsed fixture target becomes a requirement again, the extra resident memory matters on a target machine, or Bun's asynchronous file reads stop costing more processor time than synchronous ones.

**Verification**: `bun run bench` reports elapsed and whole-process processor time on the shipped arrangement. `bun run smoke` samples the bundle and a compiled binary built from the shared entry points, and the release workflow samples the binary it ships. The invariants in [process collection](../architecture/processes.md) name the tests.

**References**: `src/collect/procs.ts`, `src/collect/process-thread.ts`, `src/collect/process-worker.ts`, [process collection](../architecture/processes.md)
