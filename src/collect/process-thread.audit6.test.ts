import { afterEach, expect, test } from "bun:test";
import { closeSync, constants, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { shippedAgentTools } from "../config/agent-tools";
import type { Snapshot } from "../model/types";
import { Session } from "../runtime";
import { History } from "../store/history";
import { fixture } from "../test/fixture";
import { Collector } from "./collector";
import { ProcessThread } from "./process-thread";
import type { ProcessReading, ProcessSource } from "./procs";

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
        else resumed.resolve(snapshot);
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
