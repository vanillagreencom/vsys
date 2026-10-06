# Scratch is measured from the roots the settings and the running agents name, under a duty cycle

Read before changing which directories Storage measures as scratch, how often, or how much processor time the traversal may hold.

## The approach

`scratchRoots()` in `src/collect/scratch.ts` decides the roots: the `scratchDirs` setting and the temporary directories running agents name in the variables `scratchEnv` lists in `src/collect/procs.ts`, which process collection already reads. The traversal runs on its own thread ([collection-threads.md](collection-threads.md)), works for a slice, then rests until that slice is no more than `scratchDutyPercent` of the two, and is eligible again `scratchRefreshMs` after the last traversal finished. `ScratchCollector` publishes only complete readings. [D007](../decisions/D007-scratch-scan-duty.md) records why a duty cycle rather than a stored index.

## Why

A traversal of a populated scratch tree held more than a processor core while it ran, and measured from its start it was eligible again the instant it ended. Resting is what bounds the cost. A reading published half-way would be a partial total read as complete.

## Rules

- Do measure a running agent's directory whatever the settings list holds, and measure a directory inside a listed root as part of that root with no row of its own.
- Do carry each root's origin on its row. Storage names it under the selected root.
- Do keep the last complete reading and its time when a traversal fails, and name what failed beside them.
- Do give a caller that waits for the reading, such as `--once`, the whole thread: a script has no screen to protect.
- Do skip scratch under `--once --summary`; the scratch cause then keeps a null level ([verdict.md](verdict.md)).
- Never measure a root another user owns, such as the system `/tmp`. It leaves no row.
- Never fail a shipped default root for not existing; a missing root on any other list keeps a failing row. `src/collect/scratch-scan.test.ts` pins one row per origin and state.
- Never remove the rest. The bound lives in a timer on the thread, where a unit test stages the clock, so `bun run bench:scratch`, in `scripts/ci.py`, is the one instrument that sees it: it refuses a bounded scan that asked for no rest or finished before the rest it asked for.

## The canonical example

`restMs()` in `src/collect/scratch-scan.ts`: the rest a spent slice earns at a duty, zero at a duty of 100. Every slice the traversal spends awaits it. Copy the pattern for any other bounded background work.

## Revisit when

A root grows past what a bounded traversal finishes within the reader's tolerance, or a kernel interface reports directory sizes without a traversal ([D007](../decisions/D007-scratch-scan-duty.md)).

## Not governed

Thread start, failure and close: [collection-threads.md](collection-threads.md). Which processes are agents: [agent-tools.md](agent-tools.md).
