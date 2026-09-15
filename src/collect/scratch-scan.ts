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
 * How much of a thread the traversal may hold, and how long it may hold it
 * before it lets go. A `dutyPercent` of 100 still yields once a slice,
 * because a thread that never returns to its event loop cannot be told to
 * stop.
 */
export interface ScanBudget {
  sliceMs: number;
  dutyPercent: number;
}

/** A traversal the caller stopped. It is no reading, and it is no error. */
export class ScanCancelled extends Error {
  constructor() {
    super("Scratch scan cancelled");
    this.name = "ScanCancelled";
  }
}

/**
 * How long a traversal that worked `busyMs` must rest to have held no more
 * than `dutyPercent` of its thread across the two. At 100 it rests not at
 * all, because there is no share left to give back.
 */
export function restMs(busyMs: number, dutyPercent: number): number {
  return dutyPercent >= 100 ? 0 : (busyMs * (100 - dutyPercent)) / dutyPercent;
}

/**
 * The traversal's clock. It reads the monotonic clock once per directory
 * entry, which is a small fraction of the status read beside it, and rests
 * for the share of each slice the budget does not grant.
 */
class Pace {
  private since = performance.now();
  constructor(
    private budget: ScanBudget,
    private cancelled: () => boolean,
  ) {}
  /** True once the slice is spent, so the caller must await `rest()`. */
  due(): boolean {
    return performance.now() - this.since >= this.budget.sliceMs;
  }
  async rest(): Promise<void> {
    const idle = restMs(
      performance.now() - this.since,
      this.budget.dutyPercent,
    );
    await new Promise((resolve) => setTimeout(resolve, idle));
    this.check();
    this.since = performance.now();
  }
  /** Stop before a root is walked, so a cancelled scan reads nothing more. */
  check(): void {
    if (this.cancelled()) throw new ScanCancelled();
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
    pace.check();
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
    // A stopped traversal has no total to report. Recording it here would
    // publish a cancellation as a reading of the directory.
    if (error instanceof ScanCancelled) throw error;
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
  cancelled: () => boolean,
): Promise<ScratchScan> {
  const pace = new Pace(budget, cancelled);
  const result: ScratchScan = { scratch: [], sessions: [], time, errors: [] };
  for (const path of c.scratchDirs) {
    pace.check();
    const scanned = await scanRoot(path, time, pace);
    result.scratch.push(scanned.root);
    result.sessions.push(...scanned.sessions);
    if (scanned.root.error)
      result.errors.push({ source: path, message: scanned.root.error });
  }
  return result;
}

/** What the main thread asks the scan worker for. */
export type ScanRequest =
  | {
      kind: "scan";
      id: number;
      config: CollectionConfig;
      time: number;
      budget: ScanBudget;
    }
  | { kind: "cancel" };

/** What the scan worker answers, always naming the scan it answers for. */
export type ScanReply =
  | { kind: "scan"; id: number; scan: ScratchScan }
  | { kind: "cancelled"; id: number }
  | { kind: "failed"; id: number; message: string };
