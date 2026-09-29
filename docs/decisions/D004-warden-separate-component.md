# D004: Ship the warden as a separate vsys component

[← Decision Index](INDEX.md)

**Date**: 2026-09-28

**Status**: Active

**Research**: VGS agent-warden research report; vanillagreencom/vgs docs/plans/v2-platform-roadmap.md

**Context**: The owner workstation already runs an agent warden from dotfiles. The warden corrects process placement, applies limits and reaps abandoned agent scopes. A consumer cannot install it from dotfiles because the scripts and units carry owner-specific paths. The vsys dashboard has a read-only promise except for confirmed lane actions. Importing automatic correction into the dashboard runtime would break that promise.

**Decision**: vsys ships the warden from `warden/` as a separate optional component. The dashboard observes. The warden corrects. The warden stays Python because it uses pidfds and libsystemd directly. A Bun foreign-function interface port is a revisit condition, not this change.

**Rationale**:

- Option E from the research merges the warden into vsys. That gives one product, but it makes automatic correction part of the dashboard and weakens the read-only promise.
- Option F from the research keeps one repository and one documentation home while keeping the correction runtime outside the dashboard.
- The warden has a different failure domain from the terminal dashboard. It runs from a systemd user timer in `background.slice`, and it must keep working when the dashboard is closed.
- A separate component lets packaging install the scripts and user units without making every vsys user opt into automatic correction.
- The shared repository lets vsys, the warden and future packaging converge on one classification list without copying user instructions.

**Revisit When**: A Bun foreign-function interface port can call pidfd and libsystemd with the same safety properties, or the dashboard needs to own an automatic correction action with a new explicit promise.

**Verification**: `python3 scripts/ci.py` runs `python3 warden/agent-warden --selftest` and `python3 -m unittest discover -s warden -p '*_test.py'` before the Bun checks when `warden/` exists. `docs/architecture/warden.md` states the component boundary and names the tests for the warden rules.

**References**: [D002](D002-lane-action-mechanism.md), [D003](D003-action-resolved-at-the-keypress.md), [warden architecture](../architecture/warden.md)
