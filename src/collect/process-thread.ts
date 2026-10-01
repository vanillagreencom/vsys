import type { ProcessReading, ProcessRequest, ProcessSource } from "./procs";
import type { CollectionConfig } from "./settings";
import { workerFile } from "./worker-file";
import { WorkerHost, type WorkerPort, type WorkerReply } from "./worker-host";

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
 * A thread's answer to one request. It crosses as JSON text: Bun hands a
 * string over without cloning it, and parsing a reading costs this thread
 * less than reading a structured clone of it. Every value in a reading is a
 * string, a finite number, a boolean or null, so the text carries it exactly.
 */
export type ProcessReply = WorkerReply<ProcessReading>;

/** What this host calls on a process thread. */
export type ProcessPort = WorkerPort<ProcessMessage, string>;

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
  private host: WorkerHost<ProcessMessage, string, ProcessReading>;
  constructor(
    config: CollectionConfig,
    ticksPerSecond: number,
    pageSize: number,
    /** The program starts a real thread; a test stands up its own. */
    start: () => ProcessPort = () =>
      new Worker(workerFile("process-worker"), { ref: false }) as Bun.Worker,
  ) {
    // The thread's environment cache and counters go with it when it ends,
    // so the first reading on its replacement has no rate. That rate is
    // unknown rather than measured against a reading it never took.
    this.host = new WorkerHost({
      name: "Process thread",
      start,
      decode: (data) => JSON.parse(data) as ProcessReply,
      setup: { kind: "setup", config, ticksPerSecond, pageSize },
    });
  }
  collect(
    request: ProcessRequest,
    signal: AbortSignal,
  ): Promise<ProcessReading> {
    return this.host.request(
      (id) => ({ kind: "collect", id, request }),
      signal,
    );
  }
  close(): void {
    this.host.close();
  }
}
