# D010: Confirm agent names by install location

[← Decision Index](INDEX.md)

**Date**: 2026-10-01

**Status**: Active

**Research**: VSY-41

**Context**: The dashboard called a process an agent when its `comm`, its executable's basename or an interpreter's script basename equalled a configured name. Generic names such as `pi` and machine-local names such as `dsh` then matched anyone's program or script. Outside the agent slice, each match raised the escaped-agent card.

**Decision**: A configured name is a candidate. Each tool entry in the agent-tool data lists where its installs put it: `paths` fragments, whole `executables` paths, and its `mise` install directories. An executable name matches only where the process's executable lies in one of its tool's install locations or is a bundled CLI engine. A script basename matches only where the script, with its links resolved, lies in one. An install-location match holds even under a desktop prefix, so a location a reader adds is never vetoed. A Node or Bun process whose program replaced its title with the tool's name also matches, because the title change erases the script path. An entry with no install location matches by executable name alone, and never by script. Every shipped entry names an install location, and an overlay entry with a shipped name adds locations to that tool. A path vsys could not read keeps the name. A configured name the locations reject is recorded on the process as `unconfirmedTool`.

**Rationale**:

- An install location is a second signal that a coincidental name does not carry: an unrelated `/usr/bin/dsh` or `~/bin/pi.sh` lies in no agent's package or version directory.
- Settings edits names only. Requiring a location for a reader's own name would make every Settings addition do nothing, so a name with no location stays the reader's claim.
- The `AGENT_CONFINE=1` launcher marker was rejected as a signal. Every descendant of a confined launch inherits it, so it would vouch for any `dsh` or `pi.sh` an agent runs.
- Recording the rejected name keeps a missed install layout visible in the snapshot instead of silent.

**Revisit When**: An agent CLI ships an install layout that no path fragment or executable path can describe, or the warden adopts install locations for its own classification.

**Verification**: `src/collect/collector.test.ts` tables each shipped CLI's install shapes, scripts and programs that only share a name, unreadable paths, an overlay that extends a shipped tool, and the owner's machine. `src/config/agent-tools.test.ts` fails if a shipped tool names no install location.

**References**: [D005](D005-shared-agent-tool-data.md), [D006](D006-settings-save-writes-only-changed-keys.md)
