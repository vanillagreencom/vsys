# D004: Bound scratch traversal with a duty cycle on its own thread

[← Decision Index](INDEX.md)

**Date**: 2026-09-15

**Status**: Active

**Research**: VSY-45, attached to [VSY-44](https://linear.app/vanillagreen/issue/VSY-44/reduce-dashboard-cpu-use-without-losing-sample-or-history-accuracy) as `cpu-performance.md`

**Context**: Scratch traversal ran on the dashboard's own thread, submitting one asynchronous status read per entry. With populated scratch roots the dashboard held 123 to 137 percent of one processor core, and traversal was in flight at every observation because a scan longer than the rescan interval became eligible again the instant it finished.

**Decision**: Traversal runs on a worker thread that reads each directory in one listing and takes each entry's status synchronously. It works for a slice, then rests for the share of that slice its duty does not grant, and it becomes eligible again only once the rescan interval has passed since the last traversal finished. A caller that waits for the reading gets the whole thread.

**Rationale**:

- Synchronous reads spend less processor time than one asynchronous request per entry, and a thread of vsys's own is where blocking costs no sample.
- The rest is what bounds the cost. Faster reads alone would leave a continuous traversal taking whatever a large root demands.
- Resting returns the thread to its queue, which is what lets a cancellation reach a traversal that is running.
- A scripted one-shot has no screen to protect, so resting would only make its caller wait.
- An incremental filesystem index would avoid re-reading unchanged directories, but it holds state vsys would have to keep correct against every writer on the machine. The measured cost does not call for it.

**Revisit When**: A configured root grows large enough that a bounded traversal cannot finish within the reader's tolerance, or a kernel interface reports directory sizes without a traversal.

**Verification**: `bun run bench:scratch` reports elapsed time and processor time for a full-thread scan and a bounded one over one tree and checks that both read one total. `src/collect/scratch-scan.test.ts` checks the rest a slice earns and that a paced traversal returns its thread; `src/collect/scratch.test.ts` checks eligibility from completion.

**References**: `src/collect/scratch.ts`, `src/collect/scratch-scan.ts`, `src/collect/scratch-worker.ts`, [storage architecture](../architecture/storage.md)
