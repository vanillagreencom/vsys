# Sample boundaries

Read before moving work between `src/collect/`, `src/model/`, `src/store/` and `src/ui/`, adding a read, reading or setting, changing collection lifecycle, counting build work, or changing worker packaging.

## The approach

The collector reads the machine. The model derives numbers and identifiers. The store retains them. The UI draws them and writes the words. A failed or unavailable reading stays unknown through every layer. Only the effect boundary in [lane-actions.md](lane-actions.md) changes kernel state.

Collection settings define one collector lifetime. `Session` in `src/runtime.ts` schedules collection and settings changes. `WorkerHost` in `src/collect/worker-host.ts` owns blocking readers on separate threads under [D008](../decisions/D008-process-reads-on-their-own-thread.md) and [D007](../decisions/D007-scratch-scan-duty.md).

## Why

A zero for an unread counter presents an untroubled machine. Rebuilding on a display edit discards rate baselines. Blocking the drawing thread delays keystrokes. Separate owners prevent one of these costs from becoming another layer's hidden behavior.

## Rules

Review holds boundaries without a named check.

- Return numbers and identifiers from the model. Write prose and formatted values in the UI. Preserve the existing snapshot prose exceptions: collector failures in `errors[].message`, `capabilities[].detail`, `storage.udisks.detail` and `storage.scratch[].error`, and model alerts in `alerts[].message`. Moving them needs an owner decision because external snapshot readers consume them.
- Build the program's collector through `createCollector()` in `src/collect/collector.ts`. Inject host readers; a `Collector` without them must reach no host service.
- Record a failed read against its source through `Reader` in `src/collect/io.ts` and leave the value null. A failed process read must not drop the sample. Carry its outcome with the sample so replay does not infer completeness from current settings. `src/collect/collector.test.ts` and `src/model/verdict.test.ts` check this.
- Read the warden's leftover counts only from `$XDG_RUNTIME_DIR/agent-warden/status.json`, through `readLeftovers()` in `src/collect/warden-status.ts`, under the `status.json` rule in [warden.md](warden.md). No file is an absent warden with no source error; an unparsable file or an unknown schema major is a failed read. A status more than 90 s from the sample time is stale. Each count is null unless a fresh status carries it, including the null the warden writes without a test-world pattern. `src/collect/warden-status.test.ts` checks these states.
- Distinguish an absent feature or withheld process detail from a failed read. A missing build-cache binary has no source error; a failed or late query has an error and no reading. A kernel permission refusal for a process's cwd, executable or environment leaves the detail unknown without a source error; `src/collect/procs.details.test.ts` checks this boundary.
- Warn when a meter's required input is unread, including in the summary. A desktop slice missing from a complete cgroup walk is absent and its memory meter is `ok`; an incomplete walk cannot establish absence. `src/model/verdict.test.ts` checks this boundary.
- Keep a missing capability's cost visible and its cause in the drill-down. `capabilityOffer()` in `src/ui/settings.ts` offers text to copy, never a command to run automatically.
- A readable `io.stat` with no device line means zero bytes: the kernel creates that line on first I/O. A missing or unreadable file stays unknown. `src/collect/collector.test.ts` checks the exception.
- Take `CollectionConfig` from `src/collect/settings.ts` at collection entry points. Add collection settings to `collectionKeys`, whose type prevents undeclared reads. Keep display and notification settings out. `src/runtime.test.ts` checks collector retention.
- Hand a replacement collector the predecessor's build-cache reader, kernel-log cursor, service checkpoints and shared `FinishedScrubMemory`. Keep completed readings across settings changes. `src/runtime.test.ts` and `src/collect/collector.test.ts` check handover.
- Save only differences from layered defaults under [D006](../decisions/D006-settings-save-writes-only-changed-keys.md). Agent-tool edits go to the shared overlay under [lanes.md](lanes.md). A failed save leaves the active source and history usable; `src/runtime.test.ts` checks this.
- Ship systemd user-session defaults for host-specific settings and keep write mode off. `src/config/config.test.ts` checks both.
- Give every setting one `settingInfo` entry in `src/ui/settings.ts` and one group. `src/ui/settings.test.ts` and `src/ui/settings-screen.test.tsx` check coverage.
- Resolve XDG base directories through `xdgHome()` in `src/config/xdg.ts`. Keep the agent overlay at `~/.config/vsys/agent-tools.json` regardless of `XDG_CONFIG_HOME`, because the warden reads it there.
- Give a worker only a `WorkerSpec`. The host owns start, failure, replacement, cancellation and close. An ended thread's late events must not reach its replacement's request. `src/collect/worker-host.test.ts` checks this ownership.
- Add each worker to `entrypoints` in `scripts/build.ts` and `ARTIFACTS` in `scripts/ci.py`, and locate it through `workerFile()` in `src/collect/worker-file.ts`. Bun does not follow worker URLs when bundling. `scripts/ci_test.py` checks the artifacts; `bun run smoke` samples both shipped build forms.
- Bound background scratch traversal with work slices and rests through `restMs()` in `src/collect/scratch-scan.ts`. A caller awaiting a full reading gets the whole thread. `bun run bench:scratch`, in `scripts/ci.py`, measures the real rests that staged unit clocks cannot prove.
- Measure roots from `scratchDirs` and temporary directories running agents name through `scratchRoots()` in `src/collect/scratch.ts`. Never measure another user's root, such as shared `/tmp`, or fail an absent shipped default. `src/collect/scratch-scan.test.ts` checks root policy.
- Count compile and link slots through `compileOrLink()` in `src/collect/builds.ts` everywhere. `src/model/builds.test.ts` checks that lane totals equal the fleet total.
- Count a make token pool once at its outermost holder. Flags without a job count leave the total unknown. Never open its FIFO: reading takes a token from the build.
- Never import the UI into the collector, model or store. Review holds this rule. Never write kernel state from those layers or make collection depend on the store; SQLite belongs to the store.
- Never read process files on the program's drawing thread. A test collector may read on its caller's thread; `src/collect/process-thread.test.ts` checks reading equivalence. Process reads and scratch traversal must never share a thread.
- Never produce negative deltas from a backwards counter. Rebase a restarted cache; `src/collect/sccache.test.ts` checks this.

## The canonical example

Copy the build-cache split: `src/collect/sccache.ts` returns absence, an error or counts; `hitRate()` in `src/model/builds.ts` leaves an unused cache's rate unknown; `src/ui/builds-screen.tsx` formats it and explains the reading.

## Revisit when

A snapshot consumer needs a different null or prose contract, a second system-change owner is required, or the worker approach meets a revisit condition in [D008](../decisions/D008-process-reads-on-their-own-thread.md) or [D007](../decisions/D007-scratch-scan-duty.md). Overlay removals follow [D006](../decisions/D006-settings-save-writes-only-changed-keys.md).

## Not governed

Lane classification, cause policy and stored-record normalization belong to [lanes.md](lanes.md), [verdict.md](verdict.md) and [history.md](history.md).
