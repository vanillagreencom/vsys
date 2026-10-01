import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { Scratch, ScratchRoot, SourceError } from "../model/types";
import type { WorkerReply } from "./worker-host";

/**
 * A directory a scan is asked to measure, and why it is asked. An agent's
 * directory carries the user whose agents vsys watches: a directory another
 * user owns, such as the system's shared `/tmp`, is not that agent's own.
 */
export type ScanRoot =
  | { path: string; origin: "configured" | "default" }
  | { path: string; origin: "agent"; owner: number };

export interface ScratchScan {
  scratch: ScratchRoot[];
  sessions: Scratch[];
  /** Default roots that did not exist when the scan reached them. */
  absent: string[];
  time: number | null;
  errors: SourceError[];
}

/**
 * A scan and the number of times its traversal gave the thread back. The
 * count is what shows, from outside the scan thread, that the budget it was
 * sent took effect: `bench:scratch` reports it beside the bounded scan's cost.
 */
export interface PacedScan {
  scan: ScratchScan;
  rests: number;
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
  /** The rests taken; a slice that earned none takes no timer turn. */
  rests = 0;
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
    const ms = restMs(this.clock.now() - this.since, this.budget.dutyPercent);
    // Even a zero-length timer gives up a turn, which would throttle a scan
    // that was granted the whole thread.
    if (ms > 0) {
      await this.clock.sleep(ms);
      this.rests++;
    }
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
  root: ScanRoot,
  now: number,
  pace: Pace,
): Promise<{ root: ScratchRoot; sessions: Scratch[] } | "absent" | "shared"> {
  const { path, origin } = root;
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
  const failed = (error: unknown) => ({
    root: { ...record(path, null, undefined, error), origin },
    sessions: [],
  });
  // Only a root on a list other than the shipped one is a problem for not
  // existing. A default, omitted or pinned unchanged, or an agent's temporary
  // directory that is not there has no row rather than one that fails for
  // ever. Absence is the root's own status read failing with ENOENT, or with
  // ENOTDIR where a parent on its path is a file, so the root cannot exist:
  // a directory that leaves deeper in the walk fails the root as any other
  // unreadable entry does, and never hides it.
  let top: Stats;
  try {
    top = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (origin !== "configured" && (code === "ENOENT" || code === "ENOTDIR"))
      return "absent";
    return failed(error);
  }
  if (root.origin === "agent" && top.uid !== root.owner) return "shared";
  try {
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
    return { root: { ...record(path, bytes, top), origin }, sessions };
  } catch (error) {
    return failed(error);
  }
}

/**
 * One pass over every scratch root. It returns a complete reading for every
 * root or it throws, so no partial total is published as a complete one. A
 * root that could not be read carries a null size and its own error rather
 * than a zero.
 */
export async function scanScratch(
  roots: ScanRoot[],
  time: number,
  budget: ScanBudget,
  clock: PaceClock = timerPace,
): Promise<PacedScan> {
  const pace = new Pace(budget, clock);
  const result: ScratchScan = {
    scratch: [],
    sessions: [],
    absent: [],
    time,
    errors: [],
  };
  for (const root of roots) {
    const scanned = await scanRoot(root, time, pace);
    if (scanned === "absent" || scanned === "shared") {
      if (scanned === "absent" && root.origin === "default")
        result.absent.push(root.path);
      continue;
    }
    result.scratch.push(scanned.root);
    result.sessions.push(...scanned.sessions);
    if (scanned.root.error)
      result.errors.push({ source: root.path, message: scanned.root.error });
  }
  return { scan: result, rests: pace.rests };
}

/** What the main thread asks the scan worker for. */
export interface ScanRequest {
  id: number;
  roots: ScanRoot[];
  time: number;
  budget: ScanBudget;
}

/** What the scan worker answers, always naming the scan it answers for. */
export type ScanReply = WorkerReply<PacedScan>;
