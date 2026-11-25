---
name: orch
description: "PRIMARY AGENT ONLY. Load to orchestrate a Linear or GitHub work item from preparation through merge."
license: MIT
user-invocable: true
metadata:
  author: "vanillagreen"
  source: "kendex"
  repository: "https://github.com/vanillagreencom/kendex"
  bugs: "https://github.com/vanillagreencom/kendex/issues"
---

<!-- kendex:project-instructions:start -->
## Project Instructions

- The kendex-refresh Actions workflow and rolling kendex/refresh pull request own vsys refresh outputs. Preserve unrelated work when receiving those outputs. (ORCH-M03)
- Use the live lifecycle and Verifying role in kendex.toml [skill-instructions].linear. Read the live issue before changing its state. (ORCH-M09)
- Use the estimate and post-merge observation policies in kendex.toml [skill-instructions].project-management. (ORCH-M22, ORCH-M23)
- Route unattended lane questions through lane-mail. Jarvis relays owner decision requests and critical notices to Slack and chat. Keep voice replies on their call, progress reports in open text media, and replies in the owner's message thread. (ORCH-D22)
- Link each owner-summary item to the live tracker URL. Read issue identifiers from LINEAR_TEAM_PREFIX and GH_ISSUE_PATTERN. (ORCH-D25, ORCH-M11)
- Complete internal review before opening a public or internal repository pull request. A private repository may open after its first validated implementation commit. Read live repository visibility before selecting the route. (ORCH-M01)
- Apply the refresh identity and approval checks in kendex.toml [skill-instructions].review-gate. (ORCH-D26)
- The vanillagreen-overseer GitHub App supplies fallback approval separately from lane credentials. Fleet supplies its private mode-600 token file outside lane roots and replaces it atomically before expiry. (ORCH-D27)
- Keep .kendex-lock.json and .kendex-generated.json out of the micro change class. Keep the consumer queue paths in HARNESS_CI_QUEUE_PATHS. (ORCH-M06)
- Report measured cycle time against these targets in seconds: render=300, trivial=300, micro=1200, small=1800, standard=5400. Review targets are micro=1, small=1, standard=2 rounds, with 600 seconds per round. A micro task targets about eight lane minutes and three overseer minutes. (ORCH-M12)
- Request a process issue after the third qualifying miss of the same cycle phase. Include the miss evidence and phase. (ORCH-M13)
- Compare recorded regressions against the week beginning 2026-09-28 for the organization review-cap experiment. Keep that baseline optional outside the experiment. (ORCH-M14)
- Use Conventional Commit type syntax for commit subjects and pull-request titles. Keep the issue association. The installed commit gate decides accepted syntax. (ORCH-M26)
- Every vsys lane launches and relaunches on claude-opus-5-5 at high effort or gpt-6.2-sol at high effort, and never copies a model from an older lane record. (VSYS-ORCH-01; owner 1791067953, 1794951908-4065716-15610; Jarvis 1795222654-480988-10512)
- The vsys repository has no bot token, so a lane merges as the keyring user bmethod with --expected-head, and only on the exact head the overseer cleared. (VSYS-ORCH-02; standing fleet ruling 2026-10-08)
- At every pushed head and before any arm, the overseer runs its second opinion through the repository roster in the owner's order: the claude entry (Claude CLI) first, then the pi-copilot-gpt entry (gpt-6.1-sol through Pi on 1copilot, whose Pi catalog lists no gpt-6.2-sol), then the codex entry as the fallback, through SECOND_OPINION_CODEX_CMD in kendex.settings.toml on the Codex account the account judge picks from AGENT_RUNTIME_ACCOUNT_DIRS, and never runs it on 1codex or 2codex. The roster's cross-model check skips an entry whose model is the overseer's own. (VSYS-ORCH-03; owner 1790876473, 1790910316, 1791349877, 1793492823, 1793558900.347579; Jarvis 1791179688, 1791469938; Jarvis 1794802002-752187-6298, 1795219001-1102926-9039)
- Never hold a refresh pull request: give it no requested-changes review and do not disable its auto-merge; a wrong render is a kendex finding sent to Jarvis. (VSYS-ORCH-04; owner 1791397764)
- A change to AGENTS.md or any SKILL.md merges only after the owner reviews its before-and-after. (VSYS-ORCH-05; owner 1791260972, 1791262352, 1791333915)
- A release needs no owner answer. (VSYS-ORCH-06; owner 1790940306)
- Work the VSY backlog by priority, with CI, performance, efficiency, scalability, maintainability and architecture before features; an empty queue is not Stop. (VSYS-ORCH-07; owner 1792036693, 1791744768; Jarvis 1792292633)
- Never reboot the owner's machine or log the owner out. (VSYS-ORCH-08; owner 2026-10-03)
<!-- kendex:project-instructions:end -->

# Orchestration

Load `github`, `worktree` and `linear` before their first use.

> **MODE SWITCH**: you are the orchestrator. Delegate every implementation, review and QA task to a specialist sub-agent. Never edit code, unless the user explicitly asks or the item runs the [`micro`](workflows/micro.md) tier, whose runner makes the edit itself.

## The Cycle

Get the issue → dev implements → publication, review and fixes in the order `orch-runtime pr order` answers → required CI and review gate → merge.

- **Bounded loops.**
  - A fix round addresses blockers only.
  - The same pass declines or tracks every `fix` suggestion ([review-pr](workflows/review-pr.md) § 4).
  - A re-review narrows to the fix diff, the domains it touched and the class of every defect it fixed ([reviewer](../reviewer/SKILL.md) § Re-Review Rounds).
  - Two consecutive rounds with no new blocker end the review.
  - [Review cap](references/review-cycle.md#review-cap) sets the cap, cap 0 and a fix round's own regression.
- **Finding conduct.** Apply reviewer's [decision flow](../reviewer/references/finding-disposition.md#decision-flow), [recurrence rule](../reviewer/references/finding-disposition.md#recurrence) and [filing bar](../reviewer/references/finding-disposition.md#filing-bar).
- **Scope cuts.**
  - A reviewer or the orchestrator can choose a cut round.
  - A round whose only findings are scope or wording asks ends the review: reply, resolve, push nothing, and merge through the gate.
- **Ask gates.**
  - [communication-modes](references/communication-modes.md) alone decides which questions reach the user.
  - Use [Presentation](references/communication-modes.md#presentation) for messages to the user.
  - `ORCH_DECISION_MODE` does not change that ask set.
  - Merge asks unless `ORCH_MERGE_AUTONOMY=auto`; under `auto`, merge without asking only when every merge gate is green.
  - In a lane every ask gate is `lane-mail`, never the harness question tool: [skill-rules](references/skill-rules.md) § Coordination.
- **Post-PR autonomy.**
  - After a PR exists, `ORCH_DECISION_MODE=auto-recommended` takes and logs the continuing option while a bounded wait, retry or triage round remains. `ask` presents the listed choice.
  - Initialize the item's state before the transitions below:
    - `orch-runtime state head-budget take` spends one automatic retry. `--kind review-wait` restarts its count on a new head; `--kind ci-fix` counts across heads. `head-budget reset` starts the count over.
    - At a cap, `orch-runtime state post-pr-stop record` persists the named stop with its rendered Markdown comment. The workflow posts that file to the PR and returns the stored stop.
    - A nested caller uses `post-pr-stop record-if-empty`, so a precise upstream stop stands.
    - Every continuing action lifts the stop with `post-pr-stop clear`.
  - `ORCH_MERGE_AUTONOMY` controls merge consent only.
- **The overseer reads results.**
  - It accepts green lane checks and CI without reruns.
  - It grants no prepare, commit, push or merge, and no shared validation slot.
  - Green lanes with the user's merge consent arm auto-merge and own its wait per [merge-pr](workflows/merge-pr.md).
  - A dev test-only validation-ceiling report ends validation.
  - Lanes tick branch boxes with proving artifacts. Where a lane cannot, the runtime's close ticks them from the PR body's `## Done-when evidence` section.
  - The overseer ticks a post-merge box only after reading its proving artifacts at their revision and conditions: test output, a screenshot, a measured figure or a deployed screen. A lane summary is no proof.
  - A container closes as [skill-rules](references/skill-rules.md#containers) § Containers states.
  - An outcome to read lives in its own child.
  - When evidence is due or contradicted, the overseer reads it to narrow, replace or stop the failed intervention. A fix item is not the default.
  - The overseer gives no model or account instructions.
  - Lanes keep their launch models and launch no lanes.
- **Item work stays in lanes.** A fleet is hosted when `orch-runtime host resolve` prints anything but `local`. Its overseers share the control VM for coordination.
  - Every tracker item's round goes to its branch's lane. No worktree, item branch, dev, review or fix agent, validation, build, install or test runs on the control host. The one exception is an owner-directed small change, `directive-[ID]` ([directed-change.md](references/directed-change.md) § Who makes it).
  - A control-host subagent (sweep, triage verifier, measurement or research) reads without bulk writes.
  - It streams archives, or extracts each into its own scratch subdirectory and removes the extraction before the next.
  - Before an extraction it reads the uncompressed size and the volume's free space. Where less than 3 GB would remain, it stops and reports to the overseer without extracting.
  - It runs no history-wide content read: no `git log -S` or `-G`, no `--all -p`, no command that reads every blob. It searches through `gh search code`, the GitHub API or a lane.
  - It runs no busy wait (`/dev/zero`, `/dev/urandom`, spin polls) on the shared host. It waits with one bounded background command and its completion notice, or on watch events.
  - Its scratch location is an empty subdirectory, `tmp/<run>/<agent-topic>/`.
  - Only that subagent removes its scratch location, and no background job of the overseer reads it.
  - Every control-host subagent brief carries these rules.
  - Refresh follows the [consumer's owner](references/oversee-events.md). There is no `--refresh-only` exception.
- **Acceptance is artifact-based.** A round closes on a validated on-disk artifact plus git and tracker state, never on a return message.
- **Rules reload after a rebase.**
  1. Before a step that can rebase the branch (the `record-push` request, `worktree create --reuse`, a restack), bind `git -C [WT_PATH] rev-parse --verify HEAD` as `[BOUND_HEAD]`.
  2. If the step moved it, then at once, before any validation, publication or arm, run `git -C [WT_PATH] diff --no-renames --name-only [BOUND_HEAD] HEAD -- <each loaded file's repo path>`.
  3. Re-read each listed file at `[WT_PATH]/<path>`, under the deleted-path rule of dev's [Round Contract](../dev/SKILL.md#round-contract).
- **A lane is quiet.** `ORCH_LANE_OUTPUT` decides what a lane prints and where a filled `<output_format>` block goes: [skill-rules](references/skill-rules.md) § Lane Output.

## Commands

Route `<command> [args]` to its workflow and follow [Workflow Execution](#workflow-execution).

| Command | Arguments | Workflow | Purpose |
|---------|-----------|----------|---------|
| `start` | `[ISSUE_ID]` \| `github OWNER/REPO#N` | `workflows/start.md` / `workflows/start-worktree.md` | Prepare one work item; from a worktree, run the full session |
| `start new` | `linear\|github ...` | `workflows/start-new.md` | Create one issue, then start it |
| `micro` | `[ISSUE_ID]` \| `github OWNER/REPO#N` | `workflows/micro.md` | Few-line tier: edit, commit, PR, arm and merge, with no dev agent and no review cycle |
| `small` | `[ISSUE_ID]` \| `github OWNER/REPO#N` | `workflows/small.md` | One-subsystem tier: the full session under thin review bounds |
| `handoff` | `linear\|github ...` | `workflows/handoff.md` | Launch independent sessions |
| `plan-issues` | `PLAN_PATH linear\|github` | `workflows/plan-issues.md` | Convert plan items into issues |
| `dev-start` | `[ISSUE_ID]` | `workflows/dev-start.md` | Delegate implementation |
| `dev-fix` | `[ISSUE_ID]` | `workflows/dev-fix.md` | Delegate fix items |
| `ci-fix` | `[PR_NUMBER]` | `workflows/ci-fix.md` | Analyze and fix a PR's CI failures, a merge-group run's included |
| `review` | `[all]` \| `[last N]` \| `[HASH]` | `workflows/review.md` | On-demand review of local changes |
| `review-codebase` | `[PATH]` | `workflows/review-codebase.md` | Whole-codebase fan-out, findings only |
| `review-pr` | `[PR_NUMBER]` | `workflows/review-pr.md` | Review cycle with fixes and QA |
| `review-pr-comments` | `PR_NUMBER` \| `BRANCH` | `workflows/review-pr-comments.md` | Triage PR review comments |
| `submit-pr` | `[PR_NUMBER]` | `workflows/submit-pr.md` | Push, create the PR, gates, merge |
| `merge-pr` | `PR_NUMBER` \| `all` | `workflows/merge-pr.md` | Verify the conditions and merge |
| `post-summary` | `[ISSUE_ID]` | `workflows/post-summary.md` | Post the summary and handoff comments |
| `verify` | none | `workflows/verify.md` | Read and complete due verification checks |
| `oversee` | none | `workflows/oversee.md` | Fleet mode: one session per unblocked item, every PR shepherded to merge |

**`start` routing.**

- `github OWNER/REPO#N` sets `TRACKER=github` and `ISSUE_ID=issue-N`, and keeps `OWNER/REPO` for the API.
- Any other id is Linear unless it starts with `issue-`.
- A working directory whose git common dir differs from `.git` is a worktree: route it to `workflows/start-worktree.md`.
- Route any other directory to `workflows/start.md`.

## Scripts

```bash
.agents/skills/orch/scripts/<script> [args]
```

| Script | Use |
|--------|-----|
| `orch-runtime` | The orch runtime: workflow records, their operations and the fleet watch |
| `setup` | Build agent-runtime, then `orch-runtime`, into the user cache |
| `orch-env` | Print the effective value of a setting: `orch-env NAME DEFAULT`, read in the order of [settings.md § Where a setting is set](references/settings.md#where-a-setting-is-set), then the default |
| `git-context` | Print a git-derived value: branch, head, issue id, repository or common root, timestamp |
| `resolve-base-branch` | Print a worktree's base branch |
| `sync-base` | Resolve, fetch and fast-forward the checkout that owns the base branch, and print the branch name |
| `base-freshness` | Fetch the base branch and report the worktree's ahead and behind counts as JSON, so the review cycle gates on a current base |
| `post-merge` | Run the repository's post-merge steps in its base checkout, stopping at the first failed step |
| `lane-host-ssh` | The static SSH lane-host provider; protocol: [lane-host.md](schemas/lane-host.md) |
| `lane-marker` | Write a lane's launch record before anything writes to the lane |
| `copilot-statusline` | The `statusLine` command a Copilot CLI lane runs: it records the session JSON the CLI hands it on stdin and prints one footer line |

- Each `orch-runtime` verb's `--help` is its contract.
- `setup` keys its builds on both crates' sources, then prints each duty's readiness on stderr. `setup --detach` starts the builds in the background.
- `post-merge` ends with `setup`, and a lane's launch runs `setup` for the lane's tree.

The mailbox skill's `lane-mail` is the lane-to-overseer mailbox and the owner channel.

- A lane runs `ask`, `notice`, `wait`, `inbox` and its mailbox monitor `watch`.
- The overseer runs `send`, `drain`, `pending` and `events`, adding `--root` and `--host` for a lane on another host.
- On its own mailbox the overseer asks and reports to the owner with `--to owner`, and closes an owner ask once with `resolve`.

Every script and every verb takes `--help`. The exceptions are `resolve-base-branch`, whose one argument is a path, and `copilot-statusline`, which reads the CLI's JSON on stdin.

- The review gate, the CI and merge-queue waits, and the runtime's `verify-review`, `verify-pr` and `queue-watch`: [gates.md](references/gates.md).
- Artifact checks: [artifact-checks.md](references/artifact-checks.md).
- Schemas: `schemas/workflow-state.md` (the state file), `schemas/dev-return.md` (the dev completion artifact), `schemas/dev-round.md` (the fix round's item set), [review-finding.md](../reviewer/schemas/review-finding.md) (review and QA findings).

## Configuration

For setting precedence, key meanings and where to look up built-in defaults, read [references/settings.md](references/settings.md). For review-gate keys, read [references/gates.md](references/gates.md).

- The tools the runtime, `setup` and the scripts need: [README.md § Setup](README.md#setup). `orch-runtime ready` names any a duty lacks.
- A lingering systemd user manager with `systemd-run` contains the runtime's detached jobs. Where the manager does not run a unit, the job runs as a `setsid` group ([job-units](references/job-units.md)).

---

## Runtime Notes

> If you are running in **Codex**:
>
> - `approval required by policy, but AskForApproval is set to Never` means an execpolicy rule matched the command, not its shell form. Never retry it and never wait for approval; act per [codex-runtime](references/codex-runtime.md).
> - Run long waiters, and the repeated `verify-pr` calls that verify a pull request's CI, through [Waiter launch](references/waiter-launch.md).
> - Spawn generated agents with the parameters `.agents/skills/agent-runtime/scripts/agent-runtime subagent spawn --harness codex [CANONICAL_NAME]` prints, without a full-history fork, with a `DELEGATION:`-prefixed `<delegation_format>`. [codex-runtime § Spawning Codex collaboration agents](references/codex-runtime.md#spawning-codex-collaboration-agents) states this for each surface.

> If you are running in **Pi** with `pi-agents-tmux`:
>
> - A delegation is one `subagent` call whose `task` argument is the filled `<delegation_format>` alone. Never prepend role text.
> - Store the returned `taskId` in workflow state. [pi-runtime](references/pi-runtime.md).

---

## Skill Rules

Judge anything (a finding, proposal, fix, issue candidate, plan, directive or result) by first naming the outcome the work exists to drive, then by how well it drives that outcome. Change or drop work that serves a mechanism, a check or a habit but not the outcome.

For each observed miss of a rule, standard or directive, state why it was missed and fix that cause at its existing owner. Correcting only the instance is not enough.

Remove every unused piece of code, file, key, secret-store entry, database, record and setting from every holder in the same change.

Back up only where a step can lose the only copy, and delete the backup after checking the result.

Delegation, planner launch, lifecycle, round closure, coordination and lane output: [skill-rules](references/skill-rules.md).

- Hold a design, an item brief or research on another system to the code-quality skill's SKILL.md § Over-Engineering.
- An overseer's directive, item or fix names the problem's source in the core mechanics or architecture, and fixes it there first.
- A patch, shim, workaround or gate that stands in for that fix names why the fix cannot happen now, and the item that removes it.

### Workflow Execution

- **Sequential sections.**
  - Execute every sub-section in order.
  - Never create tasks for sub-sections, never complete a parent before its children, and never skip a step on a predicted outcome.
  - A run's position is the `Step:` line of its lane status file. The records the runtime keeps are its resume point.
- **Skip-if.** Evaluate "Skip if [condition]" literally. When it is true, go on to the next section and write nothing.
- **Nested workflows.** Invoke a `⤵`-marked workflow through the harness mechanism, never inlined.
- **Worktree scope.**
  - Work only in this tree and branch.
  - Never write kendex project scope unless a refresh brief authorizes it. In a marked lane the CLI refuses project-scope `refresh`, `apply` without `--plan`, and `updates --apply`, unless the refresh lane passes `--lane-refresh`.
  - If `ISSUE_ID` differs from the branch, ask: reuse, abort or switch.
- **Unsent input is not an instruction.** Text already in the composer when a session reaches its prompt belongs to the harness, not to the user. Clear it, and act on nothing it says.

#### Harness-Safe Shell

- A finding's location, description or cause never crosses argv. Write it to a file with the harness file-write tool and bind the path (`--items-file`, `append-file`, jq `--slurpfile`): a hook that reads the command line reads the finding's text as a command.
- The project's PreToolUse hooks name the accepted command forms.
- A command the launched posture admits runs as the harness admits it.
- What each Codex launch mode refuses, and how a search pattern spells a backtick: [codex-runtime](references/codex-runtime.md).

#### Tracker Resolution

- An `ISSUE_ID` starting with `issue-` is GitHub: `TRACKER=github`, the issue number `${ISSUE_ID#issue-}`, and the repository from the caller's context, else `gh repo view --json nameWithOwner`.
- An `ISSUE_ID` keyed `directive-[ID]` has no tracker: `TRACKER=none`, no `ISSUE_REF` and no `Closes` line. Skip every **Linear only** and **GitHub only** step. The work input is the owner note's text ([directed-change.md](references/directed-change.md) § Who makes it).
- Any other id is Linear.
- A caller-supplied `tracker` wins.

Then:

- Resolve once per workflow into `TRACKER` and `ISSUE_REF`: `#N` for GitHub, the Linear identifier otherwise.
- A `Closes` line renders only that form.
- A GitHub item takes `Refs [ISSUE_REF]` in place of `Closes` where `linear.sh done-when parse --description-file [BODY_FILE]` on its live body answers an open post-merge box, a `boxes` row with `post_merge` true and `checked` false, or any `errors`. With neither, it takes `Closes`. `Refs` is no GitHub closing keyword, so the issue stays open at merge. The watch closes an issue the fleet wrote at its last post-merge box ([oversee-events.md § Verification](references/oversee-events.md#verification)), and reports one an outside author wrote once, for a reading by hand ([oversee-events.md § `verifying-unjudged`](references/oversee-events.md#verifying-unjudged)).
- Where the optional linear package is not installed, a GitHub item reads as holding no open post-merge box and takes `Closes`, with its post-merge classification reported unavailable; it is no unread item, and no step refuses it, since refusing would hold every GitHub delivery on a consumer without that package.
- With the script present, a nonzero `done-when parse` exit is a failed read.
- Run **Linear only** and **GitHub only** steps only for that tracker.
- Never run a `linear.sh` tracker read or write against a GitHub item. `linear.sh done-when parse` reads no tracker, credential or network, so it classifies a GitHub body too.

### State Management

Durable data lives in workflow state, `<state-dir>/items/[ID]/workflow-state-[ID].json` ([schemas/workflow-state.md](schemas/workflow-state.md)). Read and write it through the `orch-runtime state` verbs or the typed `op` request a step names, never by inline substitution.

- Other temporary session state, handoffs, lane status and reviews among it, goes under the repository's `tmp/`.
- In the main checkout, the watch's retention duty removes an entry there once nothing uses it ([workflow-state.md § Scratch](schemas/workflow-state.md#scratch)).
- kendex's managed ignore block covers `tmp/` in every consumer.
- `docs/` holds tracked repository content and never takes a kendex ignore rule.
- A plan or research report is not session state: its durable home is its tracker issue, `agents/planner.md` § Plan Artifacts places its working copy, and it is never committed.

After compaction:

- Resume from the step after the last completed one.
- Read the item's workflow state; an overseer takes [takeover](workflows/oversee-takeover.md#1-read-the-mailbox-and-handoff)'s bounded resume reads.
- Apply [Delegation](references/skill-rules.md#delegation) before re-sending by a stored ID.
- Stall recovery follows [Stalled round](references/skill-rules.md#stalled-round).

### Review Pipeline

The finding schema, routing, disposition and the issue audit pipeline: reviewer's [Review pipeline](../reviewer/references/finding-disposition.md#review-pipeline).
