import type { Config } from "../config/config";
import type { BuildsSummary, CacheEffect, Rates } from "../model/builds";
import { buildsSummary } from "../model/builds";
import type { Snapshot } from "../model/types";
import { age, count, gap, plural, share } from "./format";

/**
 * The fleet total. The Overview build meter and the Builds view both print
 * this sentence from the same numbers, so the two screens cannot disagree.
 */
export function fleetTotal(v: Record<string, number | null>): string {
  const builds = v.builds ?? 0;
  return `Build slots: ${builds} compile and link ${plural(builds, "process", "processes")} / ${v.cores ?? 0} cores | ${count(v.linkers, "linker")} | ${count(v.lanes, "building cgroup")}`;
}
/** The measured window is stated, so a short one is never called five minutes. */
function cacheWork(r: Rates): string {
  const over =
    r.windowMs > 0 ? `over ${age(r.windowMs / 1000)}` : "over no elapsed time";
  return `${count(r.hits, "hit")}, ${count(r.misses, "miss", "misses")}, ${share(r.rate)} hit rate ${over}`;
}
/** Every word and every formatted number the Builds view shows lives here. */
export function buildLines(s: Snapshot, c: Config): string[] {
  const summary: BuildsSummary = buildsSummary(s, c);
  const lines = [
    fleetTotal({
      builds: summary.builds,
      linkers: summary.linkers,
      lanes: summary.lanes,
      cores: summary.cores,
    }),
  ];
  lines.push(
    summary.linkers
      ? "Linkers write the finished binaries; they load the disk, not the cores."
      : "No linker is running, so no build is writing a finished binary.",
  );
  for (const row of summary.rows)
    lines.push(
      `  ${row.name || "outside the watched lanes"}: ${count(row.builds, "compile and link process", "compile and link processes")}, ${count(row.linkers, "linker")}${row.linkerNames.length ? ` (${row.linkerNames.join(", ")})` : ""}`,
    );
  lines.push(...cacheLines(summary.cache));
  for (const j of summary.jobservers)
    lines.push(
      `make jobserver ${j.fifo}: ${j.inUse} of ${j.total === null ? gap : j.total} ${plural(j.total ?? j.inUse, "token", "tokens")} in use`,
    );
  return lines;
}
/** The cache reading, then anything that makes the reading misleading. */
function cacheLines(cache: CacheEffect): string[] {
  const lines = cache.available
    ? [
        `sccache since vsys started: ${cache.sinceStart === null ? gap : cacheWork(cache.sinceStart)}`,
        `sccache recently: ${cache.recent === null ? gap : cacheWork(cache.recent)}`,
      ]
    : ["sccache: not available"];
  if (cache.bypassed.length)
    lines.push(
      `sccache is bypassed in ${cache.bypassed.join(", ")}: RUSTC_WRAPPER is empty there, so those compilations never reach the cache.`,
    );
  return lines;
}
