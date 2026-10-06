# The sample flows one way, and what vsys could not read stays unknown

Read before moving work between `src/collect/`, `src/model/`, `src/store/` and `src/ui/`, adding a read the collector makes, adding a reading or a setting, or changing what a settings change rebuilds.

## The approach

The collector reads the machine into a sample. The model derives lanes, causes and meters from it as numbers and identifiers. The store keeps it. The UI draws it and writes the words. Each layer reads only the one before it, and the dashboard changes the system from one place, `runEffect()` in `src/effect.ts` ([lane-actions.md](lane-actions.md)).

A sample holds the observed values beside the source errors met while reading them, and the two never collapse into each other. A counter the kernel did not report, a file this user may not read and a parse that failed each stay null, and every screen, meter, alert and stored record reads that one sample. A capability is a system interface a reading needs; vsys probes it once at start, and a missing one blanks the readings it feeds.

The collector is built from the collection settings alone and lives until one of them changes. `Session` in `src/runtime.ts` is the one scheduler, so no sample overlaps a settings change. A read that can block in the kernel runs on a worker thread the collector keeps, under one lifecycle, `WorkerHost` in `src/collect/worker-host.ts`. [D008](../decisions/D008-process-reads-on-their-own-thread.md) and [D007](../decisions/D007-scratch-scan-duty.md) record why process reads and scratch traversal moved there.

## Why

A word written in the model reaches the `--once` JSON that other programs parse, where it cannot be reworded without breaking a reader. A collector that imports the UI cannot be tested against a fixture. One direction keeps a screen change a UI change and a reading change a collector change.

A zero for a number vsys could not read reads as an untroubled machine. A blank, with the cause in the drill-down, tells the reader what the dashboard does not know.

Rebuilding the collector discards the counters and alert state a sample compares against, so a display setting that rebuilt it would reset every rate on the screen. A read blocked on a stalled mount or a large `/proc` must not hold the dashboard thread, where a keystroke waits, or keep the program from exiting. A count drawn in two places from two classifications lets a tile and a table disagree about one machine.

## Rules

- Do return numbers and identifiers from `src/model/`, and write every word and every formatted number in `src/ui/`.
- Do keep the two exceptions where they are: the failure sentences the collectors write (`errors[].message`, `capabilities[].detail`, `storage.udisks.detail`, `storage.scratch[].error`) and the alert sentence the model writes (`alerts[].message`). Other programs read them from the `--once` snapshot, and they move to `src/ui/` only by an owner decision.
- Do build the program's collector through `createCollector()` in `src/collect/collector.ts`, which hands it every host reader. A `Collector` given none reaches no host service, so a test starts no build cache, tmux server or journal search.
- Do record a failed read as a source error against the source that failed, through `Reader` in `src/collect/io.ts`, and leave the value null. `src/collect/collector.test.ts` plants an invalid counter and requires a source error and no number.
- Do keep a read that fails on one process from dropping the sample: the process is left out, and `omittedProcess()` in `src/collect/procs.ts` lets a total that process would have changed stay unknown.
- Do keep an absent feature apart from a failed read. A missing build cache binary is an absent feature with no error, and a failed or late query is a source error with a null reading.
- Do grade a meter whose input is null as a warning, never as untroubled, and keep that level in the summary while the reading stays null. `src/model/verdict.test.ts` checks the four meters.
- Do keep a missing capability's cost on the screen and its own words in the drill-down. Settings offers the line that would add it through `capabilityOffer()` in `src/ui/settings.ts`; the line is text to copy, and vsys never runs it.
- Do read a readable `io.stat` with no line for a device as zero bytes, the one exception, because the kernel adds the line on the group's first I/O. A missing or unreadable `io.stat` stays unknown. `src/collect/collector.test.ts` checks an empty file against a removed one.
- Do take `CollectionConfig` from `src/collect/settings.ts` in every collection entry point, and declare a new collection setting in `collectionKeys` there. `CollectionConfig` picks those keys, so a collector reading an undeclared setting fails the type check.
- Do keep a display setting and a notification rule out of `collectionKeys`. `src/runtime.test.ts` checks that each leaves the collector in place.
- Do hand a replaced collector its predecessor's build cache reader, kernel log cursor and finished-scrub memory, so readings measured since vsys started survive a settings change. `src/runtime.test.ts` and `src/collect/collector.test.ts` check the handover.
- Do save only what differs from the layered defaults ([D006](../decisions/D006-settings-save-writes-only-changed-keys.md)), and send a Settings edit to the agent tools to the shared overlay ([lanes.md](lanes.md)). A save of the resolved configuration would freeze a derived default as user intent. `src/runtime.test.ts` checks pinned and unpinned saves, and that a failed write leaves the active source and history usable.
- Do give every host-specific name a systemd user-session default, and ship write mode off. `src/config/config.test.ts` checks both.
- Do give every setting one entry in `settingInfo` in `src/ui/settings.ts` and one group. `src/ui/settings.test.ts` and `src/ui/settings-screen.test.tsx` derive the expected sets from the defaults.
- Do resolve an XDG base directory through `xdgHome()` in `src/config/xdg.ts`. The overlay stays at `~/.config/vsys/agent-tools.json` whatever `XDG_CONFIG_HOME` holds, because the warden reads it there.
- Do give a new worker thread only a `WorkerSpec`: how it starts, its setup message and how its reply is read. The host owns start, failure, replacement, cancellation and close, and an ended thread's late reply, error or exit never reaches the request now waiting. `src/collect/worker-host.test.ts` drives each rule through a stand-in thread.
- Do add a new worker to `entrypoints` in `scripts/build.ts` and to `ARTIFACTS` in `scripts/ci.py`, and find it through `workerFile()` in `src/collect/worker-file.ts`. Bun's bundler does not follow a worker URL, so a build without the entry ships a program whose first sample fails. `scripts/ci_test.py` holds the artifact list to every `*-worker.ts` under `src/`, and `bun run smoke` samples the bundle and a compiled binary.
- Do bound background work with a duty cycle: work a slice, then rest. `restMs()` in `src/collect/scratch-scan.ts` is the rest scratch traversal takes, and a caller that waits for the reading, such as `--once`, gets the whole thread. The bound lives in a timer a unit test stages, so `bun run bench:scratch`, in `scripts/ci.py`, is the one instrument that sees it, and it refuses a bounded scan that took no rest.
- Do measure as scratch the roots the `scratchDirs` setting lists and the temporary directories running agents name, through `scratchRoots()` in `src/collect/scratch.ts`. `src/collect/scratch-scan.test.ts` pins one row per origin and state.
- Do count one kind of work through one predicate wherever it is drawn. `compileOrLink()` in `src/collect/builds.ts` is behind every build slot total, machine wide and per lane, and `src/model/builds.test.ts` requires the per-lane rows to sum to the fleet total.
- Do count a make token pool once, on the outermost process holding it, since the variable is inherited. A pool whose flags omit a job count has an unknown total.
- Never import `src/ui/` from `src/collect/`, `src/model/` or `src/store/`. Review holds this; no check refuses the import.
- Never write kernel state from the collector, the model or the store.
- Never make collection depend on the store; SQLite is the store's alone.
- Never let a failed read become a zero, and never draw a zero for a number vsys could not read.
- Never read a process file on the dashboard thread in the program. A collector built in a test reads in its caller's thread, and `src/collect/process-thread.test.ts` requires the two readings equal.
- Never share one thread between process reads and scratch traversal; a traversal must not block a process request.
- Never measure a scratch root another user owns, such as the system `/tmp`, and never fail a shipped default root for not existing.
- Never open a make jobserver FIFO. Opening it takes a token from the build vsys is watching.
- Never let a counter that went backwards produce a negative delta. A restarted build cache server rebases, and `src/collect/sccache.test.ts` checks a restart.

## The canonical example

The build cache, read in three layers. `src/collect/sccache.ts` returns an absent feature, a source error with a null reading, or counts. `hitRate()` in `src/model/builds.ts` gives a cache that served nothing no hit rate rather than a zero. `src/ui/builds-screen.tsx` formats each count, writes every heading, and names the absent feature apart from the failed query. Copy the split and the three outcomes.

## Revisit when

A consumer of the snapshot needs prose the model does not write, or a zero in place of null; either is a change to the snapshot contract. A layer needs a second owner of system change. Bun's asynchronous file reads stop costing more processor time than synchronous ones ([D008](../decisions/D008-process-reads-on-their-own-thread.md)). A scratch root grows past what a bounded traversal finishes within the reader's tolerance ([D007](../decisions/D007-scratch-scan-duty.md)). The shared agent-tool schema can record removals ([D006](../decisions/D006-settings-save-writes-only-changed-keys.md)).

## Not governed

What each layer computes. The docs listed in `AGENTS.md` own their subjects: which processes are agents in [lanes.md](lanes.md), which readings grade a cause in [verdict.md](verdict.md), and how a stored record that predates a field is read in [history.md](history.md).
