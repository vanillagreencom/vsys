import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { Collector } from "./collector";
import {
  type ProcessMessage,
  type ProcessPort,
  type ProcessReply,
  ProcessThread,
} from "./process-thread";
import { ProcessCollector, type ProcessRequest } from "./procs";

const fixtures: ReturnType<typeof fixture>[] = [];
const closers: { close(): void }[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c.close();
  for (const f of fixtures.splice(0)) f.cleanup();
});
const setup = () => {
  const f = fixture();
  fixtures.push(f);
  return f;
};
const owned = <T extends { close(): void }>(value: T): T => {
  closers.push(value);
  return value;
};
const live = () => new AbortController().signal;
const request = (time: number, pids: number[] = []): ProcessRequest => ({
  time,
  uptime: 1000,
  groups: [{ pids, kernelPath: undefined }],
});

/**
 * A thread the test drives by hand: it records what the host sent and the
 * calls the host made, and answers only when told to.
 */
class FakePort implements ProcessPort {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: ProcessMessage[] = [];
  calls: string[] = [];
  private closeHandlers: (() => void)[] = [];
  addEventListener(_kind: "close", handler: () => void): void {
    this.closeHandlers.push(handler);
  }
  postMessage(message: ProcessMessage): void {
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
  reply(data: ProcessReply): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
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
    if (last?.kind !== "collect") throw new Error("No request was sent");
    return last.id;
  }
}
const reading = { procs: [], errors: [] };
function fakes() {
  const ports: FakePort[] = [];
  const f = setup();
  const thread = owned(
    new ProcessThread(f.config, 100, 4096, () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    }),
  );
  return { ports, thread };
}

/**
 * A fixture whose readings exercise every per-process rule: watched and
 * unwatched membership, agents and build tools whose environment is read, a
 * Git branch, a stat line the kernel would never write, and an environment
 * this user may not read.
 */
function populated() {
  const f = setup();
  mkdirSync(join(f.root, "repo/.git"), { recursive: true });
  f.write(join(f.root, "repo/.git/HEAD"), "ref: refs/heads/feature/lane\n");
  f.group("agents.slice/a.scope", [40, 41, 42]);
  f.proc(40, "agents.slice/a.scope", {
    env: "CLAUDE_CONFIG_DIR=/accounts/work\0SECRET=hidden\0",
    cwd: join(f.root, "repo"),
    ticks: 10,
  });
  f.proc(41, "agents.slice/a.scope", {
    command: ["/usr/bin/rustc", "--crate-name", "x"],
    comm: "rustc",
    env: "RUSTC_WRAPPER=sccache\0",
    parent: 40,
  });
  f.proc(42, "agents.slice/a.scope", {
    command: ["/bin/cat"],
    comm: "cat",
    parent: 40,
  });
  f.proc(50, "app.slice/other.scope", { command: ["/usr/bin/editor"] });
  f.proc(60, "app.slice/other.scope");
  rmSync(join(f.config.procRoot, "60/environ"));
  mkdirSync(join(f.config.procRoot, "60/environ"));
  f.write(join(f.config.procRoot, "70/stat"), "70 (broken) S");
  return f;
}

test("the thread reads exactly what the same collector reads in its caller's thread", async () => {
  const f = populated();
  const groups = [{ pids: [40, 41, 42], kernelPath: undefined }];
  const here = new ProcessCollector(f.config, 100, 4096);
  const thread = owned(new ProcessThread(f.config, 100, 4096));
  // Time, the agent's cumulative ticks, and the rate those make against the
  // reading before: 50 ticks over one second at 100 ticks a second is 50%.
  for (const [time, ticks, rate] of [
    [1000, 10, null],
    [2000, 60, 50],
    [3000, 61, 1],
  ]) {
    f.proc(40, "agents.slice/a.scope", {
      env: "CLAUDE_CONFIG_DIR=/accounts/work\0SECRET=hidden\0",
      cwd: join(f.root, "repo"),
      ticks: ticks as number,
    });
    const at = { time: time as number, uptime: 1000, groups };
    const expected = here.read(at);
    const actual = await thread.collect(at, live());
    expect(actual).toEqual(expected);
    // The fixture must reach what it was built to reach, or equality above
    // proves nothing about those rules.
    expect(actual.procs.map((p) => p.pid).sort()).toEqual([40, 41, 42, 50, 60]);
    expect(actual.errors.map((e) => e.source)).toEqual([
      join(f.config.procRoot, "70"),
      join(f.config.procRoot, "60/environ"),
    ]);
    const agent = actual.procs.find((p) => p.pid === 40);
    expect(agent?.env).toEqual({ CLAUDE_CONFIG_DIR: "/accounts/work" });
    expect(agent?.branch).toBe("feature/lane");
    expect(actual.procs.find((p) => p.pid === 41)?.env).toEqual({
      RUSTC_WRAPPER: "sccache",
    });
    expect(agent?.cpuPercent).toBe(rate);
  }
});

test("a collector on a thread publishes the snapshot a collector without one does", async () => {
  const f = populated();
  const here = new Collector(f.config, 100, 4096);
  const there = owned(
    new Collector(
      f.config,
      100,
      4096,
      false,
      undefined,
      undefined,
      new ProcessThread(f.config, 100, 4096),
    ),
  );
  for (const time of [1000, 2000]) {
    const a = await here.sample(time);
    const b = await there.sample(time);
    expect({ ...b, durationMs: 0 }).toEqual({ ...a, durationMs: 0 });
    expect(b.procs.length).toBe(5);
    // What the thread could not read reaches the snapshot's own errors.
    expect(b.errors.map((e) => e.source)).toContain(
      join(f.config.procRoot, "70"),
    );
  }
});

test("exit, identity reuse and a changed command line each read fresh through the thread", async () => {
  const f = setup();
  f.group("agents.slice/a.scope", [40, 41]);
  f.proc(40, "agents.slice/a.scope", {
    env: "CLAUDE_CONFIG_DIR=/accounts/work\0",
    ticks: 10,
  });
  f.proc(41, "agents.slice/a.scope", { parent: 40 });
  const thread = owned(new ProcessThread(f.config, 100, 4096));
  const first = await thread.collect(request(1000, [40, 41]), live());
  expect(first.procs.map((p) => p.pid).sort()).toEqual([40, 41]);

  // Exit: the process is gone and nothing is reported against it.
  rmSync(join(f.config.procRoot, "41"), { recursive: true });
  // A changed command line under the same identity is read again, not kept.
  f.proc(40, "agents.slice/a.scope", {
    command: ["/usr/bin/claude", "--resume"],
    env: "CLAUDE_CONFIG_DIR=/accounts/changed\0",
    ticks: 60,
  });
  const second = await thread.collect(request(2000, [40]), live());
  expect(second.errors).toEqual([]);
  expect(second.procs.map((p) => p.pid)).toEqual([40]);
  expect(second.procs[0].command).toEqual(["/usr/bin/claude", "--resume"]);
  expect(second.procs[0].cpuPercent).toBe(50);
  // The launch environment is fixed for one identity, so it stays cached.
  expect(second.procs[0].env).toEqual({ CLAUDE_CONFIG_DIR: "/accounts/work" });

  // Reuse: the same id with a later start is another process. Its counters
  // and environment are its own.
  f.proc(40, "agents.slice/a.scope", {
    start: 500,
    ticks: 1,
    env: "CLAUDE_CONFIG_DIR=/accounts/new\0",
  });
  const reused = await thread.collect(request(3000, [40]), live());
  expect(reused.procs[0].cpuPercent).toBeNull();
  expect(reused.procs[0].env).toEqual({ CLAUDE_CONFIG_DIR: "/accounts/new" });
});

test("a new thread for new settings reads under those settings and the old one ends", async () => {
  const f = setup();
  f.group("agents.slice/a.scope", [40]);
  f.proc(40, "agents.slice/a.scope", {
    command: ["/usr/bin/newagent"],
    comm: "newagent",
  });
  const old = new ProcessThread(f.config, 100, 4096);
  const before = new Collector(
    f.config,
    100,
    4096,
    false,
    undefined,
    undefined,
    old,
  );
  expect((await before.sample(1000)).procs[0].tool).toBeNull();
  const next = {
    ...f.config,
    agentTools: [...f.config.agentTools, "newagent"],
  };
  const after = owned(
    new Collector(
      next,
      100,
      4096,
      false,
      undefined,
      undefined,
      new ProcessThread(next, 100, 4096),
    ),
  );
  before.close();
  expect(() => old.collect(request(2000), live())).toThrow(
    "Process thread has closed",
  );
  expect((await after.sample(2000)).procs[0].tool).toBe("newagent");
});

test("closing a collector ends its process thread", async () => {
  const { ports, thread } = fakes();
  const f = setup();
  const collector = new Collector(
    f.config,
    100,
    4096,
    false,
    undefined,
    undefined,
    thread,
  );
  // A sample in flight is cancelled with the collector.
  const cancelled = collector.sample(1000);
  const [first] = ports;
  collector.close();
  await expect(cancelled).rejects.toThrow();
  expect(first.calls).toContain("terminate");
  // An idle thread holds the counters until its collector is closed.
  const later = fakes();
  const idle = new Collector(
    f.config,
    100,
    4096,
    false,
    undefined,
    undefined,
    later.thread,
  );
  const done = idle.sample(1000);
  const [second] = later.ports;
  second.reply({ kind: "collected", id: second.lastId(), reading });
  await done;
  expect(second.calls).not.toContain("terminate");
  idle.close();
  expect(second.calls).toContain("terminate");
});

test("the host sends setup before the first request and holds the program only while one waits", async () => {
  const { ports, thread } = fakes();
  const answer = thread.collect(request(1000), live());
  const [port] = ports;
  expect(port.sent.map((m) => m.kind)).toEqual(["setup", "collect"]);
  expect(port.calls).toEqual(["ref"]);
  port.reply({ kind: "collected", id: port.lastId(), reading });
  expect(await answer).toEqual(reading);
  expect(port.calls).toEqual(["ref", "unref"]);
  // The next request reuses the thread that holds the counters.
  const again = thread.collect(request(2000), live());
  port.reply({ kind: "collected", id: port.lastId(), reading });
  await again;
  expect(ports.length).toBe(1);
});

test("a reply to another request is not taken as this one's", async () => {
  const { ports, thread } = fakes();
  const answer = thread.collect(request(1000), live());
  const [port] = ports;
  let settled = false;
  void answer.then(() => {
    settled = true;
  });
  port.reply({ kind: "collected", id: port.lastId() + 1, reading });
  await Bun.sleep(0);
  expect(settled).toBe(false);
  port.reply({ kind: "collected", id: port.lastId(), reading });
  expect(await answer).toEqual(reading);
});

test("a failed reading, a thread error and an early exit each reject, and the next request has a thread", async () => {
  const { ports, thread } = fakes();
  // What the thread does, what the caller is told, and whether the thread
  // is ended: a reading that failed leaves a working thread, which keeps the
  // counters the next reading compares against.
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
      "Process thread failed: module not found",
      true,
    ],
    [
      "exit",
      (port) => port.exit(),
      "Process thread exited before it answered",
      true,
    ],
  ];
  for (const [name, act, message, ends] of cases) {
    const answer = thread.collect(request(1000), live());
    const port = ports.at(-1) as FakePort;
    act(port);
    await expect(answer, name).rejects.toThrow(message);
    expect(port.calls.includes("terminate"), name).toBe(ends);
  }
  expect(ports.length).toBe(2);
  const next = thread.collect(request(2000), live());
  const fresh = ports.at(-1) as FakePort;
  expect(ports.length).toBe(3);
  expect(fresh.sent.map((m) => m.kind)).toEqual(["setup", "collect"]);
  fresh.reply({ kind: "collected", id: fresh.lastId(), reading });
  expect(await next).toEqual(reading);
});

test("cancelling and closing end the thread, and a late reply publishes nothing", async () => {
  const { ports, thread } = fakes();
  const controller = new AbortController();
  const cancelled = thread.collect(request(1000), controller.signal);
  const [first] = ports;
  const id = first.lastId();
  controller.abort(new Error("collector closed"));
  await expect(cancelled).rejects.toThrow("collector closed");
  expect(first.calls).toContain("terminate");
  // The ended thread's last word arrives after the host moved on.
  first.reply({ kind: "collected", id, reading });

  const waiting = thread.collect(request(2000), live());
  const second = ports[1];
  thread.close();
  await expect(waiting).rejects.toThrow("Process thread has closed");
  expect(second.calls).toContain("terminate");
  expect(() => thread.collect(request(3000), live())).toThrow(
    "Process thread has closed",
  );
  expect(ports.length).toBe(2);
});

test("a late error or exit from a thread already replaced leaves the thread now running alone", async () => {
  const rows: [string, (port: FakePort) => void][] = [
    ["exit", (port) => port.exit()],
    ["error", (port) => port.fail("late")],
  ];
  for (const [name, late] of rows) {
    const { ports, thread } = fakes();
    const first = thread.collect(request(1000), live());
    const [ended] = ports;
    ended.fail("ended");
    await expect(first, name).rejects.toThrow("Process thread failed: ended");
    const second = thread.collect(request(2000), live());
    const running = ports[1];
    late(ended);
    expect(running.calls, name).not.toContain("terminate");
    running.reply({ kind: "collected", id: running.lastId(), reading });
    expect(await second, name).toEqual(reading);
  }
});

test("every ending releases the thread before ending it, so a blocked read never holds the program", async () => {
  // How each path ends the thread waiting on a request.
  const rows: [
    string,
    (port: FakePort, cancel: AbortController, thread: ProcessThread) => void,
  ][] = [
    ["abort", (_port, cancel) => cancel.abort(new Error("cancelled"))],
    ["error", (port) => port.fail("boom")],
    ["exit", (port) => port.exit()],
    ["close", (_port, _cancel, thread) => thread.close()],
  ];
  for (const [name, end] of rows) {
    const { ports, thread } = fakes();
    const cancel = new AbortController();
    const answer = thread.collect(request(1000), cancel.signal);
    const [port] = ports;
    end(port, cancel, thread);
    await expect(answer, name).rejects.toThrow();
    expect(port.calls, name).toEqual(["ref", "unref", "terminate"]);
  }
});

test("a second request while one is in flight is refused rather than orphaning the first", async () => {
  const { ports, thread } = fakes();
  const first = thread.collect(request(1000), live());
  // An accepted second request would leave the first waiting forever, so the
  // answer is read here rather than left for the runner's timeout to find.
  let second: string;
  try {
    thread.collect(request(2000), live()).catch(() => {});
    second = "accepted";
  } catch (error) {
    second = (error as Error).message;
  }
  expect(second).toContain("Process collection was asked to overlap");
  const [port] = ports;
  port.reply({ kind: "collected", id: port.lastId(), reading });
  expect(await first).toEqual(reading);
});
