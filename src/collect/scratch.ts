import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/config";
import type { Scratch, SourceError } from "../model/types";

export interface ScratchScan {
  scratch: Scratch[];
  sessions: Scratch[];
  time: number | null;
  errors: SourceError[];
}

/** Read each entry once; root and session totals have independent hard-link sets. */
async function scanRoot(
  path: string,
  now: number,
  signal?: AbortSignal,
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
    signal?.throwIfAborted();
    const top = await lstat(path);
    if (!top.isDirectory())
      throw new Error(`Scratch path is not a directory: ${path}`);
    const global = new Set<string>();
    async function walk(
      current: string,
      stat: Stats,
      local: Set<string>,
      depth: number,
    ): Promise<[number, number]> {
      signal?.throwIfAborted();
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
        for (const entry of await readdir(current)) {
          signal?.throwIfAborted();
          const child = join(current, entry);
          let info: Stats;
          try {
            info = await lstat(child);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
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
    signal?.throwIfAborted();
    return { root: record(path, null, undefined, error), sessions: [] };
  }
}

export async function sizeDirectory(
  path: string,
  now: number,
  signal?: AbortSignal,
): Promise<Scratch> {
  return (await scanRoot(path, now, signal)).root;
}
async function scanScratch(
  c: Config,
  time: number,
  signal: AbortSignal,
): Promise<ScratchScan> {
  const result: ScratchScan = { scratch: [], sessions: [], time, errors: [] };
  for (const path of c.scratchDirs) {
    signal.throwIfAborted();
    const scanned = await scanRoot(path, time, signal);
    result.scratch.push(scanned.root);
    result.sessions.push(...scanned.sessions);
    if (scanned.root.error)
      result.errors.push({ source: path, message: scanned.root.error });
  }
  return result;
}

/** A live dashboard reuses completed scans while a single cancellable scan runs. */
export class ScratchCollector {
  private data: ScratchScan = {
    scratch: [],
    sessions: [],
    time: null,
    errors: [],
  };
  private job?: Promise<void>;
  private controller?: AbortController;
  private attempted?: number;
  private closed = false;
  constructor(private scan = scanScratch) {}
  get pending(): boolean {
    return this.job !== undefined;
  }
  async collect(c: Config, time: number, wait: boolean): Promise<ScratchScan> {
    if (this.closed) throw new Error("Scratch collector has closed");
    if (c.scratchDirs.length === 0)
      return { scratch: [], sessions: [], time, errors: [] };
    if (
      !this.job &&
      (wait ||
        this.attempted === undefined ||
        time - this.attempted >= c.scratchRefreshMs)
    ) {
      const controller = new AbortController();
      this.controller = controller;
      this.attempted = time;
      this.job = Promise.resolve()
        .then(() => this.scan(c, time, controller.signal))
        .then((data) => {
          if (!controller.signal.aborted) this.data = data;
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            this.data = {
              ...this.data,
              errors: [
                {
                  source: "scratch scan",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              ],
            };
        })
        .finally(() => {
          this.job = undefined;
        });
    }
    if (wait) await this.job;
    if (this.closed) throw new Error("Scratch collector has closed");
    return this.data;
  }
  close(): void {
    this.closed = true;
    this.controller?.abort();
  }
}
