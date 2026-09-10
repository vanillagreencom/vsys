# Settings and the runtime

Covers: src/config/ src/collect/settings.ts src/runtime.ts

Settings are validated before they reach a running dashboard. The runtime replaces the collector, the history store or neither, depending on which settings changed. A capability is a system interface a reading needs, probed once at start.

## Boundaries

- Every host-specific name Home needs is configuration: agent and desktop slices, excluded argv patterns, confinement cap markers, compiler and linker names, compiler cache names and the environment variables that carry the account, the pane address, the window title and the build token pool.
- `settingInfo` in `src/ui/settings.ts` holds one entry per setting: the label that fits the list column, the sentence the drill-down shows under the selected row, and the unit its stored number is written in. Every stored number has a unit, because the labels no longer have room to carry one. The list shows the value in that unit; the editor still opens the stored value.
- The capability probe reads each interface once at start, with the kind of any failure. One result serves every snapshot, so an interface cannot change between ticks.
- vsys reads system state unless `writeMode` is on. A remediation command is text to copy; `writeMode` additionally lets a confirmed Freeze, Thaw or Stop reach the lane's scope.

## Invariants

- A missing capability carries its source and a cause that follows what the probe met, so an unread quantity names it and an unreadable or unparsable source is never called a missing interface. `src/collect/capabilities.test.ts`, `src/ui/settings.test.ts` and `src/ui/attention.test.ts` check the kinds and the meters.
- Every host-specific name ships a systemd user-session default and `writeMode` ships off. `src/config/config.test.ts` checks these.
- `writeMode` off refuses every lane action, and on holds each behind a confirmation naming the scope. A pinned sample refuses one whatever `writeMode` says, because its scope name may belong to another lane by now, and so does a confirmed line the current sample no longer names. `src/ui/App.test.tsx` checks all four.
- Every stored setting has a label, a sentence and, where it stores a number, a unit; no label is wider than its column. `src/ui/settings.test.ts` derives the expected set from the defaults.
- The Settings filter matches the stored name and the label the reader sees, so either spelling finds a row. `src/ui/App.test.tsx` checks a query that only the labels carry.
- The settings collection reads are declared in `src/collect/settings.ts`, and the runtime rebuilds the collector from that declaration alone. Every function collection reaches takes that subset of the settings rather than the whole configuration, so reading an undeclared setting fails the type check instead of leaving the collector stale. Display settings and notification rules stay out, because a rebuild discards the counters and alert state a sample compares against. `src/runtime.test.ts` checks that a collection setting rebuilds and that a display setting and a notification rule do not.
- Collection does not overlap itself when settings change. `src/runtime.test.ts` controls an in-flight source and checks rescheduling.
- Failed settings writes preserve active history. `src/runtime.test.ts` checks replacement failure.
- Saving settings through a file link preserves the link. `src/config/config.test.ts` checks the target contents.
