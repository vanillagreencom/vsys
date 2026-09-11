# Cause ladder and verdict

Covers: src/model/verdict.ts

One detection produces one cause. The ladder ranks the causes worst first, its first verdict-worthy element speaks for the machine, and every element is one attention card. The meters read the same numbers, so a tile and a card cannot disagree.

## Boundaries

- `causes()` is the one detector. Nothing else decides that something is wrong, so an alert is a cause opening rather than a second detection.
- `causeRank()` reads a fixed table covering every cause, so a new cause cannot be added without a rank, and nothing ranks a cause by its position in a ladder it may no longer appear in.
- A cause's `lanes`, `groups` and `paths` are its subjects, and each becomes its own alert. `at` names where a card should land without claiming that row went wrong, so a cause pointing at a scope does not open an alert for it.
- `consumerName()` is the one place a cgroup becomes a name a reader reads: the lane name where the group is a lane, otherwise the decoded unit name.
- `sliceSum()` totals a slice from its root groups, and the ladder, the meters and the history point all read it.

## Invariants

1. Severity ranks the ladder and the cause order table breaks a tie, with an unconfined agent leading it. `src/model/verdict.test.ts` checks the ranking and the tie order.
2. A housekeeping cause is a card but never the verdict. `src/model/verdict.test.ts` checks that housekeeping never leads the ladder.
3. A healthy machine produces no causes at all. `src/model/verdict.test.ts` checks it.
4. A lane stalling on a resource that a specific cause already reports joins that card, so one contention never produces two cards. `src/model/verdict.test.ts` checks storage stallers against a CPU one.
5. A slice name appearing at two paths is summed once, and a slice total is unknown unless every root reported the counter. `src/model/verdict.test.ts` checks a nested copy against root selection.
6. A filesystem below the configured free-space floor is a cause of its own, and a parent slice never becomes the top writer or the top swap holder. `src/model/verdict.test.ts` checks both against nested groups.
7. A quantity a meter's level depends on that could not be read is a warning, never an untroubled reading. `src/model/verdict.test.ts` checks the four meters and their consumers.
8. Build load counts the configured linkers separately, machine wide and per lane. `src/model/verdict.test.ts` checks both.
9. One cause produces one attention card whatever the number of lanes, and every card ends with a next step of its own. `src/ui/attention.test.ts` checks nine stalling lanes and every card kind.
10. Source read failures are not a machine problem and raise no card. `src/ui/attention.test.ts` checks them.
11. A recorded event alone does not become a current concern. `src/ui/attention.test.ts` checks resolved events and missing source data.
