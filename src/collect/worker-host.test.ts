import { expect, test } from "bun:test";
import {
  WorkerHost,
  type WorkerPort,
  type WorkerReply,
  type WorkerSpec,
} from "./worker-host";

type Message = { kind: "setup" } | { kind: "ask"; id: number };
type Reply = WorkerReply<string>;
const live = () => new AbortController().signal;
const ask = (id: number): Message => ({ kind: "ask", id });

/**
 * A thread the test drives by hand: it records what the host sent and the
 * calls the host made, and answers only when told to.
 */
class FakePort implements WorkerPort<Message, Reply> {
  onmessage: ((event: MessageEvent<Reply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: Message[] = [];
  calls: string[] = [];
  private closeHandlers: (() => void)[] = [];
  addEventListener(_kind: "close", handler: () => void): void {
    this.closeHandlers.push(handler);
  }
  postMessage(message: Message): void {
    this.sent.push(message);
  }
  ref(): void {
    this.calls.push("ref");
  }
  unref(): void {
    this.calls.push("unref");
  }
  terminate(): void {
    this.calls.push("terminate");
  }
  reply(data: Reply): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  answer(value: string): void {
    this.reply({ kind: "answer", id: this.lastId(), value });
  }
  fail(message: string): void {
    this.onerror?.(new ErrorEvent("error", { message }));
  }
  exit(): void {
    for (const handler of this.closeHandlers) handler();
  }
  /** The id of the last request this thread was sent. */
  lastId(): number {
    const last = this.sent.at(-1);
    if (last?.kind !== "ask") throw new Error("No request was sent");
    return last.id;
  }
}
function fakes(spec: Partial<WorkerSpec<Message, Reply, string>> = {}) {
  const ports: FakePort[] = [];
  const host = new WorkerHost<Message, Reply, string>({
    name: "Test thread",
    start: () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    decode: (data) => data,
    ...spec,
  });
  return { ports, host };
}

test("the first request starts the thread after its setup, and the thread serves every request after it", async () => {
  const { ports, host } = fakes({ setup: { kind: "setup" } });
  const first = host.request(ask, live());
  const [port] = ports;
  expect(port.sent.map((m) => m.kind)).toEqual(["setup", "ask"]);
  // A waiting request holds the program; an answered one does not.
  expect(port.calls).toEqual(["ref"]);
  port.answer("one");
  expect(await first).toBe("one");
  expect(port.calls).toEqual(["ref", "unref"]);
  const second = host.request(ask, live());
  port.answer("two");
  expect(await second).toBe("two");
  expect(ports.length).toBe(1);
  expect(port.sent.map((m) => m.kind)).toEqual(["setup", "ask", "ask"]);
  host.close();
});

test("a reply to another request is not taken as this one's", async () => {
  const { ports, host } = fakes();
  const answer = host.request(ask, live());
  const [port] = ports;
  let settled = false;
  void answer.then(() => {
    settled = true;
  });
  port.reply({ kind: "answer", id: port.lastId() + 1, value: "other" });
  await Bun.sleep(0);
  expect(settled).toBe(false);
  port.answer("mine");
  expect(await answer).toBe("mine");
  host.close();
});

test("a failed answer, a thread error and an early exit each reject, and the next request has a thread", async () => {
  const { ports, host } = fakes({ setup: { kind: "setup" } });
  // What the thread does, what the caller is told, and whether the thread
  // is ended: a failed answer leaves a working thread, which keeps whatever
  // state the next answer depends on.
  const cases: [string, (port: FakePort) => void, string, boolean][] = [
    [
      "failed",
      (port) =>
        port.reply({ kind: "failed", id: port.lastId(), message: "no /proc" }),
      "no /proc",
      false,
    ],
    [
      "error",
      (port) => port.fail("module not found"),
      "Test thread failed: module not found",
      true,
    ],
    [
      "exit",
      (port) => port.exit(),
      "Test thread exited before it answered",
      true,
    ],
  ];
  for (const [name, act, message, ends] of cases) {
    const answer = host.request(ask, live());
    const port = ports.at(-1) as FakePort;
    act(port);
    await expect(answer, name).rejects.toThrow(message);
    expect(port.calls.includes("terminate"), name).toBe(ends);
  }
  expect(ports.length).toBe(2);
  const next = host.request(ask, live());
  const fresh = ports.at(-1) as FakePort;
  expect(ports.length).toBe(3);
  expect(fresh.sent.map((m) => m.kind)).toEqual(["setup", "ask"]);
  fresh.answer("fresh");
  expect(await next).toBe("fresh");
  host.close();
});

test("cancelling and closing end the thread, and a late reply publishes nothing", async () => {
  const { ports, host } = fakes();
  const controller = new AbortController();
  const cancelled = host.request(ask, controller.signal);
  const [first] = ports;
  controller.abort(new Error("collector closed"));
  await expect(cancelled).rejects.toThrow("collector closed");
  expect(first.calls).toContain("terminate");

  const waiting = host.request(ask, live());
  const second = ports[1];
  let settled = false;
  void waiting.then(
    () => {
      settled = true;
    },
    () => {},
  );
  // The ended thread's last word arrives while a request waits on its
  // replacement, and names that request, so only the thread decides it.
  first.reply({ kind: "answer", id: second.lastId(), value: "stale" });
  await Bun.sleep(0);
  expect(settled).toBe(false);
  host.close();
  await expect(waiting).rejects.toThrow("Test thread has closed");
  expect(second.calls).toContain("terminate");
  expect(ports.length).toBe(2);
});

test("a late error or exit from a thread already replaced leaves the thread now running alone", async () => {
  const rows: [string, (port: FakePort) => void][] = [
    ["exit", (port) => port.exit()],
    ["error", (port) => port.fail("late")],
  ];
  for (const [name, late] of rows) {
    const { ports, host } = fakes();
    const first = host.request(ask, live());
    const [ended] = ports;
    ended.fail("ended");
    await expect(first, name).rejects.toThrow("Test thread failed: ended");
    const second = host.request(ask, live());
    const running = ports[1];
    late(ended);
    expect(running.calls, name).not.toContain("terminate");
    running.answer("running");
    expect(await second, name).toBe("running");
    host.close();
  }
});

test("every ending releases the thread before ending it, so a blocked read never holds the program", async () => {
  // How each path ends the thread waiting on a request.
  const rows: [
    string,
    (
      port: FakePort,
      cancel: AbortController,
      host: WorkerHost<Message, Reply, string>,
    ) => void,
  ][] = [
    ["abort", (_port, cancel) => cancel.abort(new Error("cancelled"))],
    ["error", (port) => port.fail("boom")],
    ["exit", (port) => port.exit()],
    ["close", (_port, _cancel, host) => host.close()],
  ];
  for (const [name, end] of rows) {
    const { ports, host } = fakes();
    const cancel = new AbortController();
    const answer = host.request(ask, cancel.signal);
    const [port] = ports;
    end(port, cancel, host);
    await expect(answer, name).rejects.toThrow();
    expect(port.calls, name).toEqual(["ref", "unref", "terminate"]);
    host.close();
  }
});

test("a request the host cannot serve is refused before it reaches a thread", async () => {
  // How the host is left, and the refusal the next request meets. An
  // accepted overlap would leave the first request waiting forever, so each
  // answer is read here rather than left for the runner's timeout to find.
  const rows: [
    string,
    (host: WorkerHost<Message, Reply, string>) => AbortSignal,
    string,
    number,
  ][] = [
    [
      "overlap",
      (host) => {
        host.request(ask, live()).catch(() => {});
        return live();
      },
      "Test thread was asked to overlap: a request is already in flight",
      1,
    ],
    [
      "closed",
      (host) => {
        host.close();
        return live();
      },
      "Test thread has closed",
      0,
    ],
    ["aborted", () => AbortSignal.abort(new Error("gone")), "gone", 0],
  ];
  for (const [name, leave, message, started] of rows) {
    const { ports, host } = fakes();
    const signal = leave(host);
    let refusal: string;
    try {
      host.request(ask, signal).catch(() => {});
      refusal = "accepted";
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect({ name, refusal, started: ports.length }).toEqual({
      name,
      refusal: message,
      started,
    });
    host.close();
  }
});
