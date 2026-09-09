# Cause ladder and verdict

Covers: src/model/verdict.ts src/ui/overview.tsx

One detection produces one cause. The ladder ranks the causes by their impact on the person at the keyboard, its first verdict-worthy element speaks for the machine, and every element is one attention card.

## Boundaries

- A slice total sums its root groups. The cause ladder, the meters and the history point read the same function.

## Invariants

- Severity ranks the ladder, the cause order table breaks a tie, an unconfined agent leads it, and a housekeeping cause is a card but never the verdict. `src/model/verdict.test.ts` checks the ranking and `src/ui/overview.test.ts` checks a scratch overage on a healthy machine.
- A lane stalling on a resource a specific cause reports joins that card. `src/model/verdict.test.ts` checks storage stallers against a CPU one.
- A slice name appearing at two paths is summed once. `src/model/verdict.test.ts` checks a nested copy against root selection.
- A filesystem below the configured free-space floor is a cause of its own, and a parent slice never becomes the top writer or top swap holder. `src/model/verdict.test.ts` checks both against nested groups.
- One cause produces one attention card whatever the number of lanes, and every card ends with a next step distinct from its title and detail. `src/ui/overview.test.ts` checks nine stalling lanes and triggers every cause at once.
- Source read failures are counted once per source and stay out of attention. `src/ui/overview.test.ts` checks the footer.
