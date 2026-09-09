# Settings and the runtime

Covers: src/config/ src/collect/settings.ts src/runtime.ts

Settings are validated before they reach a running dashboard. The runtime replaces the collector, the history store or neither, depending on which settings changed.

## Boundaries

- Every host-specific name the Overview needs is configuration: agent and desktop slices, excluded argv patterns, confinement cap markers, linker names, compiler cache names and the environment variables that carry the account, the pane address and the window title.

## Invariants

- The settings collection reads are declared in `src/collect/settings.ts`, and the runtime rebuilds the collector from that declaration alone. Every function collection reaches takes that subset of the settings rather than the whole configuration, so reading an undeclared setting fails the type check instead of leaving the collector stale. Display settings and notification rules stay out, because a rebuild discards the counters and alert state a sample compares against. `src/runtime.test.ts` checks that a collection setting rebuilds and that a display setting and a notification rule do not.
- Collection does not overlap itself when settings change. `src/runtime.test.ts` controls an in-flight source and checks rescheduling.
- Failed settings writes preserve active history. `src/runtime.test.ts` checks replacement failure.
- Saving settings through a file link preserves the link. `src/config/config.test.ts` checks the target contents.
