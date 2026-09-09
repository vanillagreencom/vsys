import { expect, test } from "bun:test";
import { linkSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "../config/config";
import { fixture } from "../test/fixture";
import { ScratchCollector, type ScratchScan, sizeDirectory } from "./scratch";

test("one traversal counts hard links once per root and once per session", async () => {
  const f = fixture();
  const path = join(f.root, "scratch");
  try {
    f.write(join(path, "a/file"), "1234");
    f.write(join(path, "b/empty"), "");
    linkSync(join(path, "a/file"), join(path, "b/shared"));
    symlinkSync(f.root, join(path, "loop"));
    const c = { ...f.config, scratchDirs: [path] };
    const collector = new ScratchCollector();
    try {
      const result = await collector.collect(c, Date.now(), true);
      expect(result.errors).toEqual([]);
      expect(result.scratch[0].bytes).toBe(
        lstatSync(path).size +
          lstatSync(join(path, "a")).size +
          lstatSync(join(path, "b")).size +
          4,
      );
      expect(
        result.sessions.find((s) => s.path === join(path, "a"))?.bytes,
      ).toBe(lstatSync(join(path, "a")).size + 4);
      expect(
        result.sessions.find((s) => s.path === join(path, "b"))?.bytes,
      ).toBe(lstatSync(join(path, "b")).size + 4);
      const absent = await sizeDirectory(join(f.root, "missing"), Date.now());
      expect(absent.bytes).toBeNull();
      expect(absent.error).not.toBeNull();
    } finally {
      collector.close();
    }
  } finally {
    f.cleanup();
  }
});
test("live reads reuse a single pending scan and keep its measurement time", async () => {
  const c = { ...defaults(), scratchDirs: ["/scratch"] };
  const ready = Promise.withResolvers<ScratchScan>();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const collector = new ScratchCollector(
    async (_config, _time, cancellation) => {
      calls++;
      signal = cancellation;
      return ready.promise;
    },
  );
  try {
    expect((await collector.collect(c, 1000, false)).time).toBeNull();
    expect((await collector.collect(c, 2000, false)).time).toBeNull();
    expect(calls).toBe(1);
    expect(collector.pending).toBe(true);
    ready.resolve({ scratch: [], sessions: [], time: 1000, errors: [] });
    expect((await collector.collect(c, 2000, true)).time).toBe(1000);
    expect(collector.pending).toBe(false);
    expect((await collector.collect(c, 2001, false)).time).toBe(1000);
    expect(calls).toBe(1);
    collector.close();
    expect(signal?.aborted).toBe(true);
    await expect(collector.collect(c, 3000, false)).rejects.toThrow();
  } finally {
    collector.close();
  }
});
test("empty scratch settings need no background work", async () => {
  let calls = 0;
  const collector = new ScratchCollector(async () => {
    calls++;
    throw new Error("Unexpected scan");
  });
  try {
    const value = await collector.collect(
      { ...defaults(), scratchDirs: [] },
      1000,
      false,
    );
    expect(value.errors).toEqual([]);
    expect(calls).toBe(0);
    expect(collector.pending).toBe(false);
  } finally {
    collector.close();
  }
});
