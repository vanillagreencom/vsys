import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { Scratch, SourceError } from "../model/types";
import type { CollectionConfig } from "./settings";

export interface ScratchScan {
  scratch: Scratch[];
  sessions: Scratch[];
  time: number | null;
  errors: SourceError[];
}

/**
 * `sliceMs` is the granularity the share is enforced at; `restMs` owns what a
 * spent slice earns at `dutyPercent`.
 */
export interface ScanBudget {
  sliceMs: number;
  dutyPercent: number;
}

/**
 * The clock the traversal times its slices by and the wait it rests with. The
 * program uses the monotonic clock and a timer; a test stages both, because a
 * bound read off a loaded runner's wall clock proves nothing.
 */
export interface PaceClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** The pace the program keeps: the monotonic clock and a real timer. */
export const timerPace: PaceClock = {
  now: () => performance.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/**
 * How long a traversal that worked `busyMs` must rest to have held no more
 * than `dutyPercent` of its thread across the two. At 100 it rests not at
 * all, because there is no share left to give back.
 */
export function restMs(busyMs: number, dutyPercent: number): number {
  return dutyPercent >= 100 ? 0 : (busyMs * (100 - dutyPercent)) / dutyPercent;
}

/**
 * The traversal's pacing. It reads the clock once per directory entry, which
 * is a small fraction of the status read beside it, and rests for what each
 * spent slice earned.
 */
class Pace {
  private since: number;
  constructor(
    private budget: ScanBudget,
    private clock: PaceClock,
  ) {
    this.since = clock.now();
  }
  /** True once the slice is spent, so the caller must await `rest()`. */
  due(): boolean {
    return this.clock.now() - this.since >= this.budget.sliceMs;
  }
  async rest(): Promise<void> {
    await this.clock.sleep(
      restMs(this.clock.now() - this.since, this.budget.dutyPercent),
    );
    this.since = this.clock.now();
  }
}

/**
 * Read each entry once; root and session totals have independent hard-link
 * sets. Entry reads are synchronous: one directory listing, then one status
 * read per listed entry on the calling thread. The asynchronous form
 * submitted a separate request per entry and spent measurably more CPU for
 * the same readings, and this traversal runs on a thread of its own where
 * blocking delays no sample.
 */
async function scanRoot(
  path: string,
  now: number,
  pace: Pace,
): Promise<{ root: Scratch; sessions: Scratch[] }> {
  const sessions: Scratch[] = [];
  const record = (
    path: string,
    bytes: number | null,
    stat?: Stats,
    error: unknown = null,
  ): Scratch => ({
    path,
    bytes,
    age: stat ? Math.max(0, (now - stat.mtimeMs) / 1000) : 0,
    modifiedAt: stat?.mtimeMs ?? null,
    error:
      error === null
        ? null
        : error instanceof Error
          ? error.message
          : String(error),
  });
  try {
    const top = lstatSync(path);
    if (!top.isDirectory())
      throw new Error(`Scratch path is not a directory: ${path}`);
    const global = new Set<string>();
    async function walk(
      current: string,
      stat: Stats,
      local: Set<string>,
      depth: number,
    ): Promise<[number, number]> {
      if (stat.dev !== top.dev || stat.isSymbolicLink()) return [0, 0];
      const id = `${stat.dev}:${stat.ino}`;
      const rootSeen = global.has(id);
      const sessionSeen = local.has(id);
      if (rootSeen && sessionSeen) return [0, 0];
      global.add(id);
      local.add(id);
      let rootBytes = rootSeen ? 0 : stat.size;
      let sessionBytes = sessionSeen ? 0 : stat.size;
      if (stat.isDirectory())
        for (const entry of readdirSync(current)) {
          if (pace.due()) await pace.rest();
          const child = join(current, entry);
          // An entry that left between the listing and the read is gone, not
          // a failure. `throwIfNoEntry` separates that from a directory this
          // process may not read, which still fails the whole root it sits in.
          const info = lstatSync(child, { throwIfNoEntry: false });
          if (info === undefined) continue;
          const session = depth === 0 && info.isDirectory();
          const totals = await walk(
            child,
            info,
            session ? new Set() : local,
            depth + 1,
          );
          rootBytes += totals[0];
          sessionBytes += totals[1];
          if (session) sessions.push(record(child, totals[1], info));
        }
      return [rootBytes, sessionBytes];
    }
    const [bytes] = await walk(path, top, global, 0);
    return { root: record(path, bytes, top), sessions };
  } catch (error) {
    return { root: record(path, null, undefined, error), sessions: [] };
  }
}

/**
 * One pass over every configured scratch root. It returns a complete reading
 * for every root or it throws, so no partial total is published as a complete
 * one. A root that could not be read carries a null size and its own error
 * rather than a zero.
 */
export async function scanScratch(
  c: CollectionConfig,
  time: number,
  budget: ScanBudget,
  clock: PaceClock = timerPace,
): Promise<ScratchScan> {
  const pace = new Pace(budget, clock);
  const result: ScratchScan = { scratch: [], sessions: [], time, errors: [] };
  for (const path of c.scratchDirs) {
    const scanned = await scanRoot(path, time, pace);
    result.scratch.push(scanned.root);
    result.sessions.push(...scanned.sessions);
    if (scanned.root.error)
      result.errors.push({ source: path, message: scanned.root.error });
  }
  return result;
}

/** What the main thread asks the scan worker for. */
export interface ScanRequest {
  id: number;
  config: CollectionConfig;
  time: number;
  budget: ScanBudget;
}

/** What the scan worker answers, always naming the scan it answers for. */
export type ScanReply =
  | { kind: "scan"; id: number; scan: ScratchScan }
  | { kind: "failed"; id: number; message: string };
