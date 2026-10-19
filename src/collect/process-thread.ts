import type { AgentToolsDocument } from "../config/agent-tools";
import type {
  OpenFiles,
  ProcessReading,
  ProcessRequest,
  ProcessSource,
} from "./procs";
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
      tools: AgentToolsDocument;
    }
  | { kind: "collect"; id: number; request: ProcessRequest }
  | { kind: "files"; id: number; pids: number[]; dirs: string[] };
/**
 * A thread's answer to one request. It crosses as JSON text: Bun hands a
 * string over without cloning it, and parsing a reading costs this thread
 * less than reading a structured clone of it. Every value in a reading is a
 * string, a finite number, a boolean or null, so the text carries it exactly.
 */
export type ProcessReply = WorkerReply<ProcessReading | OpenFiles>;

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
 * the only one in flight: the collector sends no sample's request while one
 * is unanswered, and the agent detail asks for open files on its own clock,
 * so a request that arrives while another is unanswered waits its turn here.
 */
export class ProcessThread implements ProcessSource {
  private host: WorkerHost<ProcessMessage, string, ProcessReading | OpenFiles>;
  /** Settles once the last request sent or queued has. */
  private queue?: Promise<void>;
  constructor(
    config: CollectionConfig,
    ticksPerSecond: number,
    pageSize: number,
    tools: AgentToolsDocument,
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
      setup: { kind: "setup", config, ticksPerSecond, pageSize, tools },
    });
  }
  /**
   * Sends at once when the thread is idle, so a closed host still refuses in
   * the caller's turn, and otherwise after every request before it settles.
   */
  private send(
    build: (id: number) => ProcessMessage,
    signal: AbortSignal,
  ): Promise<ProcessReading | OpenFiles> {
    const ask = () => this.host.request(build, signal);
    const answer = this.queue ? this.queue.then(ask, ask) : ask();
    const settled = answer.then(
      () => {},
      () => {},
    );
    this.queue = settled;
    void settled.then(() => {
      if (this.queue === settled) this.queue = undefined;
    });
    return answer;
  }
  // The thread answers each message with the kind it was sent; each check
  // below only narrows the shared reply type to that kind.
  collect(
    request: ProcessRequest,
    signal: AbortSignal,
  ): Promise<ProcessReading> {
    return this.send((id) => ({ kind: "collect", id, request }), signal).then(
      (answer) => {
        if ("files" in answer)
          throw new Error("Process thread answered a sample with open files");
        return answer;
      },
    );
  }
  openFiles(
    pids: number[],
    dirs: string[],
    signal: AbortSignal,
  ): Promise<OpenFiles> {
    return this.send((id) => ({ kind: "files", id, pids, dirs }), signal).then(
      (answer) => {
        if (!("files" in answer))
          throw new Error("Process thread answered open files with a sample");
        return answer;
      },
    );
  }
  close(): void {
    this.host.close();
  }
}
