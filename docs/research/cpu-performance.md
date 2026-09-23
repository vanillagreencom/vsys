# CPU performance investigation

## Scope

The owner reports CPU use while vsys runs. This investigation measures the existing Bun and OpenTUI stack. The reviewed source is `ea4c6ef2bedcc28722317ea8c8b4aab014a3d548`. Production code is unchanged.

CPU percentages use one logical core as 100%. The host has other active work. Live comparisons establish the cost of the observed workload, not a universal saving. Short terminal probes cover startup and early operation. The longer scan probe checks whether that cost persists.

## Scratch scans

The live terminal probe runs the production entry point at 160 columns and 36 rows. It uses default collection settings, a temporary error-memory path, and persistence off. It drains terminal output. Measurement starts after 3 seconds and lasts 12 seconds.

| Probe | CPU percent | Samples | Frame calls |
|---|---:|---:|---:|
| Default | 123.18 | 12 | 22 |
| Renderer restored to target 30 and maximum 60 frames per second | 122.16 | 12 | 24 |
| Default repeat | 130.46 | 12 | 23 |
| Scratch disabled for attribution | 10.62 | 12 | 22 |

The CPU profile names `lstat` at 47.8% self time and path `join` at 10.1%. Several additional hot functions are the recursive `walk` in `src/collect/scratch.ts`. Profile percentages are JavaScript profiler samples, not an accounting of all process CPU.

The longer probe measures 65 seconds after startup. It uses 137.26% CPU while publishing 65 foreground samples and drawing 124 frame calls. This separates sustained background cost from the short startup probes.

Scratch work is pending at all 68 observations. At elapsed time 33.10 seconds, the first completed scan timestamp appears while another scan is already pending. The completed traversal has exceeded the default 30-second rescan interval.

`scanRoot` submits an asynchronous file-status read for each entry. The scan continues between foreground samples. `ScratchCollector.collect` prevents overlapping scans but supplies no work or CPU budget. It measures the rescan interval from the attempt start. A scan that outlasts that interval is eligible to run again as soon as it completes. The collector benchmark does not measure this background work.

Implement a bounded scan service with efficient batched traversal in a persistent worker. Preserve one pending scan, root and session hard-link accounting, mount boundaries, symlink exclusion, cancellation, and source failures. Apply an explicit duty budget and a completion-based idle interval. Keep the previous complete result and its measurement time while a scan runs. A scan failure must not publish partial totals as complete. The one-shot command must wait for a complete result. Measure whole-process CPU, worker CPU, completion latency, and keyboard response with realistic scratch trees.

The disabled-scratch run is an attribution control. The deliverable retains scratch readings. An incremental filesystem index is not required by the current evidence.

## Process reads

`ProcessCollector.collect` submits separate asynchronous `stat` and `cmdline` reads for each process. The controlled probe changes only those reads to sequential synchronous reads. The complete process records match between variants. The existing fixture contains 50 scopes and 2000 processes. Variants alternate with 20 measured runs each after warm-up.

| Measurement | Current reads | Sequential probe |
|---|---:|---:|
| Median complete-collection CPU, ms | 43.728 | 25.095 |
| p95 complete-collection CPU, ms | 62.419 | 32.558 |
| Median complete-collection elapsed time, ms | 22.684 | 24.818 |
| p95 complete-collection elapsed time, ms | 41.349 | 32.865 |
| Live median process-read CPU, ms | 15.103 | 5.770 |
| Live median process-read elapsed time, ms | 3.145 | 5.780 |

The live read comparison uses 30 measured runs per variant over 916 to 932 processes. It measures `stat` and `cmdline` reads and parsing. It does not measure a completed worker implementation.

Implement persistent worker ownership of process-read state and batched reads. Send work once per sample. Preserve fresh command lines, process identity, membership, counters, source errors, and unknown values. Define settings replacement, failure, cancellation, and shutdown. Measure the whole application, including transfer and worker costs. The synchronous probe increases median elapsed time. Moving those reads directly onto the UI thread does not meet the responsiveness requirement.

Keep runtime scheduling in `Session`. Scratch traversal must not block process requests behind a shared worker queue. Each worker needs explicit completion, cancellation, failure, and close behavior.

The existing collector benchmark reports median elapsed time of 22.870 ms, including 17.206 ms in process collection. Both controlled variants exceed the documented 20 ms fixture target. The implementation must report that target separately from CPU savings.

## History compression

`History.add` serializes each snapshot. `Archive.add` converts it to columns, computes its delta, then compresses the complete growing active checkpoint again. This occurs with persistence off.

A live series contains 923 to 934 processes, 110 groups, and 56 lanes. Across 30 samples, excluding warm-up, `Archive.add` has median elapsed time 15.74 ms and p95 25.30 ms. Compression has median 11.77 ms and p95 19.06 ms. At sample 29, compression processes a string of 4,141,167 UTF-16 code units for snapshot JSON of 776,955 code units. At the first sample, compression processes 588,778 code units and takes 2.37 ms. The probe uses JavaScript string length; these values are not byte measurements.

A repeated live series reports archive append median 20.39 ms and p95 33.54 ms. Its final compression input reaches 5,259,427 UTF-16 code units. The uniform shipped fixture understates this cost: its compression median is 0.71 to 0.73 ms.

Implement bounded active checkpoint data that appends each delta once. Seal it into immutable compressed data. Update replay, copying, pruning, retention warnings, and lane-series reads together. Account for uncompressed active memory and temporary sealing allocations. Retain exact snapshots and caller mutation isolation. Do not change retention or lower the sampling rate to obtain a saving.

Measure finalization pauses across complete checkpoints. Moving repeated work into a large blocking seal operation does not satisfy the input-response requirement.

## Existing work and declined candidates

- VSY-19 already covers repeated decompression when the Agents list requests more lanes than the cache holds. Keep that issue for batched history reads.
- VSY-23 already covers per-write history measurement and budgets. Keep that issue for validation of the history write path.
- Frame-rate limits did not reduce CPU in the controlled terminal probe. No separate frame-rate issue is justified by this evidence.
- The profile does not justify broad React memoization or a UI rewrite.
- Synchronous SQLite writes are already recorded in VSY-23. A second issue with that scope would duplicate it.

## Validation and sources

Each implementation must compare CPU and elapsed time against the current code with the same refresh interval and readings. Use behavior checks for failure handling and exact data. Use repeatable performance probes for CPU and latency. Include a deliberately regressed implementation when validating a performance guard. Run the full repository check contract before claiming an implementation passes.

- Local source: `src/collect/scratch.ts`, `src/collect/procs.ts`, `src/collect/collector.ts`, `src/store/archive.ts`, `src/store/history.ts`, `src/runtime.ts`, and `src/main.ts`.
- Local benchmark contracts: `DEVELOPMENT.md`, `scripts/bench.ts`, and `scripts/bench-history.ts`.
- OpenTUI renderer scheduling: the installed `@opentui/core` package, version 0.5.11. Its request-driven scheduler stops when there is no pending work.
- [Bun worker documentation for the pinned runtime](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/runtime/workers.mdx): message transfer and worker termination.
- [Bun profiling documentation for the pinned runtime](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/project/benchmarking.mdx): CPU profile capture.

Local reproduction files are `tmp/cpu-ui-probe.ts` and `tmp/cpu-ui-driver.py`. The CPU profile is `tmp/cpu-ui-profile.md`. Probe outputs contain timing and operation metadata. They do not contain snapshots or environment values.
