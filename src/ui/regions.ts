/**
 * A screen's regions, and the arithmetic for moving between them. A screen
 * that holds several lists reaches them as one flat selection unless something
 * says where one ends and the next begins, and a reader on the first list then
 * has to walk through everything above the one they want.
 *
 * The rows stay one flat list, because that is what the render draws and what
 * the selection counts. A region is a range over it.
 */

/**
 * A region a reader can jump to: the key action that reaches it and the title
 * that names it. The heading, the Settings label and the help panel all read
 * this one entry, so the name a key is listed under is the name drawn beside it.
 */
export interface NamedRegion {
  action: string;
  title: string;
}
/** Home's regions in the order drawn. The tile row is region zero. */
export const homeRegions: NamedRegion[] = [
  { action: "tiles", title: "Tiles" },
  { action: "attention", title: "Needs attention" },
  { action: "changes", title: "Recent changes" },
  { action: "busiest", title: "Busiest agents" },
];
/** Storage's selectable lists in the order drawn. */
export const storageRegions: NamedRegion[] = [
  { action: "filesystems", title: "Filesystems" },
  { action: "scrub", title: "Scrub reports" },
  { action: "scratch", title: "Scratch" },
];
/** The keys that jump to `regions`, in the order drawn, one space apart. */
export function jumpKeys(
  regions: NamedRegion[],
  keys: Record<string, string>,
): string {
  return regions.map((region) => keys[region.action]).join(" ");
}

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
 * The region a row belongs to, or -1 when no region holds it: an index outside
 * every region's rows, which is any index while every region is empty. A
 * screen holding such an index has no row selected, so no region is focused.
 */
export function regionOf(counts: number[], index: number): number {
  if (index < 0) return -1;
  let at = 0;
  for (let region = 0; region < counts.length; region++) {
    at += counts[region];
    if (index < at) return region;
  }
  return -1;
}
/**
 * The region focus moves to. A region with no rows is skipped, because a
 * reader cannot stand on a row that is not there, and movement stops at the
 * ends rather than wrapping: an arrow that comes back around loses the reader.
 * From -1, no region, forward reaches the first region with rows.
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
/**
 * The row the region key selects: the first row of the next region with rows
 * that way, or the row it was given when there is none, so a reader at either
 * end stays on the row they are on rather than jumping to the top of it. An
 * index no region holds moves forward to the first row there is.
 */
export function stepToRegion(
  counts: number[],
  index: number,
  way: -1 | 1,
): number {
  const from = regionOf(counts, index);
  const to = stepRegion(counts, from, way);
  return to === from ? index : regionRanges(counts)[to][0];
}
/**
 * The row above or below, without leaving the region it is in. An index no
 * region holds has no region to move inside, so it stays where it is.
 */
export function stepWithin(
  counts: number[],
  index: number,
  way: -1 | 1,
): number {
  const region = regionOf(counts, index);
  if (region < 0) return index;
  const [start, end] = regionRanges(counts)[region];
  return Math.max(start, Math.min(end - 1, index + way));
}
