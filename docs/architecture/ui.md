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
- The footer names the keys the current screen handles and nothing else. The agent detail is its own entry in the shell's `hints` table, because it takes none of the list's keys and adds a way back.
- Colour comes from `src/ui/theme.ts` alone, and each role has one meaning: red, amber and green are severity and nothing else; cyan is what the reader can act on; grey is behind the selected row and under an unfilled bar. `metric` gives each metric family its own hue, used wherever that quantity is drawn on any screen. No screen names a hex value. Every line of text renders through `Line`, because OpenTUI paints text white when no colour is given.
- A reading of zero recedes and a reading keeps its weight, through `readingWeight`. Thirty rows of `0.0%` otherwise compete with the column beside them.
- `src/ui/columns.ts` owns column arithmetic: `fit` pads or cuts to a width and marks a cut with an ellipsis, and one `Column[]` feeds both the heading and the row renderer under it, so a width cannot move one without the other. Every table reads a spec, the Agents table included, where `tableColumn()` builds one per configured column.
- A section is a bold title with a dim rule to the panel edge (`Section`). A box is reserved for what floats above the screen: the notice, the confirmation and the help panel, and each is sized to its own content so no part of the screen behind shows through it.
- `listWindow` is the one answer to which rows a windowed list shows. `List` draws that range and a caller that fetches per visible row reads the same function, so what is fetched and what is drawn cannot disagree. The wheel over a list moves the selection, never the viewport on its own.
- Above `wideWidth` a screen holds two columns: Home puts its concerns and its agents side by side, Agents keeps the selected agent's summary in a right-hand pane, and Settings splits its groups. Below it they stack. `narrowWidth` is the separate threshold at which a list drops the columns it can do without.
- The header reserves the host and the clock, then offers the tabs what is left; the tabs take their own row when that is not enough. `tabsFitOneRow` in `src/ui/chrome.tsx` is the one place that decides, and the shell reads it to know how tall the content area is.
- A chart column with no sample is drawn quietly, and a window vsys has not filled is labelled with the span it holds rather than the span requested (`spanLabel`). A first run is then a screen waiting for data, not a screen reporting none.
- Readings the reader compares are tiles, not a run of clauses joined by dots: Home's meters, the Resources summary and the Timeline cursor all name each quantity above its own number. `tilesHeight` tells a screen how many rows a tile row takes, so a layout can budget for the wrap.
- `src/ui/attention.ts` turns the model's cause ladder and meters into words: the verdict line, one card per cause, and one tile per meter. The model returns numbers; every word and every formatted number lives in the UI.
- A card carries the row it names as a `Target`, and a Home change carries the moment it happened. The shell hands that target to the destination screen, which selects the row and clears the target as it takes it, so opening the same card twice lands twice. A card that names no single row carries none.
- Home shows the verdict, four meter tiles with a sparkline each, the cards, the last few changes with the alerts opened since vsys started, and the busiest agents. Only the selected card shows its detail, its next step and its command, which the copy key puts on the clipboard.
- Agents holds the list, the table, the search and the open agent, so the list selection survives a visit to the detail. The agent detail keeps its processes, launch, open files and actions in closed sections.
- A row's CPU trend is read for the rows on screen and no others, through `useLaneTrends` in `src/ui/agents.tsx`. The requested set is the one judge of whether a series has been asked for, keyed by lane and window and never by time, so a new sample asks the store for nothing. A row still waiting draws blank columns: a placeholder in a chart column is read as a measurement. Each series draws on its own row as it arrives, so the slowest read holds up one row and not the column. The column only appears where the name can spare it, because a name cut back to its account tells one row from the next by nothing.
- The copy key writes an OSC 52 sequence to the process output stream, which reaches the system clipboard over SSH and inside tmux. `src/ui/clipboard.ts` builds it, because the renderer's own OSC 52 call writes through its native core where no test can read what was sent. The payload is base64, so process text in a command cannot close the sequence.
- Actions are the one thing the UI does to the system, and only with `writeMode` on. A screen holds an intent: the action, the lane it named and the line the reader saw, carrying no effect, so nothing a screen keeps can be run. The shell refuses an action while `writeMode` is off or while a past sample is pinned. Otherwise the confirmation stands, and the key that answers it re-derives the command from the current sample through `resolveIntent` in `src/model/actions.ts`; `src/effect.ts` performs it. A lane whose cgroup names no systemd scope gets no actions.
- Resources shows the meter facts, then the cgroup tree with idle leaves hidden until asked. Builds, Storage and Timeline follow the same order: headline tiles or charts first, rows below, raw detail on request.
- Settings lists the probed capabilities and the unreadable sources above the stored settings, grouped by what they change. The probe describes the running program, so the list comes from the live sample even while a past sample is pinned.
- Charts are text: `chartRows` draws a multi-row series in eighths, `sparkline` draws one row, and `bucketPeaks` places samples by time so a collection gap stays visible. Both read the peak of each bucket, so a short spike is never averaged away.
- The UI opens views and exports evidence. It controls an observed process only through a confirmed Freeze, Thaw or Stop with `writeMode` on, and never its terminal session.

## Invariants

- Refresh leaves one screen and a stable listener count. `src/ui/screen.test.tsx` checks repeated updates through the production mount function, followed by unmount.
- Refresh preserves the selected view. `src/ui/screen.test.tsx` checks navigation during updates and a resize.
- Arrow selection pages the list and never moves the viewport. `src/ui/screen.test.tsx` checks the Agents list and the table's horizontal scroll.
- A serious cause that appears between two samples raises one notice and one terminal notification, on whichever view is open, and never a second one for the same cause. `src/ui/screen.test.tsx` checks a mount turning read-only.
- Every visible span uses a default or indexed colour, selection is marked in the accent colour and painted behind, and severity uses red and yellow. `src/ui/theme.test.tsx` checks the rendered spans; `src/ui/widgets.test.tsx` checks that a bare text element is what the guard catches.
- Every colour any screen paints comes from the role table, and no two roles share an index. `src/ui/theme.test.tsx` walks every tab, the agent detail and the help panel and admits no other colour.
- A table's heading and its rows read one column spec. `src/ui/columns.test.ts` checks that a cell and its heading occupy the same columns, and that a cut falls between characters; `src/ui/App.test.tsx` checks the rendered Agents list and the rendered Agents table.
- A key a screen consumes never reaches the shell: a digit typed into the settings editor is text, not a tab. `src/ui/App.test.tsx` checks the editor.
- Home keeps the selected card visible and opens its agent. `src/ui/App.test.tsx` checks a long list in a small terminal.
- Opening a card lands on the row it names: the quota card on its directory in Storage, the memory-threshold card on its group in Resources. `src/ui/attention.test.ts` checks the targets the cards carry; `src/ui/App.test.tsx` checks where the screen lands.
- Home lists the newest change first and opening one lands on Timeline with that time as the cursor, not with the cursor the screen would take on its own. `src/ui/home.test.ts` checks the order and the target; `src/ui/App.test.tsx` checks the landing.
- The Timeline change list is a list: the arrow keys move the selection, Enter moves the time cursor to the selected change, and the selected row shows the raw unit its subject decoded from. `src/ui/App.test.tsx` drives it from the keyboard alone.
- A footer names only keys its screen handles. `src/ui/App.test.tsx` presses every key every screen's footer offers and requires the screen to act on it, and checks the agent detail against the list it sits inside.
- Leaving an agent returns to the list with that agent selected, including one opened from Home. `src/ui/App.test.tsx` checks both routes.
- Home opens on the most urgent row, in the order it lists them: a concern where there is one, else the newest change, else the busiest agent. `src/ui/App.test.tsx` checks all three.
- The tiles are reachable with the arrow keys and with the mouse, and both reach the same screen because both read `meterView`. `src/ui/App.test.tsx` checks all four from the keyboard, all four from a click, and that moving off the tiles returns Enter to the rows.
- A list of forty lanes reads the history of the rows on screen and no others, reads none of them twice, and reads nothing further on a new sample. `src/ui/App.test.tsx` asserts the lane ids the store was asked for, not the rows drawn, so a change that widened the read fails even though the screen would look the same.
- The wheel moves a list's selection by one row and stops at the ends. `src/ui/App.test.tsx` drives it; `src/ui/widgets.test.tsx` pins the window arithmetic the list and its callers share.
- No card offers a command carrying an unresolved value, which would reach the reader as the word `undefined` in text they are invited to run. `src/ui/attention.test.ts` checks every cause.
- A wide terminal puts Home's two lists on one row and Agents' summary beside its list; a narrow one stacks them. `src/ui/App.test.tsx` checks both widths.
- The help panel is the width of its own content at any terminal size, and every row inside its border belongs to it. `src/ui/App.test.tsx` checks two sizes and compares the widths.
- Four tiles wrap rather than squeeze their captions together. `src/ui/widgets.test.tsx` derives the per-row count from the width.
- A chart names the span it holds. `src/ui/format.test.ts` checks a window with one column of samples against a full one.
- The copy key sends the selected command as an OSC 52 sequence and copies nothing when the row carries none. `src/ui/clipboard.test.ts` checks the encoding against planted terminators; `src/ui/App.test.tsx` reads the sequence off a test output stream.
- No agent action reaches an effect while `writeMode` is off or while a past sample is pinned, and otherwise the confirmation stands between the key and the call. `src/ui/App.test.tsx` plants an action hook that must not be called; `src/model/actions.test.ts` pins the exact command of each action; `src/effect.test.ts` drives both effect kinds and a program that exits non-zero.
- A confirmation is answered against the sample of the moment, never the one it opened on. A lane that ended, one whose scope name a later process took, one whose cgroup stopped resolving and one that moved to another scope each refuse and say which, and nothing runs. The command builder is private to `src/model/actions.ts`, so `resolveIntent` is the only exported way to an effect and the tests reach one through it. `src/model/actions.test.ts` covers the five answers; `src/ui/App.test.tsx` lands a sample under an open confirmation and checks both a lane that changed and one that did not.
- A command a reader copies is a shell line: `src/model/shell.ts` quotes every word, so the backslash escapes in a real systemd scope name and a space in a configured path survive the paste. The effect keeps the unquoted values, which is what the kernel and systemd read. `src/model/shell.test.ts` reads each word back through `/bin/sh`.
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
