# UI behaviour

Covers: src/ui/ src/main.ts src/main.test.ts

The screen owns one mounted React tree. Collection publishes a stable snapshot to that tree. Navigation, selection, search and editing belong to the mounted application and survive a sample update.

## Terms

- Shell: the header with the tabs, the content area and the footer. `App` in `src/ui/App.tsx` is the shell.
- Screen: what one tab shows. Each screen is one file under `src/ui/`, named for its tab.
- Drill-down: detail a screen shows only after the reader selects a row or opens a section: an agent's processes, a filesystem's error counters, the sources vsys cannot read.
- Notice: a bordered box in the top-right corner that names a new serious cause and goes away by itself. The same text goes to the terminal as a desktop notification.
- Pinned sample: the recorded sample selected by the timeline cursor. Agents, Resources, Builds and Storage show it; Home, Timeline and Settings stay live.

## Boundaries

- `mountScreen` owns the React root and the subscription between collection and display. It mounts once and unmounts on shutdown.
- The shell owns the one keyboard subscription. A screen registers a handler through `useScreenKeys` and sees each key first; a handler that returns true keeps the key from the shell's bindings, so an open search box or editor takes every key.
- Colour comes from `src/ui/theme.ts` alone: the terminal's default foreground and background, the sixteen indexed colours, and the bold and dim attributes. No screen names a hex value. Every line of text renders through `Line`, because OpenTUI paints text white when no colour is given.
- `src/ui/attention.ts` turns the model's cause ladder and meters into words: the verdict line, one card per cause, and one tile per meter. The model returns numbers; every word and every formatted number lives in the UI.
- Home shows the verdict, four meter tiles with a sparkline each, the cards, and the busiest agents. Only the selected card shows its detail, its next step and its copy-only command.
- Agents holds the list, the table, the search and the open agent, so the list selection survives a visit to the detail. The agent detail keeps its processes, launch and open files in closed sections.
- Resources shows the meter facts, then the cgroup tree with idle leaves hidden until asked. Builds, Storage and Timeline follow the same order: headline tiles or charts first, rows below, raw detail on request.
- Settings lists the probed capabilities and the unreadable sources above the stored settings, grouped by what they change. The probe describes the running program, so the list comes from the live sample even while a past sample is pinned.
- Charts are text: `chartRows` draws a multi-row series in eighths, `sparkline` draws one row, and `bucketPeaks` places samples by time so a collection gap stays visible. Both read the peak of each bucket, so a short spike is never averaged away.
- The UI opens views and exports evidence. It does not control observed processes or their terminal sessions.

## Invariants

- Refresh leaves one screen and a stable listener count. `src/ui/screen.test.tsx` checks repeated updates through the production mount function, followed by unmount.
- Refresh preserves the selected view. `src/ui/screen.test.tsx` checks navigation during updates and a resize.
- Arrow selection pages the list and never moves the viewport. `src/ui/screen.test.tsx` checks the Agents list and the table's horizontal scroll.
- A serious cause that appears between two samples raises one notice and one terminal notification, on whichever view is open, and never a second one for the same cause. `src/ui/screen.test.tsx` checks a mount turning read-only.
- Every visible span uses a default or indexed colour, selection is marked in the accent colour, and severity uses red and yellow. `src/ui/theme.test.tsx` checks the rendered spans; `src/ui/widgets.test.tsx` checks that a bare text element is what the guard catches.
- A key a screen consumes never reaches the shell: a digit typed into the settings editor is text, not a tab. `src/ui/App.test.tsx` checks the editor.
- Home keeps the selected card visible and opens its agent. `src/ui/App.test.tsx` checks a long list in a small terminal.
- Agent detail names the account, the pane, the cgroup, the charged resources, the build work by kind, the effective limits and the blocked reason, and keeps its process tree closed until opened. `src/ui/App.test.tsx` checks the rendered detail.
- Unreadable lane quantities render as "not available", an unread memory cap is never shown as unlimited, and a blocked lane names its waiting task count and resource. `src/ui/format.test.ts` checks the lane formatters.
- Search filters names, accounts, panes, window titles, worktrees, branches and tools. `src/ui/agents.test.ts` checks each field; `src/ui/App.test.tsx` checks clearing the filter.
- A recorded event alone does not become a current concern. `src/ui/attention.test.ts` checks resolved events and missing source data.
- Storage leads with bytes written, then filesystems, scrub reports and scratch. `src/ui/App.test.tsx` checks the order and a read-only mount; `src/ui/storage-screen.test.ts` checks the selectable rows and the filesystem severity.
- Every setting sits in exactly one group. `src/ui/settings-screen.test.ts` derives the expected set from the defaults.
- The Timeline change list names the cause of each change, takes one row per event, and stops at the rows the viewport has. `src/ui/App.test.tsx` checks a lane start with an open alert, twelve events in a short terminal, and a 400-character subject.
- A narrow terminal moves the tabs to their own row and drops the wait column; a short one drops the Timeline sparklines but keeps the change list. `src/ui/App.test.tsx` checks 80 columns.
- Process text cannot emit terminal controls. `src/ui/format.test.ts` checks the display sanitizer.
- Terminal restoration also runs on failed shutdown. `src/main.test.ts` checks isolated terminals and keeps the application alive through repeated refreshes to detect listener warnings.

## Framework constraint

The installed OpenTUI React root creates a reconciler container each time its `render` method is called. Calling it for every sample leaves previous trees mounted. Live data therefore enters through React's external-store subscription after the initial mount. The production-path listener test must remain in place when this dependency changes.
