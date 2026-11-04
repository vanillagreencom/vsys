# Screen composition

Read before drawing a screen, row, column, colour, card or control.

## The approach

Mount one React tree through `mountScreen` in `src/ui/screen.tsx` and publish samples into it. Keep interaction state across refreshes. Screens compose shared theme roles, columns, regions, selection and rows; they do not invent separate versions of those rules.

## Why

Shared layout keeps headings aligned with rows and a selected identity attached to the reader's choice. Shared colours and unknown-value rendering keep the same reading recognizable across screens.

## Rules

Review holds boundaries without a named check.

- Take every colour from `src/ui/theme.ts`. Severity uses red, amber and green; actions use cyan; grey recedes behind selection. Never put colour values in screens. `src/ui/theme.test.tsx` checks the palette across views.
- Render lines through `Line` in `src/ui/widgets.tsx`; OpenTUI otherwise uses a fixed foreground.
- Feed headings and rows one `Column[]`. Mark a cut and show the whole text in detail. `src/ui/columns.test.ts` checks column arithmetic.
- Use `pidColumn` from `src/ui/columns.ts` on every lane-name view. `src/ui/home.test.tsx` checks identity columns across views and widths.
- Draw every selectable row through `ListRow` and expanded content through `Detail` in `src/ui/widgets.tsx`. Preserve the rule and indent that distinguish nested content. `src/ui/App.test.tsx` checks shared nesting.
- Register screen keys through `useScreenKeys` in `src/ui/keys.tsx` so an editor receives keys first. List only effective keys in the footer. `src/ui/App.test.tsx` checks offered keys.
- Follow item identity through `useSelection` in `src/ui/selection.ts`. A new item reusing a row number must not take the selection.
- Measure changed layout on the renderer's next frame event, never a timer. Scroll-position tests call `settle()` in `src/test/harness.tsx` before reading layout.
- Fit card copy to its actual width through `detailWidth` in `src/ui/chrome.tsx` and `capLines` in `src/ui/columns.ts`. Never leave wrapping to the renderer after budgeting rows. `src/ui/attention.test.ts` checks fit.
- Sanitize process text before drawing it. `src/ui/format.test.ts` checks control-byte removal.
- Restore the terminal on quit and failed shutdown. `src/main.test.ts` checks exit and signal paths.
- Keep clipboard construction under [D001](../decisions/D001-clipboard-sequence.md).
- Never draw zero for an unread value or let a screen hold an effect. Follow [layers.md](layers.md) and [lane-actions.md](lane-actions.md).
- Keep the warning gate in `src/test/warnings.ts` active through `bunfig.toml`. Run suites from the repository root; warnings must fail the run.

## The canonical example

Copy `src/ui/builds-screen.tsx`: one column specification for headings and rows, theme roles, an independent process-id column and UI formatting of model readings.

## Revisit when

A supported terminal cannot use the role table or a screen requires state the shared components cannot represent.

## Not governed

Which rows and words a screen needs. Layer boundaries remain in [layers.md](layers.md).
