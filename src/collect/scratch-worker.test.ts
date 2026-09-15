import { expect, test } from "bun:test";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "../config/config";
import { fixture } from "../test/fixture";
import { ScanCancelled, WorkerScan } from "./scratch";
import type { ScanReply, ScanRequest, ScratchScan } from "./scratch-scan";

const full = { sliceMs: 10, dutyPercent: 100 };
const c = { ...defaults(), scratchDirs: ["/scratch"] };
const loose = () => new AbortController().signal;
const empty = (time: number): ScratchScan => ({
  scratch: [],
  sessions: [],
  time,
  errors: [],
});

/** A scan thread the test drives, so no case depends on a real traversal. */
class Staged {
  sent: ScanRequest[] = [];
  stopped = 0;
  onmessage?: (event: MessageEvent<ScanReply>) => void;
  onerror?: (event: ErrorEvent) => void;
  private ended?: () => void;
  postMessage(request: ScanRequest): void {
    this.sent.push(request);
  }
  terminate(): void {
    this.stopped++;
  }
  addEventListener(_kind: string, handler: () => void): void {
    this.ended = handler;
  }
  /** Answer the scan at `index` of the ones this thread was sent. */
  answer(index: number, scan: ScratchScan): void {
    this.reply({ kind: "scan", id: this.sent[index].id, scan });
  }
  reply(reply: ScanReply): void {
    this.onmessage?.({ data: reply } as MessageEvent<ScanReply>);
  }
  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
  end(): void {
    this.ended?.();
  }
}

function staged() {
  const threads: Staged[] = [];
  const runner = new WorkerScan(() => {
    const thread = new Staged();
    threads.push(thread);
    return thread as unknown as Worker;
  });
  return { runner, threads };
}

test("the scan thread answers with a complete reading and closes", async () => {
  const f = fixture();
  const path = join(f.root, "scratch");
  try {
    f.write(join(path, "session/file"), "1234");
    const roots = { ...f.config, scratchDirs: [path] };
    const runner = new WorkerScan();
    try {
      const scan = await runner.run(roots, 5000, full, loose());
      expect(scan.time).toBe(5000);
      expect(scan.errors).toEqual([]);
      expect(scan.scratch[0].bytes).toBe(
        lstatSync(path).size + lstatSync(join(path, "session")).size + 4,
      );
      expect(scan.sessions.map((s) => s.path)).toEqual([join(path, "session")]);
    } finally {
      runner.close();
    }
    expect(() => runner.run(roots, 7000, full, loose())).toThrow(
      "Scratch scan thread has closed",
    );
  } finally {
    f.cleanup();
  }
});

test("one thread serves every scan until it fails", async () => {
  const { runner, threads } = staged();
  try {
    const first = runner.run(c, 1000, full, loose());
    threads[0].answer(0, empty(1000));
    expect((await first).time).toBe(1000);
    const second = runner.run(c, 2000, full, loose());
    // A thread started per scan pays its startup on every interval, which is
    // what a bounded traversal cannot afford.
    expect(threads.length).toBe(1);
    threads[0].answer(1, empty(2000));
    expect((await second).time).toBe(2000);
    // A thread that dies owes its caller an answer, and the next scan needs a
    // thread of its own rather than the dead one.
    const third = runner.run(c, 3000, full, loose());
    threads[0].crash("thread gone");
    await expect(third).rejects.toThrow(
      "Scratch scan thread failed: thread gone",
    );
    expect(threads[0].stopped).toBe(1);
    const fourth = runner.run(c, 4000, full, loose());
    expect(threads.length).toBe(2);
    threads[1].answer(0, empty(4000));
    expect((await fourth).time).toBe(4000);
  } finally {
    runner.close();
  }
});

test("a reply the host no longer waits for is never published", async () => {
  const { runner, threads } = staged();
  try {
    const controller = new AbortController();
    const abandoned = runner.run(c, 1000, full, controller.signal);
    controller.abort();
    await expect(abandoned).rejects.toBeInstanceOf(ScanCancelled);
    // The abandoned thread still answers for the first scan, and that reading
    // was taken before the caller gave up on it.
    const current = runner.run(c, 2000, full, loose());
    threads[0].answer(0, empty(1000));
    threads[0].answer(1, empty(2000));
    expect((await current).time).toBe(2000);
  } finally {
    runner.close();
  }
});

test("a late event from a replaced thread leaves the running scan alone", async () => {
  const { runner, threads } = staged();
  try {
    const dying = runner.run(c, 1000, full, loose());
    threads[0].crash("first thread gone");
    await expect(dying).rejects.toThrow("first thread gone");
    const running = runner.run(c, 2000, full, loose());
    expect(threads.length).toBe(2);
    threads[0].end();
    threads[0].crash("still gone");
    expect(threads[1].stopped).toBe(0);
    threads[1].answer(0, empty(2000));
    expect((await running).time).toBe(2000);
  } finally {
    runner.close();
  }
});

test("a second scan cannot start while one is running", async () => {
  const { runner, threads } = staged();
  try {
    const first = runner.run(c, 1000, full, loose());
    expect(() => runner.run(c, 1000, full, loose())).toThrow(
      "Scratch scan thread is already scanning",
    );
    threads[0].reply({
      kind: "failed",
      id: threads[0].sent[0].id,
      message: "read failed",
    });
    await expect(first).rejects.toThrow("read failed");
  } finally {
    runner.close();
  }
});
