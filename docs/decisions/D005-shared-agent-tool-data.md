# D005: Use shared agent tool data

[← Decision Index](INDEX.md)

**Date**: 2026-09-28

**Status**: Active

**Research**: [VSY-51](https://linear.app/vanillagreen/issue/VSY-51)

**Decision**: The shipped agent tool names, their install locations, the desktop executable prefixes and the bundled CLI suffixes live in `data/agent-tools.json`. The dashboard and the warden both read it, each merging the machine overlay `~/.config/vsys/agent-tools.json`, and both refuse the same malformed documents.

**Why**: A copied list lets the two components disagree about which names are agents. A JSON file is language neutral, so TypeScript and Python read one contract with no generated step, and a fail-closed parser means neither runs on a list it misread.

**Rejected**: A list in each component, which drifts; and a code import, which couples the dashboard to the warden's source or makes one parse the other.

**Revisit when**: Packaging generates per-component data from a richer schema, or the dashboard needs a desktop signal only the warden's code holds.
