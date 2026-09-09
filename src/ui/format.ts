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
export function age(n: number): string {
  return n < 60
    ? `${Math.floor(n)}s`
    : n < 3600
      ? `${Math.floor(n / 60)}m`
      : `${(n / 3600).toFixed(1)}h`;
}
export function laneValue(l: Lane, key: string, c: Config): string {
  const value = l[key as keyof Lane];
  if (key === "rss" || key === "swap") return bytes(value as number | null, c);
  if (key === "cpu" || key === "pressure")
    return percent(value as number | null);
  if (key === "age") return age(l.age);
  return String(value ?? "?");
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
