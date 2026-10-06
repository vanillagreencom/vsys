# D001: Build the OSC 52 clipboard sequence in vsys

[← Decision Index](INDEX.md)

**Date**: 2026-09-09

**Status**: Active

**Research**: —

**Decision**: `src/ui/clipboard.ts` builds the OSC 52 sequence, and the shell writes it to an output stream the caller supplies: the process's standard output when running, a stream the test reads back under test.

**Why**: OpenTUI's own clipboard call writes through its native core, and its test renderer discards every byte, so a copy made that way can be asserted nowhere. The base64 payload also contains a lane name or argv that carries the sequence's own terminator, so text in a command cannot close the sequence.

**Rejected**: The renderer's clipboard call. One function fewer, and no test can read what it sent.

**Revisit when**: The renderer exposes the bytes it sent, or its test harness gives a readable output stream.
