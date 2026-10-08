import { afterEach, expect, test } from "bun:test";
import { closeSync, constants, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { shippedAgentTools } from "../config/agent-tools";
import type { Snapshot } from "../model/types";
import { Session } from "../runtime";
import { EventLog } from "../store/events";
import { History } from "../store/history";
import { fixture } from "../test/fixture";
import { Collector } from "./collector";
import { ProcessThread } from "./process-thread";
import {
  ProcessCollector,
  type ProcessReading,
  type ProcessRequest,
  type ProcessSource,
} from "./procs";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
const setup = () => {
  const f = fixture();
  fixtures.push(f);
  return f;
};

test("A6-2: a blocked process-file read does not silently stop sampling", async () => {
  const f = setup();
  f.config.refreshMs = 100;
  f.proc(40, "agents.slice");
  const thread = new ProcessThread(f.config, 100, 4096, shippedAgentTools);
  const collector = new Collector(
    f.config,
    100,
    4096,
    true,
    undefined,
    undefined,
    thread,
  );
  const first = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<Snapshot>();
  const errors: unknown[] = [];
  let frames = 0;
  // Set once the thread is blocked in its read. Every sample before that one
  // has already drawn its frame, because the session awaits each sample.
  let stalled = false;
  let writer: number | undefined;
  const session = new Session(
    f.config,
    () => "unused",
    {
      sample: () =>
        collector.sample(Date.now(), undefined, { skipScratch: true }),
      close: () => collector.close(),
    },
    new History(f.config),
    {
      frame: (snapshot) => {
        frames++;
        if (frames === 1) first.resolve();
        if (stalled) resumed.resolve(snapshot);
      },
      error: (error) => {
        errors.push(error);
        first.reject(error);
        resumed.reject(error);
      },
    },
  );
  try {
    session.start();
    await first.promise;
    const path = join(f.config.procRoot, "40/cmdline");
    rmSync(path);
    expect(Bun.spawnSync(["/usr/bin/mkfifo", path]).exitCode).toBe(0);
    const deadline = performance.now() + 2000;
    while (writer === undefined && performance.now() < deadline) {
      try {
        writer = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
        await Bun.sleep(5);
      }
    }
    // A successful nonblocking writer open proves the real thread opened its
    // reader, so its read now blocks until something is written.
    expect(writer).toBeDefined();
    stalled = true;
    const next = await Promise.race([resumed.promise, Bun.sleep(4000)]);
    expect(errors).toEqual([]);
    expect(next?.processRead).toBe("unknown");
    expect(next?.procs).toEqual([]);
    expect(next?.errors.map((e) => e.source)).toContain(f.config.procRoot);
  } finally {
    if (writer !== undefined) {
      writeSync(writer, "/fixture/claude\0");
      closeSync(writer);
    }
    session.stop();
  }
}, 10000);

/** A process source whose one read finishes only when the test says so. */
class Stalled implements ProcessSource {
  requests = 0;
  answer = Promise.withResolvers<ProcessReading>();
  collect(): Promise<ProcessReading> {
    this.requests++;
    return this.answer.promise;
  }
  close(): void {}
}

test("a late process read is left to finish, and no sample asks again until it has", async () => {
  const f = setup();
  f.proc(40, "agents.slice");
  const source = new Stalled();
  const collector = new Collector(
    f.config,
    100,
    4096,
    false,
    undefined,
    undefined,
    source,
  );
  try {
    const late = await collector.sample(1000);
    expect(late.processRead).toBe("unknown");
    expect(late.errors.map((e) => e.source)).toEqual([f.config.procRoot]);
    // The read is still running: the next sample neither sends another nor
    // waits the deadline out again.
    const waiting = await collector.sample(2000);
    expect(source.requests).toBe(1);
    expect(waiting.processRead).toBe("unknown");
    expect(waiting.durationMs).toBeLessThan(1000);
    expect(waiting.errors.map((e) => e.source)).toEqual([f.config.procRoot]);
    source.answer.resolve({ procs: [], errors: [], processRead: "complete" });
    await Bun.sleep(0);
    const again = await collector.sample(3000);
    expect(source.requests).toBe(2);
    expect(again.processRead).toBe("complete");
  } finally {
    collector.close();
  }
}, 10000);

/** Reads the fixture until the test stalls it, then answers only on release. */
class Stallable implements ProcessSource {
  private reader: ProcessCollector;
  stall?: PromiseWithResolvers<ProcessReading>;
  constructor(f: ReturnType<typeof fixture>) {
    this.reader = new ProcessCollector(f.config, 100, 4096);
  }
  collect(request: ProcessRequest, signal: AbortSignal) {
    return this.stall?.promise ?? this.reader.collect(request, signal);
  }
  close(): void {}
}

test("a process read that misses its deadline closes, clears and drops nothing", async () => {
  const f = setup();
  f.config.pressureHoldSeconds = 1;
  // An agent in the agent slice; one escaped to a watched slice, whose lane
  // stays; and one escaped to a slice nothing watches, whose lane only its
  // process names, which stalls, and whose directory is scratch.
  f.group("agents.slice/a.scope", [41]);
  f.proc(41, "agents.slice/a.scope");
  f.group("app.slice/run-a.scope", [42]);
  f.proc(42, "app.slice/run-a.scope");
  const tmp = join(f.root, "agent-tmp");
  f.write(join(tmp, "session/file"), "1234");
  f.group("background.slice/run-b.scope", [40]);
  f.proc(40, "background.slice/run-b.scope", { env: `TMPDIR=${tmp}\0` });
  f.write(
    join(f.config.cgroupRoot, "background.slice/run-b.scope/cpu.pressure"),
    "some avg10=50.00 avg60=50.00 avg300=50.00 total=100\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
  );
  const source = new Stallable(f);
  const collector = new Collector(
    f.config,
    100,
    4096,
    false,
    undefined,
    undefined,
    source,
  );
  const log = new EventLog();
  const run = async (time: number) => {
    const s = await collector.sample(time);
    return { s, events: log.advance(s, f.config) };
  };
  try {
    const first = await run(1000);
    expect(first.s.alerts.map((a) => a.rule)).toContain("unconfined");
    const opened = await run(3000);
    expect(
      opened.events
        .filter((e) => e.kind === "alert-open")
        .map((e) => `${e.cause} ${e.subjectId}`)
        .sort(),
    ).toEqual([
      "stalls background.slice/run-b.scope",
      "unconfined app.slice/run-a.scope",
      "unconfined background.slice/run-b.scope",
    ]);
    const lanes = opened.s.lanes.map((l) => l.id);
    source.stall = Promise.withResolvers<ProcessReading>();
    for (const time of [5000, 7000, 9000]) {
      const { s, events } = await run(time);
      expect(s.processRead).toBe("unknown");
      expect(events.map((e) => e.kind)).toEqual([]);
      expect(s.alerts).toEqual([]);
      // Only its process named the escaped agent's lane, so it is gone here.
      expect(s.lanes.map((l) => l.id).sort()).toEqual([
        "agents.slice/a.scope",
        "app.slice/run-a.scope",
      ]);
      const scope = s.lanes.find((l) => l.id === "agents.slice/a.scope");
      expect(scope?.state).toBe("unknown");
      expect(scope?.blocked).toBeNull();
      expect(s.storage.scratch.map((x) => x.path)).toEqual([tmp]);
    }
    source.stall.resolve({ procs: [], errors: [], processRead: "complete" });
    source.stall = undefined;
    await Bun.sleep(0);
    const back = await run(11000);
    expect(back.s.processRead).toBe("complete");
    expect(back.s.lanes.map((l) => l.id)).toEqual(lanes);
    expect(back.events.map((e) => e.kind)).toEqual([]);
    expect(back.s.alerts).toEqual([]);
  } finally {
    collector.close();
  }
}, 10000);
