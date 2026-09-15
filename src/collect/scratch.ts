import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type ScanBudget,
  ScanCancelled,
  type ScanReply,
  type ScanRequest,
  type ScratchScan,
} from "./scratch-scan";
import type { CollectionConfig } from "./settings";

export type { ScratchScan } from "./scratch-scan";

/**
 * The scan thread's own file: the source module beside this one, or the built
 * one beside the bundle. Bun's bundler does not follow a worker URL, so the
 * build emits the worker as a second entry point and this picks whichever
 * spelling is on disk. Neither present is a broken install, and it says so
 * rather than leaving scratch quietly unmeasured.
 */
function workerFile(): URL {
  const candidates = ["./scratch-worker.ts", "./scratch-worker.js"].map(
    (name) => new URL(name, import.meta.url),
  );
  const found = candidates.find((url) => existsSync(fileURLToPath(url)));
  if (found === undefined)
    throw new Error(
      `No scratch scan worker beside ${fileURLToPath(import.meta.url)}`,
    );
  return found;
}

/**
 * Where a scan runs. The program runs it on a thread of its own; a test
 * supplies its own runner and never starts one.
 */
export interface ScanRunner {
  run(
    c: CollectionConfig,
    time: number,
    budget: ScanBudget,
    signal: AbortSignal,
  ): Promise<ScratchScan>;
  close(): void;
}

/**
 * The scan thread, started at the first scan and kept: a dashboard scans
 * again every interval, and a thread started per scan pays its startup cost
 * on every one of them. One scan runs at a time, because the collector holds
 * a single job and only starts the next after that job settles.
 */
export class WorkerScan implements ScanRunner {
  private worker?: Worker;
  private id = 0;
  private pending?: {
    id: number;
    resolve: (scan: ScratchScan) => void;
    reject: (error: unknown) => void;
  };
  private closed = false;
  private thread(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(workerFile(), { type: "module" });
    worker.onmessage = (event: MessageEvent<ScanReply>) => {
      this.receive(event.data);
    };
    // A thread that died owes its caller an answer, and the next scan needs a
    // thread. Leaving the promise open would hold the collector's single job
    // forever, so scratch would read its last complete data and never refresh.
    worker.onerror = (event: ErrorEvent) => {
      this.fail(new Error(`Scratch scan thread failed: ${event.message}`));
    };
    worker.addEventListener("close", () => {
      this.fail(new Error("Scratch scan thread exited before it answered"));
    });
    this.worker = worker;
    return worker;
  }
  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    pending?.reject(error);
  }
  private receive(reply: ScanReply): void {
    const pending = this.pending;
    // A reply to a scan the caller already gave up on. Resolving with it
    // would publish a reading taken under settings that have been replaced.
    if (!pending || pending.id !== reply.id) return;
    this.pending = undefined;
    switch (reply.kind) {
      case "scan":
        pending.resolve(reply.scan);
        return;
      case "cancelled":
        pending.reject(new ScanCancelled());
        return;
      case "failed":
        pending.reject(new Error(reply.message));
        return;
      default: {
        const unhandled: never = reply;
        throw new Error(
          `Scratch scan thread sent an unknown reply: ${JSON.stringify(unhandled)}`,
        );
      }
    }
  }
  run(
    c: CollectionConfig,
    time: number,
    budget: ScanBudget,
    signal: AbortSignal,
  ): Promise<ScratchScan> {
    if (this.closed) throw new Error("Scratch scan thread has closed");
    if (this.pending)
      throw new Error("Scratch scan thread is already scanning");
    const id = ++this.id;
    const worker = this.thread();
    return new Promise<ScratchScan>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      signal.addEventListener(
        "abort",
        () => {
          if (this.pending?.id !== id) return;
          this.pending = undefined;
          this.worker?.postMessage({ kind: "cancel" } satisfies ScanRequest);
          reject(new ScanCancelled());
        },
        { once: true },
      );
      worker.postMessage({
        kind: "scan",
        id,
        config: c,
        time,
        budget,
      } satisfies ScanRequest);
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const pending = this.pending;
    this.pending = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    pending?.reject(new ScanCancelled());
  }
}

/**
 * How long the traversal works before it rests. A slice this short keeps the
 * thread answering a cancellation promptly; the share of it the traversal
 * keeps is the reader's setting.
 */
const SLICE_MS = 4;

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
  /** When the last scan finished, whatever it found. */
  private finished?: number;
  private closed = false;
  constructor(
    private runner: ScanRunner = new WorkerScan(),
    /**
     * The rescan interval is a duration, so it is measured on a clock that
     * cannot step. The sample time a caller passes is wall clock, which can.
     */
    private clock = () => performance.now(),
  ) {}
  get pending(): boolean {
    return this.job !== undefined;
  }
  async collect(
    c: CollectionConfig,
    time: number,
    wait: boolean,
  ): Promise<ScratchScan> {
    if (this.closed) throw new Error("Scratch collector has closed");
    if (c.scratchDirs.length === 0)
      return { scratch: [], sessions: [], time, errors: [] };
    if (
      !this.job &&
      (wait ||
        this.finished === undefined ||
        this.clock() - this.finished >= c.scratchRefreshMs)
    ) {
      const controller = new AbortController();
      this.controller = controller;
      // A caller that waits is a script with no screen to protect, so its
      // scan holds the thread throughout. A live dashboard grants the share
      // the reader set and rests for the remainder of every slice.
      const budget: ScanBudget = {
        sliceMs: SLICE_MS,
        dutyPercent: wait ? 100 : c.scratchDutyPercent,
      };
      this.job = Promise.resolve()
        .then(() => this.runner.run(c, time, budget, controller.signal))
        .then((data) => {
          if (!controller.signal.aborted) this.data = data;
        })
        .catch((error) => {
          // A failed scan keeps the last complete reading and its measurement
          // time, and says what went wrong beside them. Publishing what a
          // stopped traversal had counted would report a partial total as the
          // size of the directory.
          if (controller.signal.aborted) return;
          this.data = {
            ...this.data,
            errors: [
              {
                source: "scratch scan",
                message: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        })
        .finally(() => {
          // Eligibility runs from completion. Measured from the attempt, a
          // scan that outlasts the interval is eligible again the instant it
          // finishes, which is what left the traversal running without pause.
          this.finished = this.clock();
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
    this.runner.close();
  }
}
