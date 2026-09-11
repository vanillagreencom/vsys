# UI

Covers: src/ui/ src/main.ts src/effect.ts

The screen owns one mounted React tree, and collection publishes a stable snapshot into it. Navigation, selection, search and editing belong to that tree and survive a sample. The model hands the UI numbers; every word and every formatted number is written here.

## Terms

Shell: the header with the tabs, the content area and the footer. `App` in `src/ui/App.tsx` is the shell.

Screen: what one tab shows. There are seven, one file each under `src/ui/`, named for the tab.

Drill-down: detail a screen shows only after the reader selects a row or opens a section.

Notice: a bordered box in the top-right corner naming a new serious cause, which also goes out as a desktop notification.

Region: a range over the one flat selection a screen draws. `src/ui/regions.ts` holds the arithmetic.

Target: the row a card names, handed to the destination screen, which selects it and clears it as it takes it.

## Boundaries

- `mountScreen` in `src/ui/screen.tsx` owns the React root and the subscription between collection and display. It mounts once and unmounts on shutdown.
- The shell owns the one keyboard subscription. A screen registers a handler through `useScreenKeys` and sees each key first, so an open search box or editor takes every key.
- The footer names the keys the current screen handles and nothing else. The `hints` table in `src/ui/App.tsx` gives the agent detail and a vanished agent their own entries, because neither takes the list's keys.
- Colour comes from `src/ui/theme.ts` alone, one meaning per role: red, amber and green are severity; cyan is what the reader can act on; grey sits behind the selected row. `metric` gives each quantity its own hue wherever it is drawn. No screen names a hex value, and every line renders through `Line`, because OpenTUI paints text in the terminal foreground when no colour is given.
- `readingWeight` lets a zero recede and keeps a reading's weight, so thirty rows of `0.0%` do not compete with the column beside them.
- `src/ui/columns.ts` owns column arithmetic. `fit` pads or cuts to a width and marks a cut, and one `Column[]` feeds both a heading and the rows under it, so a width cannot move one without the other.
- A screen's lists are regions of one flat selection. Up and down move inside the region in focus; the region key, left and right, and each region's own key move between regions and never between screens. An empty region is skipped. Home has four regions and its tile row is the first; Storage has three. `homeRegions` and `storageRegions` pair each key with the title the heading, the Settings label and the help panel all read.
- `Detail` draws a line that expands under another: a rule down its left edge, then an indent. The indent alone would read as a new top-level line, so the rule is what says whose line this is. One helper draws every such site.
- A name holds the name. Nothing is appended to make one unique; `pidColumn` and `pidCell` put the process id in a column of its own on every view that draws lane names, so two lanes reading alike are still two rows a reader can separate. A narrowing list gives up its readings first and what names a row last, and never the process id.
- `sortedLabel` marks the sorted heading. The arrow leads a numeric column so the heading still ends where its digits do, and follows the word on a text column.
- `Disclosure` marks a row with more inside it: `▸` closed, `▾` open, the count beside the name. It is drawn whether or not anything is open, so a reader can see what is worth opening.
- `heldOrder` in `src/ui/hold.ts` holds a list's row order while its readings keep moving. Holding the order is not freezing the data. No heading carries a sort arrow while it holds, and leaving the screen or asking for another order releases it.
- `listWindow` is the one answer to which rows a windowed list shows, read by both the renderer and any caller fetching per visible row. The wheel over a list moves the selection, never the viewport alone.
- Above `wideWidth` a screen holds two columns and below it they stack. `narrowWidth` is the separate threshold at which a list drops the columns it can do without. Both live in `src/ui/chrome.tsx`, with `tabsFitOneRow` deciding whether the tabs share the header row.
- `chartRows`, `sparkline` and `bucketPeaks` draw charts as text. Both chart forms read the peak of each bucket, so a short spike is never averaged away, and `bucketPeaks` places samples by time so a collection gap stays visible. `spanLabel` labels a window vsys has not filled with the span it holds, so a first run reads as a screen waiting for data.
- `src/ui/attention.ts` turns the cause ladder and the meters into the verdict line, one card per cause and one tile per meter.
- A missing capability says what it costs rather than which interface failed: the readings it feeds are blank, never zero, because a dashboard showing zero for a number it could not read is lying. The interface and the system's own words stay in the drill-down.
- Actions are the one thing the UI does to the system. A screen holds a `LaneIntent` carrying no effect, so nothing it keeps can be run; `resolveIntent` in `src/model/actions.ts` is the only exported way to a command, and `runEffect` performs it. A lane whose cgroup names no scope gets no actions. See [D003](../decisions/D003-action-resolved-at-the-keypress.md).
- The copy key writes an OSC 52 sequence built by `src/ui/clipboard.ts`, which reaches the system clipboard over SSH and inside tmux. The payload is base64, so text in a command cannot close the sequence. See [D001](../decisions/D001-clipboard-sequence.md).
- A tmux pane id is a server handle that names no window a reader can place, so it stays on the lane as the handle an action addresses and never enters a name. The resolved `session:window.pane` address is a column of its own.
- The agent detail reads its pane only while the Terminal section is open, and again on each sample. Captured text is the agent's own output, so complete escape sequences are dropped and every remaining control byte is removed. Reading a pane and moving the reader's tmux view change no process, so neither waits on write mode; the switch is offered only from inside the server holding the pane, and no terminal emulator is ever launched.

## Invariants

1. Repeated refresh leaves one screen, a stable listener count and the selected view, and arrow selection pages a list without moving the viewport. `src/ui/screen.test.tsx` drives the production mount function; `src/ui/agents.test.tsx` checks the table's horizontal scroll.
2. A serious cause appearing between two samples raises one notice and one terminal notification, on whichever view is open. `src/ui/screen.test.tsx` turns a mount read-only.
3. Every colour any screen paints comes from the role table, no two roles share an index, and selection is painted behind in the accent colour. `src/ui/theme.test.tsx` walks every tab, the agent detail and the help panel and admits no other colour.
4. A table's heading and its rows read one column spec, and a cut falls between characters rather than through one. `src/ui/columns.test.ts` pins the arithmetic; `src/ui/agents.test.tsx` checks the rendered list and table.
5. A footer names only keys its screen acts on. `src/ui/App.test.tsx` presses every key every footer offers and requires the screen to act on it.
6. The region key, the arrows and a region's own key move within a screen and never between screens, and a key for an empty region changes nothing. `src/ui/regions.test.ts` pins the arithmetic; `src/ui/home.test.tsx` and `src/ui/storage-screen.test.tsx` walk their regions and read back which title is lit; `src/ui/App.test.tsx` checks that the region key changes no screen.
7. Right from the last tile enters the first list with a row, and left from the first list returns to the last tile, so each arrow undoes the other. `src/ui/home.test.tsx` crosses between the tiles and the lists both ways.
8. A row with anything drawn under it is kept in view, and which rows those are is read from the drawn tree rather than a list of what opens. `src/ui/settings-screen.test.tsx` opens an editor, a picker, a source's reason and a setting's help sentence.
9. Every line that expands under another carries the rule and the indent, because they all go through one helper. `src/ui/home.test.tsx`, `src/ui/settings-screen.test.tsx`, `src/ui/storage-screen.test.tsx` and `src/ui/agent.test.tsx` check one site each.
10. A key a screen consumes never reaches the shell, so a digit typed into the settings editor is text rather than a tab. `src/ui/settings-screen.test.tsx` checks the editor.
11. Home opens on the most urgent row it lists: a concern where there is one, else the newest change, else the busiest agent. `src/ui/home.test.tsx` checks all three.
12. Opening a card lands on the row it names, and a card that names no single row carries none. `src/ui/attention.test.ts` checks the targets the cards carry; `src/ui/home.test.tsx` checks where the screen lands.
13. No card offers a command carrying an unresolved value, which would reach the reader as the word `undefined` in text they are invited to run. `src/ui/attention.test.ts` checks every cause.
14. A held order keeps its rows while their numbers move, drops a lane that ended, refuses one that climbed, and is released by leaving the screen or asking for another order. `src/ui/hold.test.tsx` and `src/ui/home.test.tsx` swap the readings under a hold and read the rows back.
15. No list of lane names draws two rows a reader cannot tell apart: every row carries its process id at every width, and text that names a lane carries it after the name. `src/ui/home.test.tsx` renders six lanes named alike at six widths across Home, the Agents list, the Agents table and Builds; `src/ui/agents.test.tsx` checks that both rows draw their ids at the same offset.
16. A narrowing list gives up its readings before what names a row, and never the process id or the name. `src/ui/agents.test.tsx` checks four widths.
17. A list reads the history of the rows on screen and no others, and only where the trend column is drawn. The read and the render share one quantised moment, so a sample costs no read and a read still in flight cannot overwrite a newer one. `src/ui/agents.test.tsx` asserts the lane ids the store was asked for rather than the rows drawn.
18. A cut row ends in its mark, and what a cut row loses is whole in the detail under it. `src/ui/home.test.tsx` checks a change subject longer than any column it could be given; `src/ui/settings-screen.test.tsx` checks a capability's cost against its whole sentence.
19. The help panel is the width of its own content at any terminal size, and every row inside its border belongs to it. `src/ui/App.test.tsx` checks two sizes and compares the widths.
20. A narrow terminal gives the tabs their own row and drops the wait column. `src/ui/App.test.tsx` drives it.
21. Search filters every field a reader can see, including the pane address and the tmux window, so typing what the screen shows finds the row showing it. `src/ui/agents.test.tsx` checks each field and clearing the filter.
22. Leaving an agent returns to the list with that agent selected, including one opened from Home. `src/ui/agents.test.tsx` checks both routes.
23. The copy key sends the selected command as an OSC 52 sequence and copies nothing when the row carries none. `src/ui/clipboard.test.ts` checks the encoding against planted terminators; `src/ui/home.test.tsx` reads the sequence off a test output stream.
24. What a pane drew cannot move the cursor, repaint the screen or write the clipboard, and the pane is read only while its section is open. `src/collect/tmux.test.ts` feeds it a screen clear and a clipboard write; `src/ui/agent.test.tsx` counts the captures across a closed section, an open one and a new sample.
25. The switch to a terminal is offered only from inside the server holding the pane; outside it the command is copied instead, and no path launches a terminal emulator. `src/ui/agent.test.tsx` checks both.
26. Process text cannot emit terminal controls. `src/ui/format.test.ts` checks the display sanitizer.
27. Terminal settings are restored on quit and on a failed shutdown alike. `src/main.test.ts` drives isolated terminals.
