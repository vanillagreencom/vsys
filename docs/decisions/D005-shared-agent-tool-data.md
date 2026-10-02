# D005: Use shared agent tool data

[← Decision Index](INDEX.md)

**Date**: 2026-09-28

**Status**: Active

**Research**: VSY-51

**Context**: The dashboard and the warden both classify agent tools. A copied list lets the two components disagree. A code import would couple TypeScript dashboard code to the Python warden, or make one component parse the other component's source.

**Decision**: Store shipped agent tool names, mise install directory names, each tool's install `paths` fragments and whole `executables` paths, desktop executable prefixes and bundled CLI suffixes in `data/agent-tools.json`. The dashboard reads that file for its default `agentTools`. It also reads the whole document, with the machine overlay merged in, each time it builds a collector: the install locations confirm an agent's name ([D010](D010-agent-names-confirmed-by-install-location.md)), and the desktop lists tell a desktop app's own binary from an agent. The warden reads the same file at start. Each machine can add local tool entries and desktop paths through `~/.config/vsys/agent-tools.json`.

The warden validates the install `paths` but never reads them for classification, because a bare substring of one is forgeable by any same-uid process; it confirms a configured name only by mise install directory, an exact configured `executables` path, or a bundled CLI engine under a desktop prefix, excluding one under `/tmp` ([D010](D010-agent-names-confirmed-by-install-location.md)). The two disagree on a configured name confirmed only by a `paths` fragment, including a tool whose entry names only `paths`: the dashboard shows a package-only install as an agent through its `paths` match, but the warden moves it as an unconfined agent only as a bundled CLI engine or when its executable cannot be read. Otherwise the warden moves it only as part of an escaped launch: an `AGENT_CONFINE=1` launch outside the slice moves whatever its name, unless the nearest marker above it is a desktop app or an excluded helper, where only a confirmed agent moves. `--status` lists it while such a launch is pending, and as `unit` when it runs marked in a contained job unit under the same desktop rule. It still counts as a live agent for orphan reaping ([D010](D010-agent-names-confirmed-by-install-location.md)).

The two desktop lists are the only desktop signals both components share. The warden's other desktop signals stay in its own code: `DESKTOP_COMMS`, the `/claude-desktop/` and `/Claude` executable substrings, `HELPER_NAMES` and `CHROMIUM_CHILD_FLAG`. The dashboard rules out Chromium helper processes through its `excludeArgv` setting instead. The two classifiers can disagree where only one of them holds a signal. D006 keeps Settings saves from pinning that layered list into `config.toml`.

**Rationale**:

- A JSON file is language neutral, so TypeScript and Python can read the same contract without a generated code step.
- A fail-closed parser refuses a malformed document, so neither component runs on a list it misread. It does not judge whether a valid list is complete or current.
- The overlay keeps local and owner-only tools out of the shipped default while preserving workstation behaviour.

**Revisit When**: Packaging generates per-component data from a richer schema, or the dashboard needs a desktop signal that only the warden's code holds.

**Verification**: `src/config/agent-tools.test.ts` checks the TypeScript parser, the overlay merge and the inline-list guard. `src/collect/collector.test.ts` checks the dashboard's desktop-app rule, its bundled CLI exception, an overlay prefix and install location reaching the process thread, and the install-shape tables of D010. `warden/agent_warden_test.py` checks the Python loader, installed lookup and owner overlay; its `test_escaped_launch_moves_an_unconfirmed_name` checks that an escaped launch of a name the warden cannot confirm still moves, that one under a desktop app stays, and that one in a contained job unit is listed as that unit's. Both parsers refuse the documents in `data/agent-tools-rejected.json`.

**References**: [D004](D004-warden-separate-component.md), [D006](D006-settings-save-writes-only-changed-keys.md), [D010](D010-agent-names-confirmed-by-install-location.md)
