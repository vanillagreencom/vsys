# D001: Build the OSC 52 clipboard sequence in vsys

[← Decision Index](INDEX.md)

**Date**: 2026-09-09

**Status**: Active

**Research**: —

**Context**: The copy key has to put a command on the reader's system clipboard from inside a terminal, over SSH and inside tmux, where no clipboard program is reachable. OpenTUI's renderer already offers `copyToClipboardOSC52`.

**Decision**: `src/ui/clipboard.ts` builds the sequence and the shell writes it to an output stream the caller supplies: `process.stdout` when running, a stream the test reads back under test.

**Rationale**:

- The renderer's call reaches the terminal through its native core. The test renderer's write stream discards every chunk and exposes nothing, so a copy made that way has no assertion available at any surface.
- The sequence is one line whose whole content is the base64 of the text, so a second spelling costs nothing to keep correct and the encoding itself is what the test pins.
- The base64 payload is also the containment: a lane name or argv carrying the sequence's own terminator cannot close it and reach the terminal as instructions.

**Revisit When**: The renderer exposes the bytes it sent, or its test harness gives a readable output stream. Delegating then removes this file.

**Verification**: `src/ui/clipboard.test.ts` decodes the payload and plants terminators in the copied text; `src/ui/home.test.tsx` reads the sequence off the mounted shell's output stream.

**References**: [D002](D002-lane-action-mechanism.md)
