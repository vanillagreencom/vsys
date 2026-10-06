# D006: Settings save writes only changed keys

[← Decision Index](INDEX.md)

**Date**: 2026-09-29

**Status**: Active

**Research**: [VSY-57](https://linear.app/vanillagreen/issue/VSY-57)

**Decision**: A Settings save writes only the settings that differ from the layered defaults. A Settings edit to the agent tools goes to `~/.config/vsys/agent-tools.json`, never to `config.toml`, and is refused while a hand-written `agentTools` pin omits a shipped name.

**Why**: A save must not turn a derived default into user intent. The overlay is the one machine-local file both the dashboard and the warden read, and it can add names but not remove shipped ones, so a list that removes one stays a dashboard-only override.

**Rejected**: Saving the resolved configuration. It froze the dashboard on one agent list while the warden kept reading the shipped data and the overlay.

**Revisit when**: The shared agent-tool schema can record removals.
