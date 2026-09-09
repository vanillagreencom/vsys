import type { Sccache, SccacheDelta } from "../model/types";
import type { Reader } from "./io";

export interface Counters {
  hits: number;
  misses: number;
}
/**
 * `sccache --show-stats` prints one label and one integer per line. Only the
 * unqualified totals are read: `Cache hits (Rust)` is a subset of `Cache hits`
 * and adding it would double count.
 */
export function parseSccacheStats(text: string): Counters | null {
  const fields = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(Cache (?:hits|misses))\s+(\d+)$/.exec(line.trim());
    if (match) fields.set(match[1], Number(match[2]));
  }
  const hits = fields.get("Cache hits");
  const misses = fields.get("Cache misses");
  return hits === undefined || misses === undefined ? null : { hits, misses };
}
const unavailable: Sccache = {
  available: false,
  hits: null,
  misses: null,
  sinceStart: null,
  recent: null,
};
/** Read-only stats query. A missing binary is an absent feature, not an error. */
async function showStats(): Promise<string> {
  const child = Bun.spawn(["sccache", "--show-stats"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`sccache --show-stats failed: ${error}`);
  return out;
}
/**
 * Cumulative counters become the two deltas the reader can act on: the change
 * since vsys started, and the change over the trailing five minutes. A server
 * restart moves the counters backwards; that rebases rather than reporting a
 * negative delta.
 */
export class SccacheCollector {
  private samples: { time: number; hits: number; misses: number }[] = [];
  private baseline?: { time: number; hits: number; misses: number };
  private reading: Sccache = unavailable;
  private queriedAt: number | null = null;
  constructor(
    private run: () => Promise<string> = showStats,
    private minIntervalMs = 5000,
    private windowMs = 300000,
  ) {}
  async collect(r: Reader, time: number): Promise<Sccache> {
    if (
      this.queriedAt !== null &&
      time - this.queriedAt < this.minIntervalMs &&
      time >= this.queriedAt
    )
      return this.reading;
    let counters: Counters | null = null;
    try {
      counters = parseSccacheStats(await this.run());
      if (counters === null)
        r.error("sccache --show-stats", "Missing cache hit and miss counters");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        r.error("sccache --show-stats", e);
    }
    this.queriedAt = time;
    this.reading =
      counters === null ? unavailable : this.record(time, counters);
    return this.reading;
  }
  private record(time: number, now: Counters): Sccache {
    if (
      this.baseline &&
      (now.hits < this.baseline.hits || now.misses < this.baseline.misses)
    ) {
      this.baseline = undefined;
      this.samples = [];
    }
    this.baseline ??= { time, ...now };
    this.samples.push({ time, ...now });
    this.samples = this.samples.filter((s) => s.time >= time - this.windowMs);
    const since = (from: {
      time: number;
      hits: number;
      misses: number;
    }): SccacheDelta => ({
      hits: now.hits - from.hits,
      misses: now.misses - from.misses,
      windowMs: time - from.time,
    });
    return {
      available: true,
      hits: now.hits,
      misses: now.misses,
      sinceStart: since(this.baseline),
      recent: since(this.samples[0]),
    };
  }
}
