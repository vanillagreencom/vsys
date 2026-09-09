# UI behaviour

Covers: src/ui/ src/main.ts src/main.test.ts

The screen owns one mounted React tree. Collection publishes a stable snapshot to that tree. Navigation, selection, search and editing belong to the mounted application and survive a sample update.

## Boundaries

- `mountScreen` owns the React root and the subscription between collection and display. It mounts once and unmounts on shutdown.
- Builds renders the model's build summary. It shares the fleet-total sentence with the Overview build meter, so the two screens cannot report different numbers.
- Overview renders the model's cause ladder. The worst cause that speaks for the machine is the verdict line and each cause is one card. All copy and all byte and percent formatting live here; the model returns numbers. Alert history can contain resolved events and cannot define current health.
- A quantity vsys could not read makes its meter a warning and renders as "not available", never as a question mark or an untroubled reading. Fleet columns and Lane detail read the same formatters.
- Attention cards are grouped by cause. Each card names its subjects, a next step, and where possible a read-only command built from configured names.
- Storage opens with bytes written since boot, by slice and by device, and the drive lifetime writes. Mount state, device counters, scrub reports and scratch sizes follow below them. `src/ui/App.test.tsx` checks that order.
- Fleet owns selection and vertical paging. The scroll box owns horizontal table scrolling. Other detail views use native vertical scrolling.
- The UI opens views and exports evidence. It does not control observed processes or their terminal sessions.

## Invariants

- Refresh leaves one screen and a stable listener count. `src/ui/screen.test.tsx` checks repeated updates through the production mount function, followed by unmount.
- Refresh preserves the selected view. `src/ui/screen.test.tsx` checks navigation during updates and a resize.
- Arrow selection does not also move the Fleet viewport. `src/ui/screen.test.tsx` checks both summary paging and full-table scrolling.
- The Builds view leads with the fleet total, then the per-lane rows, then the build cache and token pools. `src/ui/builds.test.ts` checks that order and the absence of question marks in unknown quantities.
- Overview keeps the selected concern visible. `src/ui/App.test.tsx` checks a long list in a small terminal and opening the selected lane.
- Lane detail names the account, the pane, the cgroup, the charged resources, the build work by kind, the effective caps and the blocked reason. `src/ui/App.test.tsx` checks the rendered lane.
- Unreadable lane quantities render as "not available", an unread memory cap is never shown as unlimited, and a blocked lane names its waiting task count and resource. `src/ui/format.test.ts` checks the lane formatters.
- Search filters names, accounts, panes, window titles, worktrees, branches and tools. `src/ui/App.test.tsx` checks a worktree search and clearing the filter.
- A recorded event alone does not become a current concern. `src/ui/overview.test.ts` checks resolved events and missing source data.
- An unreadable write total renders as "not available" rather than an empty row, and every drive keeps its own lifetime row so the reader can tell which drive lacks a report. `src/ui/storage.test.ts` checks every write section with no readable source.
- A device-mapper row and the disk beneath it count the same bytes, and the device section says so when one is present. `src/ui/storage.test.ts` checks that line.
- No attention text is repeated. `src/ui/overview.test.ts` and `src/ui/App.test.tsx` check unique card titles across every cause.
- Terminal restoration also runs on failed shutdown. `src/main.test.ts` checks isolated terminals and keeps the application alive through repeated refreshes to detect listener warnings.

## Framework constraint

The installed OpenTUI React root creates a reconciler container each time its `render` method is called. Calling it for every sample leaves previous trees mounted. Live data therefore enters through React's external-store subscription after the initial mount. The production-path listener test must remain in place when this dependency changes.
