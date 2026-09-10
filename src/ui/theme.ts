import { RGBA, TextAttributes } from "@opentui/core";
import type { Level } from "../model/verdict";

/**
 * The terminal's own sixteen colours, by role. No colour here is a hex value,
 * so the dashboard follows whatever scheme the terminal already uses. Each
 * role has one meaning and no screen may borrow it for another: red, amber and
 * green are severity, and cyan is what the reader can act on.
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
  /** Behind the selected row, and the unfilled part of a bar. */
  quiet: RGBA.fromIndex(8),
  dim: TextAttributes.DIM,
  bold: TextAttributes.BOLD,
  none: TextAttributes.NONE,
} as const;
/**
 * One hue per metric family. The same quantity is drawn in the same colour on
 * Home, the agent detail and Timeline, so a reader comparing two screens is
 * comparing the same thing. These are not severity: how bad a reading is comes
 * from `levelColor` alone.
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
/** A quiet scrollbar: a grey thumb on the terminal's own background. */
export const scrollbar = {
  trackOptions: {
    foregroundColor: ui.quiet,
    backgroundColor: ui.bg,
  },
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
