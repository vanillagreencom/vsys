# D005: Use shared agent tool data

[← Decision Index](INDEX.md)

**Date**: 2026-09-28

**Status**: Active

**Research**: VSY-51

**Context**: The dashboard and the warden both classify agent tools. A copied list lets the two components disagree. A code import would couple TypeScript dashboard code to the Python warden, or make one component parse the other component's source.

**Decision**: Store shipped agent tool names, mise install directory names, desktop executable prefixes and bundled CLI suffixes in `data/agent-tools.json`. The dashboard reads that file for its default `agentTools`. The warden reads the same file at start. Each machine can add local tool entries through `~/.config/vsys/agent-tools.json`.

**Rationale**:

- A JSON file is language neutral, so TypeScript and Python can read the same contract without a generated code step.
- A fail-closed parser refuses a malformed document, so neither component runs on a list it misread. It does not judge whether a valid list is complete or current.
- The overlay keeps local and owner-only tools out of the shipped default while preserving workstation behaviour.

**Revisit When**: Packaging generates per-component data from a richer schema, or the dashboard needs the warden-only path signals at runtime.

**Verification**: `src/config/agent-tools.test.ts` checks the TypeScript parser and the inline-list guard. `warden/agent_warden_test.py` checks the Python loader, installed lookup and owner overlay.

**References**: [D004](D004-warden-separate-component.md)
