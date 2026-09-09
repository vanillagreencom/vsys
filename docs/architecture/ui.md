# UI behaviour

Covers: src/ui/ src/main.ts src/main.test.ts

The screen owns one mounted React tree. Collection publishes a stable snapshot to that tree. Navigation, selection, search and editing belong to the mounted application and survive a sample update.

## Boundaries

- `mountScreen` owns the React root and the subscription between collection and display. It mounts once and unmounts on shutdown.
- Overview renders the model's cause ladder. The worst cause that speaks for the machine is the verdict line and each cause is one card. All copy and all byte and percent formatting live here; the model returns numbers. Alert history can contain resolved events and cannot define current health.
- Attention cards are grouped by cause. Each card names its subjects, a next step, and where possible a read-only command built from configured names.
- Fleet owns selection and vertical paging. The scroll box owns horizontal table scrolling. Other detail views use native vertical scrolling.
- The UI opens views and exports evidence. It does not control observed processes or their terminal sessions.

## Invariants

- Refresh leaves one screen and a stable listener count. `src/ui/screen.test.tsx` checks repeated updates through the production mount function, followed by unmount.
- Refresh preserves the selected view. `src/ui/screen.test.tsx` checks navigation during updates and a resize.
- Arrow selection does not also move the Fleet viewport. `src/ui/screen.test.tsx` checks both summary paging and full-table scrolling.
- Overview keeps the selected concern visible. `src/ui/App.test.tsx` checks a long list in a small terminal and opening the selected lane.
- Search filters names, accounts, worktrees, branches and tools. `src/ui/App.test.tsx` checks a worktree search and clearing the filter.
- A recorded event alone does not become a current concern. `src/ui/overview.test.ts` checks resolved events and missing source data.
- No attention text is repeated. `src/ui/overview.test.ts` and `src/ui/App.test.tsx` check unique card titles across every cause.
- Terminal restoration also runs on failed shutdown. `src/main.test.ts` checks isolated terminals and keeps the application alive through repeated refreshes to detect listener warnings.

## Framework constraint

The installed OpenTUI React root creates a reconciler container each time its `render` method is called. Calling it for every sample leaves previous trees mounted. Live data therefore enters through React's external-store subscription after the initial mount. The production-path listener test must remain in place when this dependency changes.
