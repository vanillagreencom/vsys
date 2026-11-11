# Cause judgments

Read before adding a cause, changing its rank, changing a meter or changing summary JSON.

## The approach

`causes()` in `src/model/verdict.ts` detects each problem once. Severity and `causeOrder` rank it. One cause supplies one Home card, and the first verdict-worthy cause supplies the verdict. Meters consume the same readings. `summarySnapshot()` in `src/ui/export.ts` supplies `vsys --once --summary`.

## Why

Separate detectors or rankings let a meter, card and alert disagree about the same machine. Shared judgments keep unknown readings distinct from clear ones.

## Rules

Review holds boundaries without a named check.

- Add a cause to `CauseId`, `causeOrder` and `causeEvidence` together. The type check holds both tables to the cause union.
- Classify evidence as a sustained level or a one-sample event in `causeEvidence`. The [event store](history.md) uses that classification for holds.
- Judge memory-high through `memoryHighJudgments()` for causes, events and notifications, and through its per-group `memoryHighJudgment()` for the Resources row, which shows the working memory it judged. It judges working memory against 90% of `memory.high`: the figure the warden judges by, as [warden.md](warden.md) defines it. An unread `memory.stat` leaves the group unjudged. The judgment leaves out a lane scope exactly when a fresh warden status warns for it, an item keyed `near-limit:SCOPE` while that lane's `near` lists `memory`, so one agent near its limit raises one warning. vsys copies none of the warden's conditions for when it warns, and judges every other group itself, the agent slice included in every warden state. An unread limit keeps an alert active; measured unlimited clears it. `src/model/alerts.test.ts` and `src/model/verdict.test.ts` check the shared judgment.
- Put affected subjects in `lanes`, `groups` and `paths`, one alert per subject. Use `at` only for the card's destination; it must not create an alert.
- Give a cause or meter its cgroup consumer through `consumerOf()`: the lane when one exists, which each reader writes in its own form, and a decoded unit otherwise.
- Judge service CPU only for `.service` units directly under `system.slice` or one slice below it. Scopes and mounts are unsafe targets for the suggested restart. Respect the hour checkpoint window in `src/collect/services.ts`; no qualifying checkpoint means no hour average or cause, and an unread unit is unjudged. The average so far and its span are display readings only, null in older snapshots, and never raise a cause or alert. Carry checkpoints across collector replacement. `src/collect/services.test.ts` checks this boundary.
- Read agent lanes through `agentLanes()` and totals through `agentTotal()`. Without an agent slice, count each measured subtree once, then uncovered process sums. Uncovered unknowns or incomplete process reads keep the total unknown. `src/model/verdict.test.ts` checks totals.
- Raise integrity cards from `integrities()` in `src/model/integrity.ts` for every state except `healthy` and `checking`. Home and Storage must use one judgment; `src/model/verdict.test.ts` checks it.
- End every card with a next step. Offer no command with an unresolved value. `src/ui/attention.test.ts` checks card actions.
- Never make housekeeping the verdict or raise a card solely for a source-read failure or stored event. `src/model/verdict.test.ts` and `src/ui/attention.test.ts` check these exclusions.
- Keep cause and meter values in the summary as ids and raw numbers under `summarySchema` in `src/ui/export.ts`, `vsys.summary.v2`. A cause's `title` is the one exception. Null means not measured. A skipped scratch scan and unavailable service average retain their cause with a null level, never healthy. `src/main.test.ts` checks the summary contract.
- Give each `warn` or `danger` summary entry `title`, `processes` and `open`. `title` is the Home card's title from `attention()`, never a second copy, so the bar widget's flyout and vsys say the same words. The summary passes `attention()` a `laneName` that writes each lane the cause names, in its `lanes`, as its `consumer` or as one of its `groups`, by its name alone, because the flyout draws no process id; the Home card writes the lane through `laneText()`. `processes` lists `{pid, name}` for each process in the cause's `procs`, then the main process of each lane the cause names, skipping a lane that leads none. `open` holds vsys arguments that open vsys at the cause, and stays empty until such an argument exists. The owner's delegate decided that the summary carries the card title (Jarvis decision 1793915537-2115019-27970). `src/ui/export.test.ts` checks every cause.
- Keep CPU utilization in percent of one logical core and pressure in the recent share of time tasks stalled. They measure different quantities.

## The canonical example

Copy `free-space` in `causes()`: one configured threshold, one subject per affected filesystem and the shared rank and evidence tables. Card totals describe their named consumer; each alert retains its own subject's numbers.

## Revisit when

A summary consumer needs words other than a card's title, or a cause's rank must depend on another cause's presence.

## Not governed

Alert holds: [history.md](history.md). Card drawing: [ui.md](ui.md).
