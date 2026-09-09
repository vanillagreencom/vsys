# Architecture

Each sample contains observed values and source errors. A failed read must remain distinguishable from a measured zero. The collector reads system files. Settings, history, exports, and optional notifications are separate application effects.

## Terms

- Scope: a systemd cgroup whose name ends in `.scope`.
- Lane: a watched scope or a group with an agent or resource alarm.
- Escaped agent: a configured agent tool outside the configured agent slice.
- Account: the basename of the agent configuration directory the lane's main process names, unknown when it names none.
- Cause: one detected problem, held as data with its level, subjects, named consumer and numbers. Every lane with the same cause shares one cause.
- Ladder: the causes ranked by impact on the person at the keyboard. Its first element is the verdict; every element is one attention card.
- CPU percent: utilization in units of one logical core.
- Pressure: the recent percentage of time that tasks stalled on a resource.
- Pinned Fleet: the recorded sample selected by the timeline cursor.
- Checkpoint: a complete snapshot followed by exact changes to its values.

## Boundaries

- Collectors depend on source files and typed configuration. They do not import the UI or write kernel state.
- Scratch traversal runs as a cooperative background task during interactive collection. Snapshots carry its measurement time and pending state. Scripted collection waits for a complete scan.
- The mount parser owns mount roots and path escaping for cgroup and filesystem collection.
- The model derives lanes, the cause ladder, the meters and alert transitions as numbers. Every word and every formatted number belongs to the UI.
- A slice total sums its root groups. The cause ladder, the meters and the history point read the same function.
- Every host-specific name the Overview needs is configuration: agent and desktop slices, excluded argv patterns, confinement cap markers, linker names, compiler cache names and the environment variables that carry the account, the pane address and the window title.
- The pane address and window title are read from the pane environment. vsys does not query the tmux server, so a pane that exports neither leaves both parts out of the lane name.
- The build cache reading queries the sccache server through an injected runner, rate limited between samples and bounded by its own deadline, so a wedged server cannot hold the sample the dashboard awaits. A collector built without a runner records no reading, so no test starts that server.
- The runtime owns collection, history, and settings changes for a running dashboard. A replaced source is handed its predecessor, so readings measured since vsys started survive the replacement.
- The history store owns application persistence. The collector does not depend on SQLite.
- `escaped()` in `src/model/lanes.ts` is the only definition of an agent outside its slice. Lanes, alerts, history points and timeline events all call it.
- [Timeline events](events.md): what the timeline records, and how a change is held until it counts.
- The UI consumes snapshots. It reads open scratch descriptors only for a live selected lane.

## Invariants

- An excluded argv pattern matches an executable name or a whole flag, never prompt text, and the configured linker names are the only linker list. `src/collect/collector.test.ts` checks a prompt naming a language server and an empty linker list.
- The environment of an escaped agent is read from that agent, not from its scope's main process. `src/collect/collector.test.ts` checks an agent child of a pane shell.
- A launcher trail states the ancestors and their cgroups, the confinement markers and any PATH prefix. Markers with the wrong cgroup mean a shadowed launcher, their absence a bare launch. `src/model/launcher.test.ts` checks both and an unreadable environment.
- A lane name joins the configured parts in the configured order and leaves out a part with no value. `src/model/naming.test.ts` checks the order and an unreadable environment; `src/model/lanes.test.ts` checks two accounts in one worktree and a lane that names no account.
- Per-lane page cache, I/O rates, CPU share and cgroup weight stay unknown when the kernel did not report them, and an unread cgroup tree leaves the effective memory cap unknown rather than unlimited. `src/model/lanes.test.ts` checks a group with no counters and a lane with no covering group.
- A cgroup limit file holds a number or the word max. A file that could not be read is neither, so the effective cap is known only when every covering ancestor was read. `src/collect/collector.test.ts` removes an ancestor's memory.max.
- A snapshot a previous build stored is filled with the unknown value for every field it predates before any screen reads it. `src/store/history.test.ts` checks a stored lane without the current fields.
- A blocked lane counts its tasks in uninterruptible wait and names storage or memory by the higher stall share. `src/model/lanes.test.ts` checks both resources and unknown pressure.
- Severity ranks the ladder, the cause order table breaks a tie, an unconfined agent leads it, and a housekeeping cause is a card but never the verdict. `src/model/verdict.test.ts` checks the ranking and `src/ui/overview.test.ts` checks a scratch overage on a healthy machine.
- A lane stalling on a resource a specific cause reports joins that card. `src/model/verdict.test.ts` checks storage stallers against a CPU one.
- A slice name appearing at two paths is summed once. `src/model/verdict.test.ts` checks a nested copy against root selection.
- A filesystem below the configured free-space floor is a cause of its own, and a parent slice never becomes the top writer or top swap holder. `src/model/verdict.test.ts` checks both against nested groups.
- One cause produces one attention card whatever the number of lanes, and every card ends with a next step distinct from its title and detail. `src/ui/overview.test.ts` checks nine stalling lanes and triggers every cause at once.
- Source read failures are counted once per source and stay out of attention. `src/ui/overview.test.ts` checks the footer.
- Invalid io.stat counters stay unknown rather than becoming a zero write rate. `src/collect/collector.test.ts` plants an invalid counter.
- One predicate decides every build slot total: a compiler or a configured linker. cargo, a running test binary and a build script runner are classified builds that hold no slot, while the per-process list keeps the broad classification. `src/model/builds.test.ts` checks a cargo parent with two compiler children.
- The Builds fleet total and the Overview build meter print one sentence built from one function and one buildLoad result. The rows read the build counts each lane already carries, and build processes in no lane form one more row, so the rows sum to that total. `src/ui/builds.test.ts` checks the shared sentence and `src/model/builds.test.ts` checks the sum, including build processes outside every lane.
- Only a build process with an empty RUSTC_WRAPPER in a readable environment bypasses the build cache. `src/model/builds.test.ts` checks a set wrapper and an unreadable environment.
- A jobserver FIFO is never opened, because reading it would take a token from the build. One parser reads MAKEFLAGS for the lane's own pool and for the fleet pools. MAKEFLAGS is inherited, so tokens in use count only the outermost build process holding each pool, and a pool whose MAKEFLAGS omits a job count has an unknown total. `src/model/builds.test.ts` checks a linker under its compiler, sibling compilers under one make, and a pool without a job count.
- Build cache counters are compared with the latest reading, so a server restarted at any point rebases rather than producing a negative delta or mixing two lifetimes. A missing sccache binary is an absent feature rather than a source error, and a query that does not answer in time is a source error with an unavailable reading. `src/collect/sccache.test.ts` checks a restart after the counters grew, the missing binary, a failing query and a query that never answers.
- A settings change replaces the collector and carries the build cache reader over, so the counts stay measured since vsys started. `src/runtime.test.ts` checks the handover and `src/collect/collector.test.ts` checks the continued delta.
- A build process's own environment supplies its compiler wrapper and make token pool. `src/collect/collector.test.ts` checks both fields against the unselected variables.
- Bytes written since boot per slice come from the io.stat read the Overview already uses. Device totals are read once at the cgroup v2 root, which counts every writer on the machine, including services outside the watched user tree. `src/collect/collector.test.ts` checks the root against the watched tree and an unreadable root counter.
- Drive lifetime writes are parsed from `smartctl -A` reports written by a privileged timer, one file per `/sys/block` device name with a single optional extension. Every drive keeps a row, so a drive without a readable report is named as the one missing its lifetime writes. `src/collect/devices.test.ts` checks NVMe data units, ATA logical blocks, the drive model against its family name, and one report among two drives.
- The settings collection reads are declared in `src/collect/settings.ts`, and the runtime rebuilds the collector from that declaration alone. Every function collection reaches takes that subset of the settings rather than the whole configuration, so reading an undeclared setting fails the type check instead of leaving the collector stale. Display settings and notification rules stay out, because a rebuild discards the counters and alert state a sample compares against. `src/runtime.test.ts` checks that a collection setting rebuilds and that a display setting and a notification rule do not.
- Process environment caching uses PID and start time. `src/collect/collector.test.ts` exercises PID reuse and environment selection.
- Scope launch metadata belongs to the scope's main process. `src/collect/collector.test.ts` checks a wrapper with an agent child.
- When a PID appears in sibling scope lists, its process membership file selects the row. `src/collect/collector.test.ts` checks that fallback.
- A source error does not turn into zero utilization. `src/collect/collector.test.ts` plants an invalid counter.
- Device error deltas use filesystem and device identity. `src/collect/btrfs.test.ts` checks sample and startup baselines.
- Missing mount information or device counters remain unknown in history. `src/store/point.test.ts` and `src/collect/btrfs.test.ts` check those failures.
- Aborted scrubs remain problems even when they counted no errors. `src/collect/btrfs.test.ts` checks that condition.
- Each new escaped agent can emit an alert within an already alarmed scope. `src/model/alerts.test.ts` checks process identity and rearming.
- Collection does not overlap itself when settings change. `src/runtime.test.ts` controls an in-flight source and checks rescheduling.
- Failed settings writes preserve active history. `src/runtime.test.ts` checks replacement failure.
- Saving settings through a file link preserves the link. `src/config/config.test.ts` checks the target contents.
- Historical snapshots remain independent of live objects and callers. `src/store/archive.test.ts` checks exact reconstruction and mutation isolation.
- Settings changes and persistence changes preserve retained incidents. `src/store/history.test.ts` checks transfer and database merging.
- History storage rejects a database with another application's schema. `src/store/history.test.ts` checks tables and views.
- Timeline positions follow timestamps. `src/ui/format.test.ts` checks collection gaps and alert alignment.
- Process text cannot emit terminal controls. `src/ui/format.test.ts` checks the display sanitizer.
- Interactive quit restores the terminal, including when history shutdown fails. `src/main.test.ts` checks isolated terminals. `src/runtime.test.ts` checks error delivery when collection and shutdown both fail.

## Validation limits

The archive caps compressed replay data. It reports shortened retention when the data exceeds that budget and persistence is off. SQLite retains snapshots beyond the memory cache and across restarts.

`scripts/bench-history.ts` checks the configured history window with changing process identities. It verifies selected complete snapshots against their originals. Its generated workload does not establish a memory bound for every possible command line or process workload.

The collector benchmark uses regular-file fixtures. Its result does not guarantee live procfs latency. [Plan coverage](plan-coverage.md) records the implementation and checks for each screen.
