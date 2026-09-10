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
 * Pad or cut `text` to exactly `width` display columns. Code points are
 * counted rather than UTF-16 units, so a name outside the basic plane is not
 * cut through the middle of a character.
 */
export function fit(
  text: string,
  width: number,
  align?: Column["align"],
): string {
  if (width <= 0) return "";
  const points = [...text];
  if (points.length <= width)
    return align === "right" ? text.padStart(width) : text.padEnd(width);
  return width === 1
    ? ellipsis
    : `${points.slice(0, width - 1).join("")}${ellipsis}`;
}
/** One cell of a row, at its column's width and side. */
export const cell = (column: Column, value: string): string =>
  fit(value, column.width, column.align);
/**
 * The heading line for a column spec. It is built from the same spec the row
 * renderer reads, so a width change cannot move one without the other.
 */
export const headerText = (columns: Column[]): string =>
  columns.map((column) => cell(column, column.label)).join(columnGap);
/**
 * The columns a spec occupies, including the blanks between its cells. A
 * caller sizing a flexible column subtracts this from the width it has.
 */
export const columnsWidth = (columns: Column[]): number =>
  columns.reduce((total, column) => total + column.width, 0) +
  columnGap.length * Math.max(0, columns.length - 1);
