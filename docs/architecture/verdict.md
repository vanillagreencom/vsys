# Cause ladder and verdict

Covers: src/model/verdict.ts src/model/verdict.test.ts src/model/export.ts src/collect/system.ts src/collect/capabilities.ts src/collect/capabilities.test.ts

One detection produces one cause. The ladder ranks the causes worst first, its first verdict-worthy element speaks for the machine, and every element is one attention card. The meters read the same numbers, so a tile and a card cannot disagree.

## Boundaries

- `causes()` is the one detector. Nothing else decides that something is wrong, so an alert is a cause opening rather than a second detection.
- `causeRank()` reads a fixed table covering every cause, so a new cause cannot be added without a rank, and nothing ranks a cause by its position in a ladder it may no longer appear in.
- `causeEvidence` is a fixed table covering every cause that says whether its evidence is a level, which must hold before it alerts, or an event, such as a device error counter delta, which alerts on the sample that shows it. The Timeline reads it.
- A cause's `lanes`, `groups` and `paths` are its subjects, and each becomes its own alert. `at` names where a card should land without claiming that row went wrong, so a cause pointing at a scope does not open an alert for it. `procs` carries raw processes a cause is about that named no lane and no group, because becoming one is exactly what the cause says did not happen; `subjects()` in `src/store/events.ts` does not read it. The unconfirmed-tool cause never sets `lanes`, `groups` or `paths` at all, which no other cause goes without, so it is the first to fall through to `subjects()`'s single-subject fallback on every sample rather than only when a per-sample list happens to come up empty: its alert identity is one constant key shared by every unconfirmed process, named by `consumer` alone, so a second unconfirmed process arriving while that one alert is already open keeps the first process's name until the alert closes.
- `consumerName()` is the one place a cgroup becomes a name a reader reads: the lane name where the group is a lane, otherwise the decoded unit name.
- `sliceSum()` totals a slice from its root groups, and the ladder, the meters and the history point all read it.
- `sliceInstancePaths()` in `src/collect/capabilities.ts` names every real instance of the agent slice a sample's groups reveal, by scanning each group's own `path` for a component naming the slice, even a nested instance or one `collectGroups` could not itself read, counted when a descendant's `path` reveals it. It never drops a nested instance the way `sliceRoots()` drops one for its resource-total callers, because `probeIoStat()` in `src/collect/capabilities.ts` must check each instance's own `cgroup.subtree_control` rather than sum it. A cgroup root spanning more than one systemd user manager, or one manager nested below another, likewise gives each its own agent slice, each walked on its own. [settings.md](settings.md) owns how a withholding ancestor becomes a diagnosis and `belowSlice`.
- `agentLanes()` is the one definition of an agent lane, a lane running a configured tool. `agentTotal()` and the desktop-swap card in `src/ui/attention.ts` both read it, so a change to what counts as an agent cannot leave the card naming lanes the total left out, or the reverse.
- `agentTotal()` is the agents' CPU and page cache. Where the agent slice is compared, it is the slice total. Where the probe found no slice, it sums the agent lanes' own figures, unknown unless every agent lane reported, and unknown when the sample left out a process it could not read, since that process may have been an agent. `omittedProcess()` in `src/collect/procs.ts` says which source errors left a process out.
- `integrities()` in `src/model/integrity.ts` is the one reading of whether a filesystem's data is damaged. Four causes read it, one per non-ok state, and so does Storage, so a card and a line cannot disagree about one filesystem.
- A report the damaged-files cause already speaks for raises no second card of its own: that cause names the filesystem and its files, where the scrub cause can only name a report path.
- `summarySnapshot()` is the external verdict contract for `vsys --once --summary`. It reads `causes()` and `meters()`, and it adds no display copy.

## Summary JSON

`vsys --once --summary` prints one JSON object:

```json
{
  "schema": "vsys.summary.v1",
  "time": 0,
  "verdict": [{ "cause": "scratch", "level": null, "subject": null }],
  "meters": [{ "id": "cpu", "value": null, "max": 100, "level": "warn" }],
  "errors": []
}
```

`schema` is the summary contract identifier. `time` is the sample time in milliseconds since the Unix epoch. `verdict[].cause` is a `CauseId`. `verdict[].level` is a `Level`, or null when the value was not measured. `verdict[].subject` is the first affected lane id, affected cgroup path, affected filesystem path or null. A navigation-only `at` target never becomes a subject. `meters[].id` is a meter id. `meters[].value` and `meters[].max` are raw numbers or null. A null meter value means the reading was not measured. `meters[].level` is always a `Level`, and an unread quantity grades `warn` by the model's unknown-reading rule. `errors` uses the same source-error records as `--once`.

The summary path takes two samples. The second sample gives CPU and I/O rates a baseline. It skips scratch collection through the collector sample option. The scratch cause is still present with null level and null subject, so a skipped scratch scan never reads as healthy. It skips the kernel log search the same way, because a collector's first search reads every boot the journal holds; the summary's integrity causes read the error counter alone. No scratch size enters a meter.

## Invariants

1. Severity ranks the ladder and the cause order table breaks a tie, with an unconfined agent leading it. `src/model/verdict.test.ts` checks the ranking and the tie order.
2. A housekeeping cause is a card but never the verdict. `src/model/verdict.test.ts` checks that housekeeping never leads the ladder.
3. A healthy machine produces no causes at all. `src/model/verdict.test.ts` checks it.
4. A lane stalling on a resource that a specific cause already reports joins that card, so one contention never produces two cards. `src/model/verdict.test.ts` checks storage stallers against a CPU one.
5. A slice name appearing at two paths is summed once, and a slice total is unknown unless every root reported the counter. `src/model/verdict.test.ts` checks a nested copy against root selection.
6. A filesystem below the configured free-space floor is a cause of its own, and a parent slice never becomes the top writer or the top swap holder. `src/model/verdict.test.ts` checks both against nested groups.
7. A quantity a meter's level depends on that could not be read is a warning, never an untroubled reading, and the summary keeps that warning level while the missing reading stays null. `src/model/verdict.test.ts` checks the four meters and their consumers, and `src/model/export.test.ts` checks the summary meter shape.
8. Build load counts the configured linkers separately, machine wide and per lane. `src/model/verdict.test.ts` checks both.
9. One cause produces one attention card whatever the number of lanes, and every card ends with a next step of its own. `src/ui/attention.test.ts` checks nine stalling lanes and every card kind.
10. Source read failures are not a machine problem and raise no card. `src/ui/attention.test.ts` checks them.
11. A recorded event alone does not become a current concern. `src/ui/attention.test.ts` checks resolved events and missing source data.
12. Every integrity state but healthy and checking raises a card, so Home can never read healthy while Storage reads otherwise about the same filesystem. `src/model/verdict.test.ts` drives one snapshot per state through the ladder and checks that a filesystem checked and found sound raises nothing.
13. The summary schema contains only ids and raw numbers from the model, and the scratch collector is not called when summary sampling skips scratch. `src/main.test.ts` snapshots the summary schema against fixture sources, and `src/collect/collector.test.ts` checks the scratch collector call count.
14. With no agent slice, the agent figures sum the agent lanes, never a lane without an agent, and an unreported lane leaves the total unknown. `src/model/verdict.test.ts` tables the sum, a gap, a process left out, a failed process listing and a process kept with an unread environment, through the meters and the swap card; `src/collect/collector.test.ts` checks a numeric agent CPU and page cache from two scopes, and the history point.
15. With no agent slice, the desktop-swap card offers no `agents.slice` command and its next step names the agent lanes instead of the slice; with the slice present, both are unchanged. `src/ui/attention.test.ts` pins both cases side by side.
16. A process carrying `unconfirmedTool` raises a housekeeping card naming the process, the configured tool it almost matched and the one path tested against that tool's install locations (the executable for a name match, the script for a scripted match), and that card's next step points at the Settings overlay's paths fragment; it never becomes the verdict. `src/model/verdict.test.ts` checks the cause, `src/ui/attention.test.ts` checks the card, including several processes sharing one tool name, and `src/collect/builds.test.ts` checks that a scripted match's path is the script rather than the interpreter's own executable.
17. Where `unconfirmedPath` is null, the card never tells the reader to cover a path: it says a script path could not be read and points at the process itself first, and a card mixing processes with and without a readable path gives both pieces of advice. The readable advice names every distinct path, paired with its own tool name, never a tool name alone standing for every path a reader would have to guess among; two processes sharing one configured name but rejected at different paths each get their own line. `src/ui/attention.test.ts` checks a card with none of its processes readable, one mixing both, and two processes sharing a tool name with different paths.
18. The text an unconfirmed-tool card constructs names every process it carries individually in its detail, with no built-in count-and-cut the way `list()` gives a lane or a mount list: nothing else on the dashboard can name an unconfirmed process at all, so this card's own copy never gives one up to a count on its own. Its next step names every distinct remediation instead of every process: a readable path is deduped by the path and tool together, an unread one by tool name alone, so two processes that would take the identical fix collapse to the one instruction that fixes both. The room a narrow or short terminal leaves is a separate limit the same `cardDetail()`/`capLines()` draw every card through, including this one, and a list long enough to miss that room is still cut with its mark, the same floor-exception any card can hit. `src/ui/attention.test.ts` checks six processes and that the constructed text replaces none of them with "more".
19. The damaged-files card's file and unnamed-block totals are unknown, the same way its block total already is, where any damaged filesystem's own counts are unknown: a filesystem damaged only by a remembered finished check (storage integrity's invariant 17) has no address data of its own, and summing its share as zero would understate the total rather than say it is unread. `src/model/verdict.test.ts` checks the totals against a live damaged filesystem beside one known only from memory.
