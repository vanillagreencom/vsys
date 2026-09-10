import type { Config } from "../config/config";
import type { Lane } from "../model/types";

export function bytes(n: number | null | undefined, c: Config): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "?";
  const base = c.units === "binary" ? 1024 : 1000;
  const units =
    c.units === "binary"
      ? ["B", "KiB", "MiB", "GiB", "TiB"]
      : ["B", "kB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= base && i < units.length - 1) {
    n /= base;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
export function percent(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n)
    ? "?"
    : `${n.toFixed(1)}%`;
}
export const plural = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;
/** A count and its noun, so no line ever reads "1 linkers". */
export const count = (
  n: number | null,
  one: string,
  many = `${one}s`,
): string => `${n ?? 0} ${plural(n ?? 0, one, many)}`;
/**
 * A span in the largest unit that still says something. Past two days an
 * hour count is arithmetic the reader has to do: `54.9h ago` is `2.3d ago`.
 */
export function age(n: number): string {
  return n < 60
    ? `${Math.floor(n)}s`
    : n < 3600
      ? `${Math.floor(n / 60)}m`
      : n < 172800
        ? `${(n / 3600).toFixed(1)}h`
        : `${(n / 86400).toFixed(1)}d`;
}
/** A quantity vsys could not read says so; it never shows a question mark. */
export const gap = "not available";
export function amount(n: number | null | undefined, c: Config): string {
  return n === null || n === undefined ? gap : bytes(n, c);
}
export function share(n: number | null | undefined): string {
  return n === null || n === undefined ? gap : percent(n);
}
/** I/O is a rate, so its unit carries the second it was measured over. */
export function rate(n: number | null | undefined, c: Config): string {
  return n === null || n === undefined ? gap : `${bytes(n, c)}/s`;
}
/** An unread cgroup tree leaves the cap unknown; only a read one is unlimited. */
export function capText(l: Lane, c: Config): string {
  if (!l.memoryMaxKnown) return gap;
  return l.memoryMax === null ? "unlimited" : bytes(l.memoryMax, c);
}
/**
 * A blocked lane names the count of tasks in uninterruptible wait and the
 * resource whose stall share is the higher of the two.
 */
export function blockedText(l: Lane): string {
  if (l.state !== "blocked") return l.state;
  const on =
    l.blockedOn === "io"
      ? "storage"
      : l.blockedOn === "memory"
        ? "memory"
        : gap;
  const tasks = `${l.blocked} ${l.blocked === 1 ? "task" : "tasks"}`;
  return `blocked: ${tasks} waiting on ${on}`;
}
export function laneValue(l: Lane, key: string, c: Config): string {
  const value = l[key as keyof Lane];
  if (key === "rss" || key === "swap" || key === "cache")
    return amount(value as number | null, c);
  if (key === "readRate" || key === "writeRate")
    return rate(value as number | null, c);
  if (key === "cpu" || key === "pressure") return share(value as number | null);
  if (key === "age") return age(l.age);
  return value === null || value === undefined ? gap : String(value);
}
export function sortLanes(
  lanes: Lane[],
  column: string,
  descending: boolean,
): Lane[] {
  return [...lanes].sort((a, b) => {
    const x = a[column as keyof Lane];
    const y = b[column as keyof Lane];
    if (x === null) return y === null ? 0 : 1;
    if (y === null) return -1;
    const compare =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y));
    return (descending ? -compare : compare) || a.id.localeCompare(b.id);
  });
}
/** Place samples by elapsed time, leaving collection gaps visible. */
export function timeBuckets<T extends { time: number }>(
  points: T[],
  start: number,
  end: number,
  width: number,
): T[][] {
  if (!Number.isInteger(width) || width < 1 || end <= start)
    throw new Error("Invalid chart window");
  const buckets: T[][] = Array.from({ length: width }, () => []);
  for (const point of points) {
    if (point.time < start || point.time > end) continue;
    const index = Math.min(
      width - 1,
      Math.floor(((point.time - start) * width) / (end - start)),
    );
    buckets[index].push(point);
  }
  return buckets;
}
/**
 * The peak of one field in each time bucket, so a chart column shows the worst
 * moment in its span and a bucket with no sample stays null.
 */
export function bucketPeaks<T extends { time: number }>(
  points: T[],
  start: number,
  end: number,
  width: number,
  pick: (point: T) => number | null,
): (number | null)[] {
  return timeBuckets(points, start, end, width).map((bucket) => {
    let peak: number | null = null;
    for (const point of bucket) {
      const value = pick(point);
      if (value !== null && Number.isFinite(value))
        peak = peak === null ? value : Math.max(peak, value);
    }
    return peak;
  });
}
/** Aggregate the maximum in each bucket so brief stalls remain visible. */
export function sparkline(
  values: (number | null)[],
  width: number,
  style: Config["sparkline"],
): string {
  if (!values.length) return "No samples";
  const marks = style === "block" ? "▁▂▃▄▅▆▇█" : "⡀⡄⡆⡇⣇⣧⣷⣿";
  const max = Math.max(1, ...values.flatMap((v) => (v === null ? [] : [v])));
  const size = Math.min(Math.max(1, width), values.length);
  return Array.from({ length: size }, (_, i) => {
    const part = values
      .slice(
        Math.floor((i * values.length) / size),
        Math.floor(((i + 1) * values.length) / size),
      )
      .filter((v): v is number => v !== null);
    return part.length
      ? marks[Math.min(7, Math.floor((Math.max(...part) / max) * 7))]
      : "·";
  }).join("");
}
