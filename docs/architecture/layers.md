# The sample flows one way

Read before moving work between `src/collect/`, `src/model/`, `src/store/` and `src/ui/`, or adding a read the collector makes.

## The approach

The collector reads the machine into a sample. The model derives lanes, causes and meters from it as numbers and identifiers. The store keeps it. The UI draws it and writes the words. Each layer reads only the one before it, and the dashboard changes the system from one place, `runEffect()` in `src/effect.ts` ([lane-actions.md](lane-actions.md)).

## Why

A word written in the model reaches the `--once` JSON that other programs parse, where it cannot be reworded without breaking a reader. A collector that imports the UI cannot be tested against a fixture. One direction keeps a screen change a UI change and a reading change a collector change.

## Rules

- Do take `CollectionConfig` from `src/collect/settings.ts` in every collection entry point. It picks the keys in `collectionKeys` from the settings type, so a collector reading an undeclared setting fails the type check.
- Do hand a collector its host readers from the program. `src/main.ts` and `src/runtime.ts` give `createCollector()` the tmux server, the agent slice's unit directories, the agent-tool overlay and the packaged reporter units; a collector given none reaches no host service, which is how the suites run against fixtures.
- Do return numbers and identifiers from `src/model/`, and write every word and every formatted number in `src/ui/`.
- Do keep the two exceptions where they are: the failure sentences the collectors write (`errors[].message`, `capabilities[].detail`, `storage.udisks.detail`, `storage.scratch[].error`) and the alert sentence the model writes (`alerts[].message`). Other programs read them from the `--once` snapshot, and they move to `src/ui/` only by an owner decision.
- Never import `src/ui/` from `src/collect/`, `src/model/` or `src/store/`. Review holds this; no check refuses the import.
- Never write kernel state from the collector, the model or the store.
- Never make collection depend on the store; SQLite is the store's alone.

## The canonical example

`src/model/builds.ts` and `src/ui/builds-screen.tsx`: the model returns slot counts per lane and machine wide and names nothing; the screen formats each count and writes every heading. Copy the split.

## Revisit when

A consumer of the snapshot needs prose the model does not write, or a layer needs a second owner of system change.

## Not governed

What each layer computes. The docs listed in `AGENTS.md` own their subjects.
