import type { TimelineEvent } from "../store/events";
import type { History } from "../store/history";
import { changed, type Point } from "../store/point";

/** The fields a chart can draw. */
const fields = [
  "agents",
  "desktop",
  "memory",
  "pressure",
  "memoryPressure",
  "ioPressure",
  "corruption",
  "unconfined",
  "builds",
] as const satisfies readonly (keyof Point)[];
export type ChartField = (typeof fields)[number];
/** A chart column: each field's peak over its span, its newest sample, and whether it recorded a change. */
export interface Column {
  peaks: Partial<Record<ChartField, number>>;
  last: number;
  changed: boolean;
}
interface Chart {
  /** The newest point folded into the columns. */
  folded: number;
  /** The oldest point held when the columns were last read. */
  oldest: number | undefined;
  columns: Map<number, Column>;
}

/**
 * The window's points and changes, kept from one sample to the next. A draw
 * reads the samples that arrived since the last one and drops those that left
 * the window: copying a retained day and rescanning it for every chart took
 * several times a 100 ms refresh.
 */
export class Retained {
  /** The window's points, oldest first. */
  points: Point[] = [];
  /** The window's changes, newest first, as the Timeline lists them. */
  events: TimelineEvent[] = [];
  private history: History | null = null;
  private end = 0;
  private windowMs = 0;
  private charts = new Map<number, Chart>();
  read(
    history: History,
    end: number,
    windowMs: number,
    retentionMs: number,
  ): this {
    const newest = this.points.at(-1)?.time;
    // A new store, a wider window or a clock stepped back holds points this
    // one never read, so those read the whole window once.
    if (
      history !== this.history ||
      windowMs > this.windowMs ||
      newest === undefined ||
      end < this.end
    ) {
      this.points = history.window(end, windowMs);
      this.events = this.points.toReversed().flatMap((p) => p.events ?? []);
      this.charts.clear();
    } else {
      // Retention can be shorter than the window, and the store has dropped
      // what is older than it.
      const cutoff = end - Math.min(windowMs, retentionMs);
      let gone = 0;
      let dropped = 0;
      for (const p of this.points) {
        if (p.time >= cutoff) break;
        gone++;
        dropped += p.events?.length ?? 0;
      }
      if (gone) this.points.splice(0, gone);
      // A clock that jumps forward hands over points already past the cutoff.
      const fresh = history
        .window(end, end - newest)
        .filter((p) => p.time > newest && p.time >= cutoff);
      for (const p of fresh) this.points.push(p);
      const added = fresh.toReversed().flatMap((p) => p.events ?? []);
      if (added.length || dropped)
        this.events = [
          ...added,
          ...this.events.slice(0, this.events.length - dropped),
        ];
      if (windowMs !== this.windowMs) this.charts.clear();
    }
    this.history = history;
    this.end = end;
    this.windowMs = windowMs;
    return this;
  }
  /**
   * The window drawn `width` columns wide. Each column is a fixed span of
   * time, so a sample stays in the column it landed in and a draw folds in only
   * the new ones. The newest column holds `end`, so the drawn window starts at
   * the column boundary up to one column after `end - windowMs`.
   */
  columns(width: number): {
    start: number;
    columns: (Column | undefined)[];
    /** The drawn column a time falls in, placed as its sample is. */
    column: (time: number) => number;
  } {
    // In whole milliseconds, so a sample on a boundary has one column.
    const at = (time: number) => Math.floor((time * width) / this.windowMs);
    const first = at(this.end) - width + 1;
    const chart = this.charts.get(width) ?? {
      folded: Number.NEGATIVE_INFINITY,
      oldest: undefined,
      columns: new Map<number, Column>(),
    };
    this.charts.set(width, chart);
    const fold = (p: Point) => {
      const index = at(p.time);
      const column = chart.columns.get(index) ?? {
        peaks: {},
        last: p.time,
        changed: false,
      };
      for (const field of fields) {
        const value = p[field];
        const peak = column.peaks[field];
        if (value !== null && Number.isFinite(value))
          column.peaks[field] =
            peak === undefined ? value : Math.max(peak, value);
      }
      column.last = p.time;
      column.changed ||= changed(p);
      chart.columns.set(index, column);
    };
    // Only retention shorter than the window drops points from a drawn
    // column. A peak cannot be taken back out, so that column is folded again
    // from the points still held.
    const oldest = this.points[0]?.time;
    if (oldest !== undefined && oldest !== chart.oldest) {
      const cut = at(oldest);
      for (const index of chart.columns.keys())
        if (index <= cut) chart.columns.delete(index);
      for (const p of this.points) {
        if (p.time > chart.folded || at(p.time) !== cut) break;
        fold(p);
      }
      chart.oldest = oldest;
    }
    let from = this.points.length;
    while ((this.points[from - 1]?.time ?? chart.folded) > chart.folded) from--;
    for (const p of this.points.slice(from)) fold(p);
    chart.folded = this.points.at(-1)?.time ?? chart.folded;
    for (const index of chart.columns.keys())
      if (index < first) chart.columns.delete(index);
    return {
      start: (first * this.windowMs) / width,
      columns: Array.from({ length: width }, (_, i) =>
        chart.columns.get(first + i),
      ),
      column: (time) => at(time) - first,
    };
  }
}
