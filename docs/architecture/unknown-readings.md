# A reading vsys could not take stays unknown

Read before adding a reading, a counter, a capability probe, a stored field or a screen that shows a number.

## The approach

A sample holds the observed values beside the source errors met while reading them, and the two never collapse into each other. A counter the kernel did not report, a file this user may not read and a parse that failed each stay null. Every screen, meter, alert and stored record reads that one sample, so a number vsys could not read is drawn blank.

## Why

A dashboard that shows zero for a number it could not read is lying: a zero reads as an untroubled machine. A blank, with the cause in the drill-down, tells the reader what the dashboard does not know, and a meter graded as a warning tells them to look.

## Rules

- Do record a failed read as a source error against the source that failed, through `Reader` in `src/collect/io.ts`, and leave the value null. `src/collect/collector.test.ts` plants an invalid counter and requires a source error and no number.
- Do grade a meter whose input is null as a warning, never as untroubled, and keep that level in the summary while the reading stays null. `src/model/verdict.test.ts` checks the four meters.
- Do fill a field a stored record predates with the unknown value, in `src/store/migrate.ts`, never with zero. `src/store/history.test.ts` reads records older than each field.
- Do judge a subject whose own input could not be read as unread, not as absent: `unjudged()` in `src/model/verdict.ts` names those subjects, and an open alert on one of them stays open.
- Do keep a missing capability's cost on the screen and its own words in the drill-down: the readings it feeds are blank, and the diagnosis stays with the source.
- Do keep a read that fails on one process from dropping the sample: the process is left out and `omittedProcess()` in `src/collect/procs.ts` lets a total that process would have changed stay unknown.
- Never let a failed read become a zero, and never draw a zero for a number vsys could not read.
- The one exception is a readable `io.stat` with no line for a device: that is zero bytes, because the kernel adds the line on the group's first I/O. A missing or unreadable `io.stat` stays unknown. `src/collect/collector.test.ts` checks an empty file against a removed one.

## The canonical example

`src/collect/sccache.ts`: a missing cache binary is an absent feature with no error, a failed or late query is a source error with a null reading, and a cache that served nothing has no hit rate rather than a zero. Copy its three outcomes.

## Revisit when

A consumer of the `--once` snapshot needs a zero in place of null. That is a change to the snapshot contract, not to a reading.

## Not governed

Which readings exist and what thresholds grade them: the cause table in `src/model/verdict.ts` and the settings, under [verdict.md](verdict.md).
