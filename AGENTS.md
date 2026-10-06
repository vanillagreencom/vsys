# vsys

A Linux terminal dashboard for agent processes and system health, in TypeScript on Bun with React and OpenTUI. It reads cgroup v2 and procfs and changes the system only through a lane action the reader confirms with write mode on. The optional warden under `warden/`, in Python, corrects agent process placement on its own.

## Commands

- `python3 scripts/ci.py`: the whole check contract, from the repository root; `CHECKS` in the script lists what it runs. Run it before claiming a change green.
- `bun test src/`: the application suites alone, from the repository root; a run started elsewhere fails and says so.
- `bun src/main.ts --once`: one JSON snapshot with no terminal, which is how a script sees real output.
- The repository pins its Bun in `.bun-version` and ships it as a dependency. Where the system Bun differs, prefix a command with `PATH="$PWD/node_modules/.bin:$PATH"`.

## Conventions

- A reading vsys could not take stays unknown. Never let a failed read become a zero, and never draw a zero for a number vsys could not read.
- `src/model/` returns numbers and identifiers. Every word and every formatted number is written in `src/ui/`. Five fields of the `--once` snapshot are the exception and stay where they are: `errors[].message`, `capabilities[].detail`, `storage.udisks.detail`, `storage.scratch[].error` and `alerts[].message`. Other programs read them from that JSON, and they move to `src/ui/` only by an owner decision.
- `tsconfig.json` sets `noUncheckedIndexedAccess`. Guard an indexed read or restructure it so the compiler sees it present; never assert it with `!` or a cast. A test reads an element it depends on through `present()` in `src/test/present.ts`.
- Collection reads only the settings in `collectionKeys` in `src/collect/settings.ts`. A new collection setting goes there, or the runtime will not rebuild the collector when it changes.
- Nothing is appended to a lane name to make it unique. The process id is a column of its own, and prose names a lane through `laneText()` in `src/model/naming.ts`.
- No screen names a colour value. Colour comes from the role table in `src/ui/theme.ts`; `src/ui/theme.test.tsx` admits no other colour.
- Only `runEffect()` in `src/effect.ts` changes system state for the dashboard, and only from a command `resolveIntent()` in `src/model/actions.ts` rebuilt against the current sample. The warden changes process placement outside the dashboard runtime.
- A change that makes a claim in a doc false changes the doc in the same commit. A claim that something is enforced names the test, or says that review holds it.
- `docs/media/vsys-tour.gif` is product content: the tour the README shows.

## Read when

- Before moving work between `src/collect/`, `src/model/`, `src/store/` and `src/ui/`, or adding a read the collector makes: `docs/architecture/layers.md`.
- Before adding a reading, a counter, a capability probe, a stored field or a screen that shows a number: `docs/architecture/unknown-readings.md`.
- Before drawing a screen, a row, a column, a colour, a card, or anything the reader can act on: `docs/architecture/ui.md`.
- Before adding or changing anything the dashboard does to a process, a cgroup or a unit: `docs/architecture/lane-actions.md`.
- Before changing how a lane is found, named, judged against the agent slice, traced to its launcher, or matched to its tmux pane: `docs/architecture/lanes.md`.
- Before changing which processes count as agent tools, the shared agent-tool data, or how the dashboard and the warden read it: `docs/architecture/agent-tools.md`.
- Before changing how compile and link work, the build cache or the make token pools are counted: `docs/architecture/builds.md`.
- Before changing how processes or scratch directories are read, adding a worker thread, or changing how a build ships one: `docs/architecture/collection-threads.md`.
- Before changing what the timeline records, when an alert opens or closes, or what a stored event holds: `docs/architecture/events.md`.
- Before changing replay, retention, persistence, the stored record shape or the history write path: `docs/architecture/history.md`.
- Before changing the scrub reporter, the drive reporter, the check report format, their installers, or the udisks2 fallback: `docs/architecture/reporters.md`.
- Before changing which directories Storage measures as scratch, how often, or how much processor time the traversal may hold: `docs/architecture/scratch.md`.
- Before adding a setting, changing what a settings save writes, or changing what a settings change rebuilds: `docs/architecture/settings.md`.
- Before changing whether a filesystem reads as damaged, checked or healthy, or how vsys reads the error counter, the kernel log and the check report: `docs/architecture/storage-integrity.md`.
- Before adding a cause, changing how causes rank, changing a meter, or changing the summary JSON: `docs/architecture/verdict.md`.
- Before changing what the optional warden under `warden/` moves, leaves alone, caps, reaps or reports: `docs/architecture/warden.md`.
- Before changing `vsys warden install`, `warden/install`, the unit templates, or what a package ships beside the binary: `docs/architecture/warden-install.md`.
- Before building, benchmarking or releasing: `DEVELOPMENT.md`.

## Code Review Rules

<!-- generated by bot-instructions 2.6.0 from kendex.toml, SKILL.md, schemas/renders.md, AGENTS.md. Edit [bot-instructions] in the effective manifest or the spec copy, then re-render. -->

If you are a review agent reviewing code, read .github/instructions/code-review.md before you comment.
