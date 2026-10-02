# Agent recognition

Covers: src/collect/builds.ts src/config/agent-tools.ts src/config/agent-tools.test.ts data/agent-tools.json data/owner-agent-tools.json

The collector decides which processes are agent tools. Lanes, alerts and the escaped-agent decision in [lanes.md](lanes.md) read that one decision.

## Boundaries

- `data/agent-tools.json` owns shipped agent tool names and path signals. `src/config/agent-tools.ts` validates it and gives `src/config/config.ts` the default `agentTools` list. `installLocations()` there turns each tool's `paths` fragments and `mise` names into its install locations, a mise name as `/installs/<name>/` wherever the version manager keeps its data. `toolName()` and `desktopApp()` in `src/collect/builds.ts` read those signals. [D005](../decisions/D005-shared-agent-tool-data.md) records why the dashboard and the warden share this file. [D006](../decisions/D006-settings-save-writes-only-changed-keys.md) records why Settings saves do not pin the layered list.
- `toolName()` is the only rule that makes a process an agent. A configured name is a candidate, never a match: a process's own name or `argv[0]` must have its executable in one of that tool's install locations or a bundled CLI suffix, and a script an interpreter runs must lie in one of them, read as given or with its links resolved against the process's working directory. A tool with no install location is one a reader named in Settings or `config.toml` without saying where it lives, so its executable name alone matches and a script never does. An executable or script path that could not be read keeps the name, as an unreadable executable does for a desktop app.

## Invariants

1. An excluded argv pattern matches an executable name or a whole flag, never prompt text. A pattern ending in `=` matches that option with any value. `src/collect/collector.test.ts` checks a prompt naming a language server, `--type=` against five Chromium helper types, a plain pattern against a longer flag, and that exclusion hides a helper but never an agent lane.
2. The dashboard default agent tools come from `data/agent-tools.json`, not an inline list. `src/config/agent-tools.test.ts` reads the JSON file independently and fails if a shipped name appears as a quoted string in non-test `src/config/` sources.
3. A tool under a desktop prefix is an agent only where a bundled CLI suffix names it, even once deleted, and an unreadable executable keeps it one. `src/collect/collector.test.ts` checks Claude Desktop's processes, bundled engines live and deleted, an unreadable executable and an overlay prefix.
4. A shipped name matches only inside its tool's install locations, so `bash pi.sh` and an unrelated `dsh` are no lanes. `src/collect/collector.test.ts` tables each shipped CLI as a native binary, a Node package and a launcher link against scripts and programs that only share a name, and pins the owner's machine with `data/owner-agent-tools.json`. `src/config/agent-tools.test.ts` fails if a shipped tool names no install location.
