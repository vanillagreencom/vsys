# One detector, one ranking, one card per cause

Read before adding a cause, changing how causes rank, changing a meter, or changing the summary JSON.

## The approach

`causes()` in `src/model/verdict.ts` is the one detector. A cause is one detected problem held as data: its level, its subjects, its named consumer and its numbers, and every lane hitting one problem shares one cause. The ladder ranks causes worst first through `causeOrder`, its first verdict-worthy element is the verdict, and every element is one Home card. A housekeeping cause is a card but never the verdict. The meters read the same numbers, and `summarySnapshot()` in `src/model/export.ts` is the contract for `vsys --once --summary`. CPU percent is utilization in units of one logical core, and pressure is the recent share of time tasks stalled on a resource.

## Why

A second detector lets a tile and a card disagree about one machine. One ranking table covering every cause means a cause cannot be added without a rank, and nothing ranks a cause by its position in a ladder it may no longer appear in.

## Rules

- Do add a cause to `CauseId`, `causeOrder` and `causeEvidence` together. The two tables are records over `CauseId`, so the type check refuses a cause one of them lacks.
- Do say in `causeEvidence` whether a cause is a level, which must hold before it alerts, or an event, which alerts on the sample that shows it. The event log reads it ([history.md](history.md)).
- Do judge memory high once through `memoryHighJudgments()` in `src/model/verdict.ts`. The cause, event log and notifications use that judgment. A failed limit read keeps an active alert; a measured unlimited limit clears it. `src/model/alerts.test.ts` checks both alert consumers across failed reads and recovery.
- Do make a cause's `lanes`, `groups` and `paths` its subjects, each its own alert. `at` names where a card lands without making that row a subject.
- Do name a cgroup through `consumerName()`: the lane name where the group is a lane, otherwise the decoded unit name.
- Do read agent lanes through `agentLanes()` and the agents' total through `agentTotal()`. Where the probe found no agent slice the total sums the agent lanes and stays unknown while any of them is unreported.
- Do raise a card for every integrity state but `healthy` and `checking`, reading `integrities()` in `src/model/integrity.ts`, so Home never reads healthy while Storage reads otherwise. `src/model/verdict.test.ts` drives one snapshot per state.
- Do end every card with a next step, and never offer a command carrying an unresolved value. `src/ui/attention.test.ts` checks every cause.
- Never make a housekeeping cause the verdict, and never raise a card for a source read failure or for a recorded event alone. `src/model/verdict.test.ts` and `src/ui/attention.test.ts` check both.
- Never add a word to the summary. It holds ids and raw numbers, null means not measured, and a skipped scratch scan keeps its cause with a null level so it never reads as healthy. `src/main.test.ts` snapshots the schema, whose id is `summarySchema` in `src/model/export.ts`.

## The canonical example

The `free-space` cause in `causes()`: one threshold from the settings, one subject per filesystem below it, its rank and evidence kind from the two tables, and the Storage line reading the same figure. Copy it for a new cause.

## Revisit when

A consumer needs a summary field the model does not hold as a number, or a cause needs a rank that depends on another cause's presence.

## Not governed

How an alert opens and closes over time: [history.md](history.md). How a card is drawn: [ui.md](ui.md).
