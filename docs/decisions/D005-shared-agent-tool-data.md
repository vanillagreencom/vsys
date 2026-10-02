# D005: Use shared agent tool data

[← Decision Index](INDEX.md)

**Date**: 2026-09-28

**Status**: Active

**Research**: VSY-51

**Context**: The dashboard and the warden both classify agent tools. A copied list lets the two components disagree. A code import would couple TypeScript dashboard code to the Python warden, or make one component parse the other component's source.

**Decision**: Store shipped agent tool names, mise install directory names, desktop executable prefixes and bundled CLI suffixes in `data/agent-tools.json`. The dashboard reads that file for its default `agentTools`. It also reads the desktop executable prefixes and bundled CLI suffixes, with the machine overlay merged in, each time it builds a collector, to tell a desktop app's own binary from an agent. The warden reads the same file at start. Each machine can add local tool entries and desktop paths through `~/.config/vsys/agent-tools.json`.

The two desktop lists are the only desktop signals both components share. The warden's other desktop signals stay in its own code: `DESKTOP_COMMS`, the `/claude-desktop/` and `/Claude` executable substrings, `HELPER_NAMES` and `CHROMIUM_CHILD_FLAG`. The dashboard rules out Chromium helper processes through its `excludeArgv` setting instead. The two classifiers can disagree where only one of them holds a signal. D006 keeps Settings saves from pinning that layered list into `config.toml`.

**Rationale**:

- A JSON file is language neutral, so TypeScript and Python can read the same contract without a generated code step.
- A fail-closed parser refuses a malformed document, so neither component runs on a list it misread. It does not judge whether a valid list is complete or current.
- The overlay keeps local and owner-only tools out of the shipped default while preserving workstation behaviour.

**Revisit When**: Packaging generates per-component data from a richer schema, or the dashboard needs a desktop signal that only the warden's code holds.

**Verification**: `src/config/agent-tools.test.ts` checks the TypeScript parser and the inline-list guard. `src/collect/collector.test.ts` checks the dashboard's desktop-app rule, its bundled CLI exception and an overlay prefix reaching the process thread. `warden/agent_warden_test.py` checks the Python loader, installed lookup and owner overlay.

**References**: [D004](D004-warden-separate-component.md), [D006](D006-settings-save-writes-only-changed-keys.md)
