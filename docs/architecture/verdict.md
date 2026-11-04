# Cause judgments

Read before adding a cause, changing its rank, changing a meter or changing summary JSON.

## The approach

`causes()` in `src/model/verdict.ts` detects each problem once. Severity and `causeOrder` rank it. One cause supplies one Home card, and the first verdict-worthy cause supplies the verdict. Meters consume the same readings. `summarySnapshot()` in `src/model/export.ts` supplies `vsys --once --summary`.

## Why

Separate detectors or rankings let a meter, card and alert disagree about the same machine. Shared judgments keep unknown readings distinct from clear ones.

## Rules

Review holds boundaries without a named check.

- Add a cause to `CauseId`, `causeOrder` and `causeEvidence` together. The type check holds both tables to the cause union.
- Classify evidence as a sustained level or a one-sample event in `causeEvidence`. The [event store](history.md) uses that classification for holds.
- Judge memory-high through `memoryHighJudgments()` for causes, events and notifications. An unread limit keeps an alert active; measured unlimited clears it. `src/model/alerts.test.ts` checks the shared judgment.
- Put affected subjects in `lanes`, `groups` and `paths`, one alert per subject. Use `at` only for the card's destination; it must not create an alert.
- Name cgroup consumers through `consumerName()`, using a lane name when one exists and a decoded unit otherwise.
- Judge service CPU only for `.service` units directly under `system.slice` or one slice below it. Scopes and mounts are unsafe targets for the suggested restart. Respect the checkpoint window in `src/collect/services.ts`; no qualifying checkpoint means no average or cause, and an unread unit is unjudged. Carry checkpoints across collector replacement. `src/collect/services.test.ts` checks this boundary.
- Read agent lanes through `agentLanes()` and totals through `agentTotal()`. Without an agent slice, count each measured subtree once, then uncovered process sums. Uncovered unknowns or incomplete process reads keep the total unknown. `src/model/verdict.test.ts` checks totals.
- Raise integrity cards from `integrities()` in `src/model/integrity.ts` for every state except `healthy` and `checking`. Home and Storage must use one judgment; `src/model/verdict.test.ts` checks it.
- End every card with a next step. Offer no command with an unresolved value. `src/ui/attention.test.ts` checks card actions.
- Never make housekeeping the verdict or raise a card solely for a source-read failure or stored event. `src/model/verdict.test.ts` and `src/ui/attention.test.ts` check these exclusions.
- Keep cause and meter values in the summary as ids and raw numbers under `summarySchema` in `src/model/export.ts`. Null means not measured. A skipped scratch scan and unavailable service average retain their cause with a null level, never healthy. `src/main.test.ts` checks the summary contract.
- Keep CPU utilization in percent of one logical core and pressure in the recent share of time tasks stalled. They measure different quantities.

## The canonical example

Copy `free-space` in `causes()`: one configured threshold, one subject per affected filesystem and the shared rank and evidence tables. Card totals describe their named consumer; each alert retains its own subject's numbers.

## Revisit when

A consumer needs prose in the summary, or a cause's rank must depend on another cause's presence.

## Not governed

Alert holds: [history.md](history.md). Card drawing: [ui.md](ui.md).
