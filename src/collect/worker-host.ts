/** A thread's answer to one request, named by that request's id. */
export type WorkerReply<T> =
  | { kind: "answer"; id: number; value: T }
  | { kind: "failed"; id: number; message: string };

/** Why a host rejected a request; an abort rejects with the caller's own reason. */
export type WorkerFailure =
  | "failed"
  | "crashed"
  | "exited"
  | "closed"
  | "overlap";
export class WorkerError extends Error {
  constructor(
    readonly kind: WorkerFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * What a host calls on a thread, and all of it. A real Bun `Worker`
 * satisfies it, so a test stands up its own and the compiler still checks
 * the fake against every member the host reaches for. The DOM library's
 * `Worker` type, which this project compiles against, omits Bun's `ref` and
 * `unref`, so a host's starter casts to `Bun.Worker`.
 */
export interface WorkerPort<Message, Data> {
  onmessage: ((event: MessageEvent<Data>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  addEventListener(kind: "close", handler: () => void): void;
  postMessage(message: Message): void;
  ref(): void;
  unref(): void;
  terminate(): void;
}

/** How one host starts its thread and reads what that thread sends back. */
export interface WorkerSpec<Message, Data, Answer> {
  /** Names the thread in every error this host raises. */
  name: string;
  /**
   * Starts a thread. The host holds the program on it from each request to
   * that request's answer and no longer, whatever the thread started as.
   */
  start: () => WorkerPort<Message, Data>;
  /** Turns one message from the thread into the reply it carries. */
  decode: (data: Data) => WorkerReply<Answer>;
  /** Sent once to each thread, before its first request. */
  setup?: Message;
}

/**
 * One thread serving one request at a time, for every collection thread the
 * program keeps. The thread starts at the first request and is kept until a
 * failure, a cancellation or the close ends it; the next request after that
 * starts a new one. A request the host has not answered is the only one in
 * flight, because each owner awaits its request before sending the next.
 */
export class WorkerHost<Message, Data, Answer> {
  private worker?: WorkerPort<Message, Data>;
  private id = 0;
  private pending?: {
    id: number;
    resolve: (answer: Answer) => void;
    reject: (error: unknown) => void;
    /** Drops the abort listener, which would otherwise outlive the request. */
    release: () => void;
  };
  private closed = false;
  constructor(private spec: WorkerSpec<Message, Data, Answer>) {}
  /** An error naming this host's thread. */
  private error(kind: WorkerFailure, what: string): WorkerError {
    return new WorkerError(kind, `${this.spec.name} ${what}`);
  }
  private thread(): WorkerPort<Message, Data> {
    if (this.worker) return this.worker;
    const worker = this.spec.start();
    worker.onmessage = (event) => {
      if (this.worker === worker) this.receive(this.spec.decode(event.data));
    };
    // A thread that died owes its caller an answer, and the next request
    // needs a thread. Each listener names the thread it was registered on: a
    // thread this host already replaced still delivers its last events, and
    // acting on one would end the thread now running.
    worker.onerror = (event) => {
      if (this.worker === worker)
        this.fail(this.error("crashed", `failed: ${event.message}`));
    };
    worker.addEventListener("close", () => {
      if (this.worker === worker)
        this.fail(this.error("exited", "exited before it answered"));
    });
    if (this.spec.setup !== undefined) worker.postMessage(this.spec.setup);
    this.worker = worker;
    return worker;
  }
  /**
   * The one teardown: end the thread, then settle whatever was waiting.
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
  private receive(reply: WorkerReply<Answer>): void {
    const pending = this.pending;
    // A reply to a request the caller already gave up on, from a thread that
    // has not yet been ended. It belongs to no request still waiting.
    if (!pending || pending.id !== reply.id) return;
    this.pending = undefined;
    pending.release();
    this.worker?.unref();
    switch (reply.kind) {
      case "answer":
        pending.resolve(reply.value);
        return;
      case "failed":
        pending.reject(new WorkerError("failed", reply.message));
        return;
      default: {
        const unhandled: never = reply;
        throw new Error(
          `${this.spec.name} sent an unknown reply: ${JSON.stringify(unhandled)}`,
        );
      }
    }
  }
  /** Sends the message `build` makes for this request's id. */
  request(
    build: (id: number) => Message,
    signal: AbortSignal,
  ): Promise<Answer> {
    if (this.closed) throw this.error("closed", "has closed");
    if (this.pending)
      throw this.error(
        "overlap",
        "was asked to overlap: a request is already in flight",
      );
    signal.throwIfAborted();
    const id = ++this.id;
    const worker = this.thread();
    return new Promise<Answer>((resolve, reject) => {
      // A cancelled request ends its thread, since a thread still working
      // would hold the next request behind an answer nobody wants.
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
      worker.postMessage(build(id));
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(this.error("closed", "has closed"));
  }
}
