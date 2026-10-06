# A blocking read runs on a thread of its own, under one lifecycle

Read before changing how processes or scratch directories are read, adding a worker thread, or changing how a build ships one.

## The approach

Process reads and scratch traversal each run on a worker thread the collector keeps: `ProcessThread` in `src/collect/process-thread.ts` and `WorkerScan` in `src/collect/scratch.ts`. Both run through `WorkerHost` in `src/collect/worker-host.ts`, the one lifecycle: the thread starts at the first request, serves one request at a time, is kept until a failure, a cancellation or the close ends it, and the next request after that starts a new one. `Session` in `src/runtime.ts` stays the only scheduler. A reply crosses as JSON text. [D008](../decisions/D008-process-reads-on-their-own-thread.md) and [D007](../decisions/D007-scratch-scan-duty.md) record why each read moved.

## Why

A read blocked in the kernel, on a stalled mount or a large `/proc`, must not hold the dashboard thread where a keystroke waits, and must not keep the program from exiting. One lifecycle means every failure path answers the waiting sample and ends a thread that can no longer be trusted, checked once for both threads.

## Rules

- Do supply only how a thread starts, its setup message and how its reply is read, as a `WorkerSpec`. The host owns start, failure, replacement, cancellation and close. `src/collect/worker-host.test.ts` drives each rule through a stand-in thread.
- Do keep a thread's state where the reading is taken. The process thread holds the environment cache and the last counters, so a request carries no copy of the previous sample.
- Do rebuild the collector, and with it its threads, only for a change to a setting in `collectionKeys` ([settings.md](settings.md)).
- Do add a new worker to `entrypoints` in `scripts/build.ts` and to `ARTIFACTS` in `scripts/ci.py`. Bun's bundler does not follow a worker URL, so a build without it ships a program whose first sample fails. `scripts/ci_test.py` holds the artifact list to every `*-worker.ts` under `src/`, and `bun run smoke` samples the bundle and a compiled binary.
- Do find a worker through `workerFile()` in `src/collect/worker-file.ts`, which resolves it for the bundle and for the standalone binary alike.
- Never read a process file on the dashboard thread in the program. A collector built in a test reads in its caller's thread, and `src/collect/process-thread.test.ts` requires the two readings equal.
- Never share one thread between process reads and scratch traversal; a traversal must not block a process request.
- Never let an ended thread's late reply, error or exit reach the request now waiting. `src/collect/worker-host.test.ts` fires each from an ended thread.

## The canonical example

`ProcessThread` in `src/collect/process-thread.ts`: a `WorkerSpec` with a starter, a setup message carrying the settings and the shared agent-tool data, and a reply parser. Everything else is the host's. Copy it for a new thread.

## Revisit when

Bun's asynchronous file reads stop costing more processor time than synchronous ones ([D008](../decisions/D008-process-reads-on-their-own-thread.md)), or a reading needs more than one request in flight.

## Not governed

What the process reader derives: [lanes.md](lanes.md) and [agent-tools.md](agent-tools.md). What the scratch traversal measures: [scratch.md](scratch.md).
