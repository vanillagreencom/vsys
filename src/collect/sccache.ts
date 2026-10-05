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
  const field = (label: string) =>
    new RegExp(`^${label}[ \\t]+(\\d+)[ \\t]*\\r?$`, "m").exec(text)?.[1];
  const hits = field("Cache hits");
  const misses = field("Cache misses");
  return hits === undefined || misses === undefined
    ? null
    : { hits: Number(hits), misses: Number(misses) };
}
const unread = (state: "absent" | "failed"): Sccache => ({
  state,
  hits: null,
  misses: null,
  sinceStart: null,
  recent: null,
});
const source = "sccache --show-stats";
/** Why a query gave no counters; the message is for the reader. */
export class SccacheError extends Error {
  constructor(
    readonly kind: "failed" | "timeout" | "malformed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
/** A failed query keeps what it failed with, so every sample can report it. */
type Outcome = { reading: Sccache } | { failure: SccacheError };
/**
 * Read-only stats query. A missing binary is an absent feature, not an error.
 * The deadline kills the child, because a wedged cache server must not hold
 * the sample that the dashboard is waiting on.
 */
async function showStats(timeoutMs: number): Promise<string> {
  const child = Bun.spawn(["sccache", "--show-stats"], {
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(timeoutMs),
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
  /**
   * The last query's outcome. The reader is new on every sample, so a sample
   * the throttle skips reports a failure again rather than reading as healthy.
   */
  private last: Outcome = { reading: unread("absent") };
  private queriedAt: number | null = null;
  constructor(
    private run: (timeoutMs: number) => Promise<string> = showStats,
    private minIntervalMs = 5000,
    private windowMs = 300000,
    private timeoutMs = 2000,
  ) {}
  /**
   * The sample awaits this query, so it carries its own deadline whatever the
   * query does with the one it is given. A timeout is a source error and the
   * reading is a failed one, rather than a dashboard that stops.
   */
  private async query(): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new SccacheError(
      "timeout",
      `sccache --show-stats did not answer within ${this.timeoutMs} ms`,
    );
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(reject, this.timeoutMs, late);
    });
    try {
      return await Promise.race([this.run(this.timeoutMs), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
  async collect(r: Reader, time: number): Promise<Sccache> {
    if (
      this.queriedAt === null ||
      time - this.queriedAt >= this.minIntervalMs ||
      time < this.queriedAt
    ) {
      this.last = await this.ask(time);
      this.queriedAt = time;
    }
    if ("reading" in this.last) return this.last.reading;
    r.error(source, this.last.failure);
    return unread("failed");
  }
  private async ask(time: number): Promise<Outcome> {
    let counters: Counters | null;
    try {
      counters = parseSccacheStats(await this.query());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { reading: unread("absent") };
      if (e instanceof SccacheError) return { failure: e };
      const message = e instanceof Error ? e.message : String(e);
      return { failure: new SccacheError("failed", message, { cause: e }) };
    }
    return counters === null
      ? {
          failure: new SccacheError(
            "malformed",
            "Missing cache hit and miss counters",
          ),
        }
      : { reading: this.record(time, counters) };
  }
  private record(time: number, now: Counters): Sccache {
    // Any backwards movement is a restarted server. The latest reading is the
    // comparison, because a restart after the counters grew past the startup
    // baseline would otherwise pass and turn the recent delta negative.
    const previous = this.samples.at(-1) ?? this.baseline;
    if (
      previous &&
      (now.hits < previous.hits || now.misses < previous.misses)
    ) {
      this.baseline = undefined;
      this.samples = [];
    }
    this.baseline ??= { time, ...now };
    this.samples.push({ time, ...now });
    this.samples = this.samples.filter((s) => s.time >= time - this.windowMs);
    const [oldest] = this.samples;
    if (!oldest)
      throw new Error(
        `sccache window=${this.windowMs}ms dropped the reading just taken`,
      );
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
      state: "read",
      hits: now.hits,
      misses: now.misses,
      sinceStart: since(this.baseline),
      recent: since(oldest),
    };
  }
}
