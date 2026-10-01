import type {
  PacedScan,
  ScanBudget,
  ScanReply,
  ScanRequest,
  ScratchScan,
} from "./scratch-scan";
import type { CollectionConfig } from "./settings";
import { workerFile } from "./worker-file";
import { WorkerHost, type WorkerPort } from "./worker-host";

/** What this host calls on a scan thread. */
export type ScanThread = WorkerPort<ScanRequest, ScanReply>;

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
  ): Promise<PacedScan>;
  close(): void;
}

/**
 * The scan thread, started at the first scan and kept: a dashboard scans
 * again every interval, and a thread started per scan pays its startup cost
 * on every one of them. One scan runs at a time, because the collector holds
 * a single job and only starts the next after that job settles. A scan its
 * caller abandons ends the thread, which is how a traversal is stopped.
 */
export class WorkerScan implements ScanRunner {
  private host: WorkerHost<ScanRequest, ScanReply, PacedScan>;
  /** The program starts a real thread; a test stands up its own. */
  constructor(
    start: () => ScanThread = () =>
      new Worker(workerFile("scratch-worker"), {
        type: "module",
      }) as Bun.Worker,
  ) {
    this.host = new WorkerHost({
      name: "Scratch scan thread",
      start,
      decode: (data) => data,
    });
  }
  run(
    c: CollectionConfig,
    time: number,
    budget: ScanBudget,
    signal: AbortSignal,
  ): Promise<PacedScan> {
    return this.host.request(
      (id) => ({ id, config: c, time, budget }) satisfies ScanRequest,
      signal,
    );
  }
  close(): void {
    this.host.close();
  }
}

/** The granularity the reader's share is enforced at. */
const SLICE_MS = 4;

/** A live dashboard reuses completed scans while a single scan runs. */
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
      // scan holds the thread throughout.
      const budget: ScanBudget = {
        sliceMs: SLICE_MS,
        dutyPercent: wait ? 100 : c.scratchDutyPercent,
      };
      this.job = Promise.resolve()
        .then(() => this.runner.run(c, time, budget, controller.signal))
        .then(({ scan }) => {
          if (!controller.signal.aborted) this.data = scan;
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
