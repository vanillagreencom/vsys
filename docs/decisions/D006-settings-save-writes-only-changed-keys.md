# D006: Settings save writes only changed keys

[← Decision Index](INDEX.md)

**Date**: 2026-09-29

**Status**: Active

**Research**: VSY-57

**Context**: The Settings screen used to save the resolved configuration. That copied derived defaults into `config.toml`. For `agentTools`, the copy froze the dashboard on one agent list while the warden kept reading the shipped data and the machine overlay.

**Decision**: Save only settings that differ from the layered defaults. Save Settings edits to `agentTools` in `~/.config/vsys/agent-tools.json`, not in `config.toml`. Keep a hand-written `config.toml` `agentTools` list only when it differs from both the shipped list and the layered list. Refuse a Settings edit to that list when the hand-written pin omits a shipped name.

**Rationale**:

- A Settings save should not turn a derived default into user intent.
- The overlay is the one machine-local file that both the dashboard and the warden read.
- The overlay can add tool names but cannot remove shipped names, so a hand-written list that removes a shipped name must stay a dashboard-only override.

**Revisit When**: The shared agent-tool schema can record removals.

**Verification**: `src/config/config.test.ts` checks changed-key saves, unpinned `agentTools` saves, pinned-list controls and migration. `src/runtime.test.ts` checks pinned and unpinned Settings writes preserve the overlay, unrelated saves keep a diverging pin, pinned shipped-name removals are refused and the warden loader matches.

**References**: [D005](D005-shared-agent-tool-data.md)
