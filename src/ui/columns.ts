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
 * Pad or cut `text` to exactly `width` code points. Both branches count code
 * points, never UTF-16 units, so a name outside the basic plane is neither cut
 * through the middle of a character nor padded one column short: `padEnd` and
 * `padStart` count units, and an emoji is two of them.
 *
 * A code point is not a terminal cell. A CJK character draws two cells, so a
 * name holding one still misaligns its column. Nothing vsys renders reaches
 * that today, and cell-width measurement is not built here.
 */
export function fit(
  text: string,
  width: number,
  align?: Column["align"],
): string {
  if (width <= 0) return "";
  const points = [...text];
  if (points.length <= width) {
    const padding = " ".repeat(width - points.length);
    return align === "right" ? `${padding}${text}` : `${text}${padding}`;
  }
  return width === 1
    ? ellipsis
    : `${points.slice(0, width - 1).join("")}${ellipsis}`;
}
/**
 * A tmux address, `session:window.pane`, padded or cut to `width` code points.
 * Two agents in one session differ only after the colon, so a cut from the
 * right draws both as the same session name. The session is cut instead and
 * the `:window.pane` suffix kept whole. An address with no colon, or a width
 * too narrow for the suffix and its ellipsis, is cut as any other text is.
 */
export function fitAddress(address: string, width: number): string {
  const colon = address.lastIndexOf(":");
  if (colon < 0 || [...address].length <= width) return fit(address, width);
  const suffix = address.slice(colon);
  const room = width - [...suffix].length - 1;
  if (room < 0) return fit(address, width);
  return `${[...address.slice(0, colon)].slice(0, room).join("")}${ellipsis}${suffix}`;
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
 * The rows `text` draws into at `width`, wrapped between words the way the
 * renderer wraps it. A word wider than the column is broken, because a column
 * that cannot hold it has nowhere else to put it.
 */
export function wrapLines(text: string, width: number): string[] {
  if (width <= 0) return text === "" ? [] : [text];
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(" ").filter((part) => part !== "")) {
    const next = row === "" ? word : `${row} ${word}`;
    if ([...next].length <= width) {
      row = next;
      continue;
    }
    if (row !== "") rows.push(row);
    row = word;
    while ([...row].length > width) {
      rows.push([...row].slice(0, width).join(""));
      row = [...row].slice(width).join("");
    }
  }
  if (row !== "") rows.push(row);
  return rows;
}
/**
 * `text` cut to the rows it is allowed at `width`, ending in the mark. The
 * cut is marked for the same reason a cut cell is: text that stops without
 * one reads as text that ended.
 */
export function capLines(text: string, width: number, lines: number): string {
  if (lines < 1 || width <= 0) return "";
  const rows = wrapLines(text, width);
  if (rows.length <= lines) return text;
  const kept = rows.slice(0, lines);
  const last = [...kept[lines - 1]];
  kept[lines - 1] = `${(
    last.length > width - 1
      ? last
          .slice(0, width - 1)
          .join("")
          .trimEnd()
      : last.join("")
  ).replace(/[,.]$/, "")}${ellipsis}`;
  return kept.join(" ");
}
