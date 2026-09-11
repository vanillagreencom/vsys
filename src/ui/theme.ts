import { RGBA, TextAttributes } from "@opentui/core";
import type { Level } from "../model/verdict";

/**
 * The terminal's own colours, by role. Every colour here is the terminal's
 * default foreground or background or one of its sixteen numbered colours,
 * never an rgb value, so the dashboard follows whatever scheme the terminal
 * uses, dark or light. Each role has one meaning and no screen may borrow it
 * for another: red, yellow and green are severity, and cyan is what the reader
 * can act on. Each index is the one nearly every scheme gives that meaning:
 * compilers and shells print errors in 1, success in 2 and warnings in 3, and
 * 6 is the usual colour of a link or a key hint.
 */
export const ui = {
  fg: RGBA.defaultForeground(),
  bg: RGBA.defaultBackground(),
  /** Healthy. */
  ok: RGBA.fromIndex(2),
  /** Warning. */
  warn: RGBA.fromIndex(3),
  /** Danger. */
  danger: RGBA.fromIndex(1),
  /** Selection, the active tab, a copyable command, a key hint. */
  accent: RGBA.fromIndex(6),
  /**
   * Bright black: the grey of comments in most schemes. It paints only what
   * can recede without loss: text dragged over with the mouse, the rule beside
   * nested rows, a scrollbar thumb, a placeholder. Text a reader must read
   * never takes it, because some schemes, Solarized among them, make it the
   * background; such text is the default foreground with `dim`.
   */
  quiet: RGBA.fromIndex(8),
  dim: TextAttributes.DIM,
  bold: TextAttributes.BOLD,
  none: TextAttributes.NONE,
  /**
   * The selected row: reverse video, bold. The terminal swaps the scheme's own
   * text and background colours, the one pair every scheme makes readable
   * against each other, where any numbered colour behind the row is dark in
   * some schemes and light in others.
   */
  selected: TextAttributes.INVERSE | TextAttributes.BOLD,
} as const;
/**
 * One hue per metric family. The same quantity is drawn in the same colour on
 * Home, the agent detail and Timeline, so a reader comparing two screens is
 * comparing the same thing. These are not severity: how bad a reading is comes
 * from `levelColor` alone. Blue and magenta are the hues severity and action
 * leave free, so disk and builds take their bright variants. A scheme whose
 * bright colours equal their base draws disk like CPU and builds like memory,
 * which is why every chart carries its name.
 */
export const metric = {
  cpu: RGBA.fromIndex(4),
  memory: RGBA.fromIndex(5),
  disk: RGBA.fromIndex(12),
  builds: RGBA.fromIndex(13),
} as const;
export type MetricId = keyof typeof metric;
/** Every colour a screen may paint, for the guard that admits no other. */
export const palette: RGBA[] = [
  ...Object.values(ui).filter((value): value is RGBA => value instanceof RGBA),
  ...Object.values(metric),
];
/**
 * A quiet scrollbar: a grey thumb on the terminal's own background. OpenTUI's
 * own is a fixed grey on a fixed near-black, so every scroll box passes this
 * as `scrollbarOptions`, which reaches both of its bars.
 */
export const scrollbar = {
  trackOptions: {
    foregroundColor: ui.quiet,
    backgroundColor: ui.bg,
  },
};
/**
 * The colours of a text input. OpenTUI's own are fixed white text, a fixed
 * grey placeholder and a fixed white cursor, so every input spreads these.
 * The default foreground as the cursor colour hands the cursor back to the
 * terminal. OpenTUI draws a selection by swapping the text's two colours,
 * which for the terminal's two defaults changes nothing, so a selection takes
 * the selected row's grey.
 */
export const textInput = {
  textColor: ui.fg,
  focusedTextColor: ui.fg,
  backgroundColor: ui.bg,
  focusedBackgroundColor: ui.bg,
  placeholderColor: ui.quiet,
  cursorColor: ui.fg,
  selectionBg: ui.quiet,
};
/** The colour a severity paints; an untroubled reading keeps the default colour. */
export function levelColor(level: Level): RGBA {
  return level === "danger" ? ui.danger : level === "warn" ? ui.warn : ui.fg;
}
/**
 * A reading of zero recedes. Thirty rows of `0.0%` are noise that competes
 * with the column beside them, and a missing reading is as quiet as a zero:
 * both are "nothing happening here", so both take the dim attribute.
 */
export function readingWeight(n: number | null | undefined): number {
  return n ? ui.none : ui.dim;
}
