# Every screen is drawn from shared rules

Read before drawing a screen, a row, a column, a colour, a card, or anything the reader can act on.

## The approach

`mountScreen` in `src/ui/screen.tsx` owns one mounted React tree. Collection publishes a stable snapshot into it, and navigation, selection, search and editing survive a sample. Every word and every formatted number is written in `src/ui/`. Colour comes from the role table in `src/ui/theme.ts`, column arithmetic from `src/ui/columns.ts`, regions from `src/ui/regions.ts`, selection from `useSelection` in `src/ui/selection.ts`, and every selectable row from `ListRow` in `src/ui/widgets.tsx`. The shell is the header with the tabs, the content area and the footer; a screen is what one tab shows, one file each under `src/ui/`. The copy key writes an OSC 52 sequence built in `src/ui/clipboard.ts` ([D001](../decisions/D001-clipboard-sequence.md)).

## Why

One role table is the only place a colour changes. One column spec feeding both a heading and its rows means a width cannot move one without the other. A list that draws two rows a reader cannot tell apart, or a zero for a number it could not read, misleads the person deciding which agent to stop.

## Rules

- Do take every colour from `src/ui/theme.ts`: red, amber and green are severity, cyan is what the reader can act on, and grey sits behind the selection. `src/ui/theme.test.tsx` walks every tab and admits no other colour.
- Do render every line through `Line` in `src/ui/widgets.tsx`, because OpenTUI paints text in the terminal foreground when no colour is given.
- Do feed a heading and its rows one `Column[]`, and end a cut row in its mark with the whole text in the detail under it. `src/ui/columns.test.ts` pins the arithmetic.
- Do put the process id in `pidColumn` on every view that draws lane names. `src/ui/home.test.tsx` renders six lanes named alike at six widths.
- Do draw a line that expands under another through `Detail`: a rule down its left edge, then an indent. `src/ui/App.test.tsx` compares the column across screens.
- Do register a screen's keys through `useScreenKeys` in `src/ui/keys.tsx`, so an open editor takes every key first, and name in the footer only the keys the screen acts on. `src/ui/App.test.tsx` presses every key every footer offers.
- Do follow a selection by item identity through `useSelection`, so an arrival at the same row number cannot take the highlight.
- Do measure a grown row on the renderer's next frame event, never on a timer. A test that reads where a screen scrolled calls `settle()` from `src/test/harness.tsx` first.
- Do wrap card copy at the card's own width through `detailWidth` in `src/ui/chrome.tsx` and `capLines`, so the renderer never wraps a row the screen did not count. `src/ui/attention.test.ts` fits every cause at several rooms and widths.
- Do sanitize process text before drawing it. `src/ui/format.test.ts` checks that it cannot emit terminal controls.
- Do restore the terminal on quit and on a failed shutdown alike. `src/main.test.ts` hangs a terminal up and sends a terminate signal.
- Never name a colour value in a screen.
- Never draw a zero for a reading that is null ([layers.md](layers.md)).
- Never let a screen hold an effect. It holds a `LaneIntent` ([lane-actions.md](lane-actions.md)).
- Never let a warning past the test gate. `src/test/warnings.ts`, preloaded by `bunfig.toml`, fails any test during which something wrote to `console.error` or `console.warn`, so the suites run from the repository root.

## The canonical example

`src/ui/builds-screen.tsx`: one `Column[]` for heading and rows, every colour from the role table, the process id in its own column, and every number formatted here from the model's figures. Copy it for a new screen.

## Revisit when

A platform vsys must draw on cannot read the role table, or a screen needs a state the shared components cannot draw.

## Not governed

What a card says and which rows a screen lists. A screen composes the shared parts as its subject needs, and the words follow [layers.md](layers.md).
