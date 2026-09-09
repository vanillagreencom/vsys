import { RGBA, TextAttributes } from "@opentui/core";
import type { Level } from "../model/verdict";

/**
 * The terminal's own sixteen colours, by role. No colour here is a hex value,
 * so the dashboard follows whatever scheme the terminal already uses.
 */
export const ui = {
  fg: RGBA.defaultForeground(),
  bg: RGBA.defaultBackground(),
  ok: RGBA.fromIndex(2),
  warn: RGBA.fromIndex(3),
  danger: RGBA.fromIndex(1),
  /** Selection, the active tab, and anything the reader can act on. */
  accent: RGBA.fromIndex(6),
  /** The second series in a chart that compares two lines. */
  second: RGBA.fromIndex(5),
  dim: TextAttributes.DIM,
  bold: TextAttributes.BOLD,
  none: TextAttributes.NONE,
} as const;

/** A quiet scrollbar: a grey thumb on the terminal's own background. */
export const scrollbar = {
  trackOptions: {
    foregroundColor: RGBA.fromIndex(8),
    backgroundColor: RGBA.defaultBackground(),
  },
};
/** The colour a severity paints; an untroubled reading keeps the default colour. */
export function levelColor(level: Level): RGBA {
  return level === "danger" ? ui.danger : level === "warn" ? ui.warn : ui.fg;
}
