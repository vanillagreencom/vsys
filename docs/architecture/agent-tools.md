# A configured name is a candidate; an install location confirms it

Read before changing which processes count as agent tools, the shared agent-tool data, or how the dashboard and the warden read it.

## The approach

`data/agent-tools.json` holds the shipped tool names, each tool's install locations (`mise` directories, `paths` fragments and whole `executables` paths), the desktop executable prefixes and the bundled CLI suffixes. The dashboard and the warden both read it, with the machine overlay `~/.config/vsys/agent-tools.json` merged in. `toolName()` in `src/collect/builds.ts` is the one rule that makes a process an agent in the dashboard, and `Proc.is_agent` in `warden/agent-warden` is the warden's. Both treat a configured name as a candidate and confirm it by where the executable lies.

## Why

A name alone matches anyone's program: `pi` or `dsh` can be any script. An install location is a second signal a coincidence does not carry. One data file keeps the two components agreeing on which names exist, because a copied list drifts ([D005](../decisions/D005-shared-agent-tool-data.md)). [D010](../decisions/D010-agent-names-confirmed-by-install-location.md) records the confirmation rule.

## Rules

- Do add a shipped tool to `data/agent-tools.json` with at least one install location. `src/config/agent-tools.test.ts` fails a shipped tool with none, and fails a shipped name quoted in non-test `src/config/` source.
- Do add a machine-local tool, or another location for a shipped name, to the overlay; Settings writes it there. An overlay adds locations and never removes a shipped name.
- Do carry a rejected name on the process as `unconfirmedTool`, with the one path tested and which check tested it, so a missed install layout shows in the snapshot and on a Home card rather than vanishing.
- Do keep the name where a path could not be read. A failed read never hides an escaped agent.
- Do keep both parsers refusing the same malformed documents: `src/config/agent-tools.test.ts` and `warden/agent_warden_classify_test.py` both read `data/agent-tools-rejected.json`.
- Do confirm a match under a desktop prefix where the tool's own location or a bundled CLI suffix names it; a location a reader adds is never vetoed by the prefix.
- Never match on prompt arguments: `bash -c claude` is not claude. An excluded argv pattern matches an executable name or a whole flag.
- Never call a desktop app's own binary an agent. An executable under a desktop prefix is an agent only where a bundled CLI suffix or the tool's install location names it.
- Never let the warden move a process confirmed only by a `paths` fragment. A fragment is a substring any same-uid process can reproduce under a writable directory, so the warden confirms by mise directory, exact executable path, or a bundled CLI engine under a desktop prefix outside `/tmp`, while the dashboard's display match reads fragments too. `Proc.is_named_agent`, the name alone, decides whether a scope holds a live agent for reaping, so a paths-only install is still protected. `warden/agent_warden_classify_test.py` and `warden/agent_warden_orphan_test.py` hold both rules.

## The canonical example

The `codex` entry in `data/agent-tools.json`: a name, its `mise` directory and the `paths` fragments its package installs put it under. Copy its shape for a new tool, adding `executables` where a package installs into a shared directory such as `/usr/bin`.

## Revisit when

An agent ships an install layout no fragment, executable path or mise directory describes ([D010](../decisions/D010-agent-names-confirmed-by-install-location.md)), or packaging generates per-component data from a richer schema ([D005](../decisions/D005-shared-agent-tool-data.md)).

## Not governed

What the warden does with a confirmed agent: [warden.md](warden.md). The compiler, linker and cache names: [builds.md](builds.md).
