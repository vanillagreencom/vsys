# Settings and the runtime

Covers: src/config/ src/collect/settings.ts src/runtime.ts

Settings are validated before they reach a running dashboard. The runtime replaces the collector, the history store or neither, depending on which settings changed. A capability is a system interface a reading needs, probed once at start.

## Boundaries

- Every host-specific name the Overview needs is configuration: agent and desktop slices, excluded argv patterns, confinement cap markers, compiler and linker names, compiler cache names and the environment variables that carry the account, the pane address, the window title and the build token pool.
- The capability probe reads each interface once at start, with the kind of any failure. One result serves every snapshot, so an interface cannot change between ticks.
- vsys reads system state and never changes it. A remediation command is text to copy, and `writeMode` reserves a name nothing reads.

## Invariants

- A missing capability carries its source and a cause that follows what the probe met, so an unread quantity names it and an unreadable or unparsable source is never called a missing interface. `src/collect/capabilities.test.ts`, `src/ui/settings.test.ts` and `src/ui/overview.test.ts` check the kinds and the meters.
- Every host-specific name ships a systemd user-session default and `writeMode` ships off. `src/config/config.test.ts` checks these.
- The settings collection reads are declared in `src/collect/settings.ts`, and the runtime rebuilds the collector from that declaration alone. Every function collection reaches takes that subset of the settings rather than the whole configuration, so reading an undeclared setting fails the type check instead of leaving the collector stale. Display settings and notification rules stay out, because a rebuild discards the counters and alert state a sample compares against. `src/runtime.test.ts` checks that a collection setting rebuilds and that a display setting and a notification rule do not.
- Collection does not overlap itself when settings change. `src/runtime.test.ts` controls an in-flight source and checks rescheduling.
- Failed settings writes preserve active history. `src/runtime.test.ts` checks replacement failure.
- Saving settings through a file link preserves the link. `src/config/config.test.ts` checks the target contents.
