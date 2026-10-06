# D010: Confirm agent names by install location

[← Decision Index](INDEX.md)

**Date**: 2026-10-01

**Status**: Active

**Research**: [VSY-41](https://linear.app/vanillagreen/issue/VSY-41)

**Decision**: A configured name is a candidate. A process is an agent where its executable, or the script an interpreter runs, lies in one of the tool's install locations or is a bundled CLI engine; a Node or Bun runtime retitled with the name also matches. A name with no install location matches by executable name alone. An unreadable path keeps the name, and a rejected name is recorded on the process as `unconfirmedTool`. The warden confirms more narrowly, never by a `paths` fragment.

**Why**: A name alone matched anyone's program or script, and each match outside the slice raised the escaped-agent card. An install location is a signal a coincidence does not carry. Settings edits names only, so a reader's own name stays their claim. Recording the rejection keeps a missed install layout visible instead of silent.

**Rejected**: The `AGENT_CONFINE=1` launcher marker as the signal. Every descendant of a confined launch inherits it, so it would vouch for any script an agent runs.

**Revisit when**: An agent CLI ships an install layout that no path fragment, executable path or mise directory can describe.
