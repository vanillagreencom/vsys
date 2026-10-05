import { safe } from "../model/export";

/**
 * One column of a table: what its heading says, how wide it is, and which side
 * its value sits on. A column with no heading carries a bar or a marker.
 */
export interface Column {
  label: string;
  width: number;
  /** Numbers are read down their last digit, so they sit right. */
  align?: "right";
}
/** The blank between two cells, in the heading and in every row under it. */
export const columnGap = "  ";
/** A cut is marked, so a shortened name is never mistaken for a whole one. */
const ellipsis = "…";
/**
 * The terminal cells `text` draws into once sanitized, which is how every
 * screen draws it: a CJK character or an emoji takes two, a combining mark
 * none, and a control byte one, as the blank that replaces it. The renderer
 * measures drawn text natively, by its own width method; this is the
 * JavaScript-side measure of it, and `src/ui/home.test.tsx` checks the two
 * agree on CJK and control-byte rows.
 */
export const textWidth = (text: string): number => Bun.stringWidth(safe(text));
/** One character as the terminal draws it, and the cells it takes. */
interface Glyph {
  text: string;
  cells: number;
}
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/**
 * `text` sanitized and split into the characters a cut or a wrap may fall
 * between. A character is a grapheme, so a flag or a joined emoji is never
 * split into halves that draw as something else.
 */
function glyphs(text: string): Glyph[] {
  const drawn = safe(text);
  // Printable ASCII is one cell a character, and nearly every cell a table
  // draws is ASCII: it skips the segmenter, which costs more than the cut.
  if (/^[\x20-\x7e]*$/.test(drawn))
    return Array.from(drawn, (char) => ({ text: char, cells: 1 }));
  return Array.from(graphemes.segment(drawn), ({ segment }) => ({
    text: segment,
    cells: textWidth(segment),
  }));
}
const cellsOf = (drawn: Glyph[]): number =>
  drawn.reduce((total, glyph) => total + glyph.cells, 0);
const textOf = (drawn: Glyph[]): string =>
  drawn.map((glyph) => glyph.text).join("");
/** Where the longest run of `drawn` from `from` that fits `cells` ends. */
function reach(drawn: Glyph[], from: number, cells: number): number {
  let used = 0;
  let to = from;
  for (
    let glyph = drawn[to];
    glyph !== undefined && used + glyph.cells <= cells;
    glyph = drawn[++to]
  )
    used += glyph.cells;
  return to;
}
/** `text` beside the blanks that bring it to `width` cells, on its side. */
const pad = (text: string, width: number, align?: Column["align"]) => {
  const padding = " ".repeat(Math.max(0, width - textWidth(text)));
  return align === "right" ? `${padding}${text}` : `${text}${padding}`;
};
/**
 * Pad or cut `text` to exactly `width` terminal cells. A cut falls between
 * characters, and a wide character with only one cell left before the mark
 * gives that cell up as a blank rather than draw past the column.
 */
export function fit(
  text: string,
  width: number,
  align?: Column["align"],
): string {
  if (width <= 0) return "";
  const drawn = glyphs(text);
  if (cellsOf(drawn) <= width) return pad(textOf(drawn), width, align);
  const kept = textOf(drawn.slice(0, reach(drawn, 0, width - 1)));
  return pad(`${kept}${ellipsis}`, width, align);
}
/**
 * A tmux address, `session:window.pane`, padded or cut to `width` cells.
 * Two agents in one session differ only after the colon, so a cut from the
 * right draws both as the same session name. The session is cut instead and
 * the `:window.pane` suffix kept whole. An address with no colon, or a width
 * too narrow for the suffix and its ellipsis, is cut as any other text is.
 */
export function fitAddress(address: string, width: number): string {
  const colon = address.lastIndexOf(":");
  if (colon < 0 || textWidth(address) <= width) return fit(address, width);
  const suffix = safe(address.slice(colon));
  const room = width - textWidth(suffix) - 1;
  if (room < 0) return fit(address, width);
  const session = glyphs(address.slice(0, colon));
  const kept = textOf(session.slice(0, reach(session, 0, room)));
  return pad(`${kept}${ellipsis}${suffix}`, width);
}
/** One cell of a row, at its column's width and side. */
export const cell = (column: Column, value: string): string =>
  fit(value, column.width, column.align);
/**
 * The process id column every lane table draws beside the name. It is the one
 * thing that tells two lanes with one name apart, so no setting removes it and
 * no width sheds it.
 */
export const pidColumn: Column = { label: "PID", width: 8, align: "right" };
/**
 * A lane's cell in `pidColumn`. A row that leads no process draws it blank, not
 * as a zero nobody measured.
 */
export const pidCell = (pid: number): string =>
  cell(pidColumn, pid ? String(pid) : "");
/**
 * The heading line for a column spec. It is built from the same spec the row
 * renderer reads, so a width change cannot move one without the other.
 */
export const headerText = (columns: Column[]): string =>
  columns.map((column) => cell(column, column.label)).join(columnGap);
/**
 * The same columns with the sorted one carrying its direction. The arrow goes
 * inside the column's own width, so marking a column moves no other column and
 * the rows under it stay where they are.
 */
export const sortedColumns = (
  columns: Column[],
  sort?: { label: string; descending: boolean },
): Column[] =>
  sort === undefined
    ? columns
    : columns.map((column) => ({
        ...column,
        label: sortedLabel(
          column,
          column.label !== "" && column.label === sort.label,
          sort.descending,
        ),
      }));
/**
 * One heading, with its direction when it is the one being sorted by. On a
 * numeric column the arrow leads, so the heading still ends where the digits
 * under it end; on a text column it follows the word it belongs to.
 */
export const sortedLabel = (
  column: Column,
  sorted: boolean,
  descending: boolean,
): string => {
  if (!sorted) return column.label;
  const arrow = descending ? "↓" : "↑";
  return column.align === "right"
    ? `${arrow} ${column.label}`
    : `${column.label} ${arrow}`;
};
/**
 * The columns a spec occupies, including the blanks between its cells. A
 * caller sizing a flexible column subtracts this from the width it has.
 */
export const columnsWidth = (columns: Column[]): number =>
  columns.reduce((total, column) => total + column.width, 0) +
  columnGap.length * Math.max(0, columns.length - 1);
/**
 * The rows `drawn` wraps into at `width`, each as the characters it runs
 * from and to, so a caller cutting the text cuts the text rather than
 * rebuilding it from rows: a word too wide for the column is broken across
 * rows, and rejoining those rows with a blank puts a blank inside a word that
 * never held one.
 */
function wrapRows(
  drawn: Glyph[],
  width: number,
): { from: number; to: number }[] {
  if (width < 1)
    throw new RangeError(
      `Cannot wrap text into ${width} columns: needs at least 1`,
    );
  const rows: { from: number; to: number }[] = [];
  let at = 0;
  while (at < drawn.length) {
    while (drawn[at]?.text === " ") at++;
    if (at >= drawn.length) break;
    // A row holds at least one character, so one wider than the column draws
    // past it on a row of its own rather than wrapping forever.
    const edge = Math.max(at + 1, reach(drawn, at, width));
    const next = drawn[edge];
    if (next === undefined) {
      rows.push({ from: at, to: drawn.length });
      break;
    }
    if (next.text === " ") {
      rows.push({ from: at, to: edge });
      at = edge;
      continue;
    }
    // Just past the last blank before the edge, or `at` when there is none.
    const space =
      at + 1 + drawn.slice(at, edge).findLastIndex((g) => g.text === " ");
    // A word wider than the column has nowhere to break, so it is broken at
    // the column: the row before it would otherwise be empty.
    if (space > at) {
      rows.push({ from: at, to: space - 1 });
      at = space;
    } else {
      rows.push({ from: at, to: edge });
      at = edge;
    }
  }
  return rows;
}
/**
 * The rows `text` draws into at `width` cells, sanitized as they are drawn,
 * so a control byte is measured as the blank it draws as.
 */
export function wrapLines(text: string, width: number): string[] {
  const drawn = glyphs(text);
  return wrapRows(drawn, width).map(({ from, to }) =>
    textOf(drawn.slice(from, to)),
  );
}
/**
 * `text`, sanitized, cut to the rows it is allowed at `width`, ending in the
 * mark, which it carries for the same reason a cut cell does: text that stops
 * without one reads as text that ended. No rows is no text: a caller that has
 * run out of room is answered rather than raised at, because every caller of
 * this is on a path that draws a screen.
 */
export function capLines(text: string, width: number, lines: number): string {
  if (lines < 1) return "";
  const drawn = glyphs(text);
  const rows = wrapRows(drawn, width);
  if (rows.length <= lines) return textOf(drawn);
  const row = rows[lines - 1];
  if (row === undefined)
    throw new Error(`Cut row ${lines} is missing from ${rows.length} rows`);
  const { from, to } = row;
  // The row a cut ends on is never the last, so it never ends on a blank.
  let end =
    from + 1 + drawn.slice(from, to).findLastIndex((g) => !/[,.]/.test(g.text));
  // The mark draws a cell of its own, so the row gives up what it needs to
  // carry it.
  while (end > from && cellsOf(drawn.slice(from, end)) + 1 > width) end--;
  return `${textOf(drawn.slice(0, end))}${ellipsis}`;
}
