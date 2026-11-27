---
name: project-management
description: "Load to plan a cycle, audit issues, build a roadmap, or decompose research into issues."
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

- Use the live lifecycle and Verifying role in kendex.toml [skill-instructions].linear for planning, audits, cycles, roadmaps and research completion. (PM-038)
- The numeric estimate is the project-management package's relative size class, and the time beside an item is one nonstop-hours-to-merge figure, per project-management § Disposition. Planned and review-created issues use it. (ORCH-M22)
- Each post-merge Done-when observation names its evidence, location, why the branch cannot prove it, and a deadline after merge but within three days. Linear and orch use this policy. (PM-042)

### Project map

Every vsys issue lives in one project below; the project-management skill's `references/project-map.md` states what each kind holds and the routing order. A create names one of these projects, or holds the item as `project_needed`.

```json
{
  "projects": [
    {"name": "Herdr engine migration", "kind": "deliverable",
     "admits": "Work that implements the reviewed BRAD-109 build, cutover, retirement or consumer verification in this repository.",
     "ends_when": "The planned hosts use Herdr for agent sessions and J3 has verified the allowed tmux remainder and the canonical retirement mappings throughout the repository and render inventory."},
    {"name": "Dashboard", "kind": "standing", "role": "area", "admits": "The dashboard application under src/ other than src/warden.ts, the shared agent-tool data under data/, the scrub and SMART reporters under scripts/, and the TypeScript build, benchmark and Bun toolchain files that build it."},
    {"name": "Warden", "kind": "standing", "role": "area", "admits": "The warden and agent-confine under warden/, and the vsys warden install command in src/warden.ts."},
    {"name": "Review Gate & CI", "kind": "standing", "role": "area", "admits": "CI workflows and settings under .github/, scripts/ci.py and its tests, tools/, and the kendex manifest, settings and rendered harness files that run the review gate, lane validation and the merge rail."},
    {"name": "Packaging & Install Channels", "kind": "standing", "role": "area", "admits": "The packages under packaging/, install.sh, the package file-list check and cutting a release; a workflow file under .github/ goes to Review Gate & CI."},
    {"name": "Docs", "kind": "standing", "role": "area", "admits": "Documentation-only changes to docs/ and the root README.md, DEVELOPMENT.md, AGENTS.md, CHANGELOG.md and LICENSE; a doc change that rides with a code change goes with that code's area."}
  ]
}
```
<!-- kendex:project-instructions:end -->

# Project Management

This skill plans tracker work: cycles, issue audits, roadmaps and research decomposition. An agent that loads it has one of two roles:

- **Primary session.** It runs a wrapper command from § Commands. A wrapper owns the user dialog and every tracker write.
- **Analysis agent.** The `tpm` agent running a TPM workflow, or the [proposal sweep](workflows/proposal-sweep.md) subagent the overseer launches. It returns JSON inline: a TPM workflow to its wrapper, the sweep to the overseer.

## Goals

These goals decide a case that no workflow step covers:

1. The tracker holds only items that pass the creation bar, and containers that group the parts of one deliverable.
2. A lane can pick up, land and prove each item alone.
3. The user decides what work exists, once per decision. The workflow decides the mechanics.

## Disposition

The rules for an item are in [references/filing.md](references/filing.md). Read that file before you judge, write, split or file a tracked item, and at a launch read.

## Commands

| Command | Arguments | Workflow |
|---------|-----------|----------|
| `cycle-plan` | none | [cycle-plan](workflows/cycle-plan.md) |
| `audit-issues` | `project` \| `project "Name"` \| `team` \| `issue [IDs]` \| `--issues [file]` \| `--single [file]` \| `--analyzed [file]` \| `project-order` | [audit-issues](workflows/audit-issues.md) |
| `roadmap plan` | `[feature]` \| `[feature] @[research-or-plan-path]` | [roadmap-plan](workflows/roadmap-plan.md) |
| `roadmap create` | `@[plan-file]` | [roadmap-create](workflows/roadmap-create.md) |
| `research-spike` | none | [research-spike](workflows/research-spike.md) |
| `research-complete` | `[ISSUE_ID]` | [research-complete](workflows/research-complete.md) |
| `research-issue` | none | [research-issue](workflows/research-issue.md) |
| `proposal-sweep` | fleet brief | [proposal-sweep](workflows/proposal-sweep.md) |

- `research-issue` is internal: `research-spike` invokes it.
- `proposal-sweep` is internal: `oversee` invokes it.

## Execution Rules

- Run the sections of a workflow in order.
- Skip a section only on its explicit **Skip if** condition, never on your own judgement of scope.
- `<delegation_format>` and `<output_format>` are literal templates:
  - Fill each `[PLACEHOLDER]`.
  - Remove the lines whose placeholders are empty.
  - Add nothing.
- For a user-visible `<output_format>` report:
  1. Send the report as a normal assistant message first.
  2. Then invoke the question tool separately, with only the question and short option labels.
  3. Never paste the report into the question or its options.
- A failed Linear read halts the workflow with its diagnostic, never a partial result.

## Read when

- When a run writes, cites, hands over or cannot find a plan, research, roadmap or audit file: [references/planning-artifacts.md](references/planning-artifacts.md).
- Before you add or change a mode, a tracker read or a tracker route in a workflow of this package, and when a step resolves or checks the team scope: [references/tracker-reads.md](references/tracker-reads.md).
- When you decide what an initiative, a project or a label holds, which project kind applies, or which project an item goes in: [references/project-map.md](references/project-map.md).
