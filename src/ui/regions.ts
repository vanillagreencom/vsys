/**
 * A screen's regions, and the arithmetic for moving between them. A screen
 * that holds several lists reaches them as one flat selection unless something
 * says where one ends and the next begins, and a reader on the first list then
 * has to walk through everything above the one they want.
 *
 * The rows stay one flat list, because that is what the render draws and what
 * the selection counts. A region is a range over it.
 */

/** The half-open row range of each region, laid out in the order given. */
export function regionRanges(counts: number[]): [number, number][] {
  let at = 0;
  return counts.map((count) => {
    const start = at;
    at += count;
    return [start, at] as [number, number];
  });
}
/**
 * The region a row belongs to. A row past the end belongs to the last region
 * that has rows, so a selection left behind by a shrinking list still lands
 * somewhere a reader can see.
 */
export function regionOf(counts: number[], index: number): number {
  let at = 0;
  for (let region = 0; region < counts.length; region++) {
    at += counts[region];
    if (index < at) return region;
  }
  return Math.max(
    0,
    counts.reduce((last, count, at2) => (count > 0 ? at2 : last), 0),
  );
}
/**
 * The region focus moves to. A region with no rows is skipped, because a
 * reader cannot stand on a row that is not there, and movement stops at the
 * ends rather than wrapping: an arrow that comes back around loses the reader.
 */
export function stepRegion(
  counts: number[],
  from: number,
  way: -1 | 1,
): number {
  for (let at = from + way; at >= 0 && at < counts.length; at += way)
    if (counts[at] > 0) return at;
  return from;
}
/** The row above or below, without leaving the region it is in. */
export function stepWithin(
  counts: number[],
  index: number,
  way: -1 | 1,
): number {
  const region = regionOf(counts, index);
  const [start, end] = regionRanges(counts)[region] ?? [0, 0];
  if (end <= start) return index;
  return Math.max(start, Math.min(end - 1, index + way));
}
