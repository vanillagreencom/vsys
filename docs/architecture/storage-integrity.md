# A filesystem is healthy only when a finished check says so

Read before changing whether a filesystem reads as damaged, checked or healthy, or how vsys reads the error counter, the kernel log and the check report.

## The approach

Storage answers two questions per filesystem: is its data damaged, and when was it last read end to end. Three sources answer. A check report says what a completed Btrfs scrub found. The error counter and the kernel log each record a failed checksum read when one happens. `integrity()` in `src/model/integrity.ts` is the one reading; the filesystem, not the mount and not the device, is its unit through `volumesByDevice`; and the cause ladder, the Storage row and the drill-down all read it. The collector remembers the last finished check in `FinishedScrubMemory` in `src/collect/btrfs.ts` across a later report that did not finish.

## Why

The error counter counts reads that failed. It stays still while nothing reads the damaged part, so a flat counter is not a sound filesystem; only a finished check read the whole filesystem. The reporter keeps one report per filesystem, so a scrub that stops early overwrites the report that proved it sound, and without the memory that filesystem would fall back to unknown.

## Rules

- Do read as untroubled only `healthy` and `checking`. A filesystem never checked, whose report could not be read, or whose counter is unreadable is never `healthy`. `src/model/integrity.test.ts` pins one row per state.
- Do let each source answer alone. With the kernel log only, a logged failure still dates the last new error and names its inode; with neither source, the filesystem was never checked. The Storage row names the source of each time.
- Do cover counter growth by a finished check only where the growth's bound came no later than the check's end and the growth is no larger than the errors it counted. `scrubCoverage()` in `src/collect/btrfs.ts` is the one rule, and later growth stays `new-errors`.
- Do keep the time of the last counter growth in `errorMemoryPath`, outside the process, and treat a counter at zero after a reboot as a new baseline, never a repair.
- Do judge a remembered finished check as the live one is judged, through `scrubFoundDamage()`. A remembered check that found damage reads `damaged` whatever the current report says.
- Do hand a replaced collector the same `FinishedScrubMemory` instance ([settings.md](settings.md)), so a scrub that finishes during the handover lands in the one memory. `src/collect/collector.test.ts` checks it.
- Do search the kernel log through `journalctl --output=json --grep` from the cursor the last search ended on, record a failed search as a source error, and keep the failures earlier searches read. `src/collect/kernel-log.test.ts` checks a failure after a success.
- Do list every file a report names as possibly damaged, with every name its address carries, and count blocks the check counted beyond the listed addresses as unnamed damage.
- Never offer a command that removes a listed file. `src/ui/storage-screen.test.tsx` copies nothing from a damaged filesystem, and `src/ui/attention.test.ts` checks the damage card.
- Never read a report that cannot be read as an absent report, and never read a hidden file in the report directory as a report. `src/collect/btrfs.test.ts` checks both.
- Never read an unread report or counter as healthy. The `scrub` and `integrity-unknown` causes raise on them.

## The canonical example

`integrity()` in `src/model/integrity.ts`: one function taking the report, the counter memory, the logged failures and the remembered check, and returning the state with its two dated times and their sources. Copy it: every reader calls it rather than judging a source itself.

## Revisit when

Btrfs exposes a per-file damage record vsys can read without a scrub, or a source other than a report can prove a filesystem was read end to end.

## Not governed

How the report is written and installed: [reporters.md](reporters.md). How the Storage row draws its words: [ui.md](ui.md).
