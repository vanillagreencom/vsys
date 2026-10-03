import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { shippedAgentTools } from "../config/agent-tools";
import { claudeLink, fixture } from "../test/fixture";
import { present } from "../test/present";
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
 * calls the host made, and answers only when told to. Each way a thread
 * fails is driven in the host's own suite.
 */
class FakePort implements ProcessPort {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: ProcessMessage[] = [];
  calls: string[] = [];
  addEventListener(_kind: "close", _handler: () => void): void {}
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
    new ProcessThread(f.config, 100, 4096, shippedAgentTools, () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    }),
  );
  return { ports, thread, config: f.config };
}

/**
 * A fixture whose readings exercise every per-process rule: watched and
 * unwatched membership, agents and build tools whose environment is read, a
 * desktop app whose binary carries an agent's name, a Git branch, a stat line
 * the kernel would never write, and an environment this user may not read.
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
  f.proc(51, "app.slice/app-com.anthropic.Claude-51.scope", {
    command: ["/tmp/.mount_claudeBHBhLJ/usr/lib/claude-desktop/claude"],
  });
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
  const thread = owned(
    new ProcessThread(f.config, 100, 4096, shippedAgentTools),
  );
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
    expect(actual.procs.map((p) => p.pid).sort()).toEqual([
      40, 41, 42, 50, 51, 60,
    ]);
    expect(actual.procs.find((p) => p.pid === 51)?.tool).toBeNull();
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
      new ProcessThread(f.config, 100, 4096, shippedAgentTools),
    ),
  );
  for (const time of [1000, 2000]) {
    const a = await here.sample(time);
    const b = await there.sample(time);
    expect({ ...b, durationMs: 0 }).toEqual({ ...a, durationMs: 0 });
    expect(b.procs.length).toBe(6);
    // What the thread could not read reaches the snapshot's own errors.
    expect(b.errors.map((e) => e.source)).toContain(
      join(f.config.procRoot, "70"),
    );
  }
});

test("exit, identity reuse, a changed command line and an unchanged one each read through the thread as execve requires", async () => {
  const f = setup();
  f.group("agents.slice/a.scope", [40, 41]);
  f.proc(40, "agents.slice/a.scope", {
    env: "CLAUDE_CONFIG_DIR=/accounts/work\0",
    ticks: 10,
  });
  f.proc(41, "agents.slice/a.scope", { parent: 40 });
  const thread = owned(
    new ProcessThread(f.config, 100, 4096, shippedAgentTools),
  );
  const first = await thread.collect(request(1000, [40, 41]), live());
  expect(first.procs.map((p) => p.pid).sort()).toEqual([40, 41]);

  // Exit: the process is gone and nothing is reported against it.
  rmSync(join(f.config.procRoot, "41"), { recursive: true });
  // execve() keeps a process's pid and start time but replaces its
  // environment, so a changed command line under the same identity is read
  // again rather than kept.
  f.proc(40, "agents.slice/a.scope", {
    command: [claudeLink, "--resume"],
    env: "CLAUDE_CONFIG_DIR=/accounts/changed\0",
    ticks: 60,
  });
  const second = await thread.collect(request(2000, [40]), live());
  expect(second.errors).toEqual([]);
  expect(second.procs.map((p) => p.pid)).toEqual([40]);
  expect(second.procs[0]?.command).toEqual([claudeLink, "--resume"]);
  expect(second.procs[0]?.cpuPercent).toBe(50);
  expect(second.procs[0]?.env).toEqual({
    CLAUDE_CONFIG_DIR: "/accounts/changed",
  });

  // An unchanged command line under the same identity keeps the cached read,
  // even though the environ file on disk now differs.
  f.proc(40, "agents.slice/a.scope", {
    command: [claudeLink, "--resume"],
    env: "CLAUDE_CONFIG_DIR=/accounts/stale\0",
    ticks: 61,
  });
  const third = await thread.collect(request(2500, [40]), live());
  expect(third.procs[0]?.env).toEqual({
    CLAUDE_CONFIG_DIR: "/accounts/changed",
  });

  // Reuse: the same id with a later start is another process. Its counters
  // and environment are its own.
  f.proc(40, "agents.slice/a.scope", {
    start: 500,
    ticks: 1,
    env: "CLAUDE_CONFIG_DIR=/accounts/new\0",
  });
  const reused = await thread.collect(request(3000, [40]), live());
  expect(reused.procs[0]?.cpuPercent).toBeNull();
  expect(reused.procs[0]?.env).toEqual({ CLAUDE_CONFIG_DIR: "/accounts/new" });
});

test("a scope main that execs from bash into an agent reads the new account on the next sample", async () => {
  const f = setup();
  f.group("agents.slice/b.scope", [80]);
  f.proc(80, "agents.slice/b.scope", {
    command: ["/bin/bash"],
    comm: "bash",
  });
  const thread = owned(
    new ProcessThread(f.config, 100, 4096, shippedAgentTools),
  );
  const before = await thread.collect(request(1000, [80]), live());
  expect(before.procs[0]?.tool).toBeNull();
  expect(before.procs[0]?.env).toEqual({});

  // execve() replaces /proc/PID/environ but keeps the pid and start time, so
  // the shell's cached (empty) environment must not survive the exec.
  f.proc(80, "agents.slice/b.scope", {
    command: [claudeLink],
    env: "CLAUDE_CONFIG_DIR=/accounts/work\0",
  });
  const after = await thread.collect(request(2000, [80]), live());
  expect(after.procs[0]?.tool).toBe("claude");
  expect(after.procs[0]?.env).toEqual({ CLAUDE_CONFIG_DIR: "/accounts/work" });
});

test("a new thread for new settings reads under those settings and the old one ends", async () => {
  const f = setup();
  f.group("agents.slice/a.scope", [40]);
  f.proc(40, "agents.slice/a.scope", {
    command: ["/usr/bin/newagent"],
    comm: "newagent",
  });
  const old = new ProcessThread(f.config, 100, 4096, shippedAgentTools);
  const before = new Collector(
    f.config,
    100,
    4096,
    false,
    undefined,
    undefined,
    old,
  );
  expect((await before.sample(1000)).procs[0]?.tool).toBeNull();
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
      new ProcessThread(next, 100, 4096, shippedAgentTools),
    ),
  );
  before.close();
  expect(() => old.collect(request(2000), live())).toThrow(
    "Process thread has closed",
  );
  expect((await after.sample(2000)).procs[0]?.tool).toBe("newagent");
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
  const first = present(ports[0], "started thread");
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
  const second = present(later.ports[0], "started thread");
  second.reply({ kind: "answer", id: second.lastId(), value: reading });
  await done;
  expect(second.calls).not.toContain("terminate");
  idle.close();
  expect(second.calls).toContain("terminate");
});

test("each thread is set up with its collector's settings and answers in JSON text", async () => {
  const { ports, thread, config } = fakes();
  const answer = thread.collect(request(1000), live());
  const port = present(ports[0], "started thread");
  expect(port.sent).toEqual([
    {
      kind: "setup",
      config,
      ticksPerSecond: 100,
      pageSize: 4096,
      tools: shippedAgentTools,
    },
    { kind: "collect", id: 1, request: request(1000) },
  ]);
  port.reply({ kind: "answer", id: port.lastId(), value: reading });
  expect(await answer).toEqual(reading);
});
