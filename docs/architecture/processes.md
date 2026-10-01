# Process collection

Covers: src/collect/procs.ts src/collect/process-thread.ts src/collect/process-worker.ts src/collect/collector.ts src/collect/process-thread.test.ts scripts/bench.ts

Process collection reads every process in the configured `/proc` once per sample. The program runs it on a thread of its own, so a keystroke never waits behind the process table, and that thread keeps the state the next reading compares against.

## Boundaries

- `ProcessCollector.read()` in `src/collect/procs.ts` is the one reader. It reads each file synchronously, one after another, and owns the environment cache and the last reading's counters.
- `ProcessThread` in `src/collect/process-thread.ts` is the one host of that reader on a thread. `createCollector()` gives every collector the program builds one, for the dashboard and `--once` alike. A collector given none runs the same reader in its caller's thread, which is how the collection suites run.
- `Session` in `src/runtime.ts` stays the only sample scheduler. A sample sends one request holding the sample time, the uptime and the watched membership. The thread does no work between requests, and scratch traversal never shares it.
- A settings change builds a new collector, and with it a new thread that starts from nothing. Closing a collector ends its thread.
- The reply crosses as JSON text. Bun hands a string to another thread without cloning it, and every value in a reading is a string, a finite number, a boolean or null.
- Bun's bundler does not follow a worker URL. The `build` and `compile` scripts in `package.json` name `src/collect/process-worker.ts` as a second entry point, and the release workflow and the `vsys-git` package build through `bun run compile`. A build without that entry point fails its first sample with `No process worker beside <path>`.

## Thread lifecycle

- Start: the first request starts the thread and sends its setup message, the collection settings and the clock and page units, before the request.
- Request: a waiting request keeps the program alive; an idle thread does not.
- Failure: a reading that threw rejects the sample with its message and keeps the thread. A thread error or an exit before the answer rejects the sample and ends the thread.
- Replacement: the next request after an ended thread starts a new one. Its first reading has no rate, which is unknown rather than a rate measured against a reading it never took.
- Cancellation: an aborted request ends the thread, so no unwanted reading holds up the next request.
- Stale replies: a reply naming another request, or arriving from a thread the host already replaced, is dropped.
- Overlap: a second request while one is in flight is refused.

## Invariants

1. A reading taken on the thread equals the reading the same reader takes in its caller's thread, and a collector on a thread publishes the same snapshot as one without. `src/collect/process-thread.test.ts` compares both over a fixture with watched and unwatched processes, an agent, a build tool, a Git branch, an invalid stat line and an unreadable environment.
2. Counters and launch environments are keyed by process id and start time, never by process id alone, and a command line is read fresh at every sample. `src/collect/process-thread.test.ts` covers an exit, a reused id and a changed command line through the thread.
3. A source the thread could not read reaches the snapshot's errors and never becomes a value. `src/collect/process-thread.test.ts` checks the invalid stat line in the published snapshot.
4. Every failure path answers the waiting sample and ends a thread that can no longer be trusted. `src/collect/process-thread.test.ts` drives each one through a stand-in thread.

## Decisions

- Synchronous reads cost less processor time than one asynchronous request per file. On the dashboard's own thread they would raise the time a keystroke waits, so they run on a thread vsys keeps for the life of its settings. A thread per sample would pay its startup every second and lose the environment cache each time.
- Starting the process read before the cgroup tree would shorten a sample, but it needs two messages per sample and a reading that waits halfway for membership. `DEVELOPMENT.md` records the elapsed time this leaves against the 20 ms fixture target.
