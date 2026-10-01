import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ProcessReading, ProcessRequest, ProcessSource } from "./procs";
import type { CollectionConfig } from "./settings";

/** What the host sends a process thread. Setup always precedes a request. */
export type ProcessMessage =
  | {
      kind: "setup";
      config: CollectionConfig;
      ticksPerSecond: number;
      pageSize: number;
    }
  | { kind: "collect"; id: number; request: ProcessRequest };
/**
 * A thread's answer to one request, named by that request's id. It crosses
 * as JSON text: Bun hands a string over without cloning it, and parsing a
 * reading costs this thread less than reading a structured clone of it.
 * Every value in a reading is a string, a finite number, a boolean or null,
 * so the text carries it exactly.
 */
export type ProcessReply =
  | { kind: "collected"; id: number; reading: ProcessReading }
  | { kind: "failed"; id: number; message: string };

/**
 * The process thread's own module: the source file beside this one, or the
 * built one. Bun's bundler does not follow a worker URL, so every build names
 * the worker as a second entry point, and the bundle places it at
 * `collect/process-worker.js` beside its main file, which is what
 * `import.meta.url` names once bundled. Neither present is a broken build.
 */
function workerFile(): URL {
  const candidates = ["./process-worker.ts", "./collect/process-worker.js"].map(
    (name) => new URL(name, import.meta.url),
  );
  const found = candidates.find((url) => existsSync(fileURLToPath(url)));
  if (found === undefined)
    throw new Error(
      `No process worker beside ${fileURLToPath(import.meta.url)}`,
    );
  return found;
}

/**
 * What this host calls on a thread, and all of it. A real `Worker` satisfies
 * it, so a test stands up its own and the compiler still checks the fake
 * against every member the host reaches for.
 */
export interface ProcessPort {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  addEventListener(kind: "close", handler: () => void): void;
  postMessage(message: ProcessMessage): void;
  ref(): void;
  unref(): void;
  terminate(): void;
}

// REVISIT(D008): a sample's elapsed time misses the 20 ms fixture target here.
/**
 * Process collection on a thread of its own, kept for the life of one
 * collector. The thread holds the environment cache and the last reading's
 * counters, so a sample sends only what changed since: the time, the uptime
 * and the watched membership. A change to a collection setting, one of
 * `collectionKeys` in `./settings`, builds a new collector, and with it a new
 * thread that starts from nothing; any other setting keeps both.
 *
 * The thread does no work between requests. A request it has not answered is
 * the only one in flight, because the collector awaits each sample.
 */
export class ProcessThread implements ProcessSource {
  private worker?: ProcessPort;
  private id = 0;
  private pending?: {
    id: number;
    resolve: (reading: ProcessReading) => void;
    reject: (error: unknown) => void;
    /** Drops the abort listener, which would otherwise outlive the request. */
    release: () => void;
  };
  private closed = false;
  constructor(
    private config: CollectionConfig,
    private ticksPerSecond: number,
    private pageSize: number,
    /**
     * The program starts a real thread; a test stands up its own. The DOM
     * library's `Worker` type, which this project compiles against, omits
     * Bun's `ref` and `unref`.
     */
    private start: () => ProcessPort = () =>
      new Worker(workerFile(), { ref: false }) as Bun.Worker,
  ) {}
  private thread(): ProcessPort {
    if (this.worker) return this.worker;
    const worker = this.start();
    worker.onmessage = (event) => {
      if (this.worker === worker)
        this.receive(JSON.parse(event.data) as ProcessReply);
    };
    // A thread that died owes its caller an answer, and the next sample needs
    // a thread. Each listener names the thread it was registered on: a thread
    // this host already replaced still delivers its last events, and acting
    // on one would end the thread now running.
    worker.onerror = (event) => {
      if (this.worker === worker)
        this.fail(new Error(`Process thread failed: ${event.message}`));
    };
    worker.addEventListener("close", () => {
      if (this.worker === worker)
        this.fail(new Error("Process thread exited before it answered"));
    });
    worker.postMessage({
      kind: "setup",
      config: this.config,
      ticksPerSecond: this.ticksPerSecond,
      pageSize: this.pageSize,
    });
    this.worker = worker;
    return worker;
  }
  /**
   * The one teardown: end the thread, then settle whatever was waiting. The
   * thread's environment cache and counters go with it, so the next request
   * starts a thread whose first reading has no rate, which is unknown rather
   * than a rate measured against a reading it never took.
   *
   * Ending a thread cannot interrupt a read blocked in the kernel, such as
   * one on a stalled mount, and a referenced thread keeps the program alive
   * until it exits. The thread is released first, so quitting never waits on
   * a read nobody wants.
   */
  private fail(error: unknown): void {
    const pending = this.pending;
    this.pending = undefined;
    this.worker?.unref();
    this.worker?.terminate();
    this.worker = undefined;
    pending?.release();
    pending?.reject(error);
  }
  private receive(reply: ProcessReply): void {
    const pending = this.pending;
    // A reply to a request the caller already gave up on, from a thread that
    // has not yet been ended. Its reading belongs to no sample.
    if (!pending || pending.id !== reply.id) return;
    this.pending = undefined;
    pending.release();
    this.worker?.unref();
    switch (reply.kind) {
      case "collected":
        pending.resolve(reply.reading);
        return;
      case "failed":
        pending.reject(new Error(reply.message));
        return;
      default: {
        const unhandled: never = reply;
        throw new Error(
          `Process thread sent an unknown reply: ${JSON.stringify(unhandled)}`,
        );
      }
    }
  }
  collect(
    request: ProcessRequest,
    signal: AbortSignal,
  ): Promise<ProcessReading> {
    if (this.closed) throw new Error("Process thread has closed");
    if (this.pending)
      throw new Error(
        "Process collection was asked to overlap: a request is already in flight",
      );
    signal.throwIfAborted();
    const id = ++this.id;
    const worker = this.thread();
    return new Promise<ProcessReading>((resolve, reject) => {
      // A cancelled request ends its thread, since a thread still reading
      // would hold the next request behind a reading nobody wants.
      const cancel = () => {
        if (this.pending?.id === id) this.fail(signal.reason);
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.pending = {
        id,
        resolve,
        reject,
        release: () => signal.removeEventListener("abort", cancel),
      };
      // A waiting request keeps the program alive; an idle thread does not.
      worker.ref();
      worker.postMessage({ kind: "collect", id, request });
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("Process thread has closed"));
  }
}
