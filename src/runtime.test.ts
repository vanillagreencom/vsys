import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "./config/config";
import { Session } from "./runtime";
import { History } from "./store/history";
import { emptySnapshot, fixture } from "./test/fixture";

test("refresh changes apply immediately and preserve collected history", async () => {
  const f = fixture();
  const h = new History(f.config);
  const initial = Promise.withResolvers<void>();
  const collectedAgain = Promise.withResolvers<void>();
  let calls = 0;
  let settingsFrames = 0;
  const session = new Session(
    f.config,
    join(f.root, "config.toml"),
    { sample: async () => emptySnapshot(++calls * 1000) },
    h,
    {
      frame: (s, history, c) => {
        if (s.time === 1000 && c.refreshMs === 1000) initial.resolve();
        if (c.refreshMs === 100) {
          settingsFrames++;
          expect(history.at(1000)?.time).toBe(1000);
        }
        if (s.time === 2000) collectedAgain.resolve();
      },
      error: (error) => {
        initial.reject(error);
        collectedAgain.reject(error);
      },
    },
  );
  try {
    session.start();
    await initial.promise;
    await session.configure({ ...f.config, refreshMs: 100 });
    expect(settingsFrames).toBe(1);
    await collectedAgain.promise;
    expect((await loadConfig(join(f.root, "config.toml"))).refreshMs).toBe(100);
  } finally {
    session.stop();
    f.cleanup();
  }
});
test("a config change waits for the in-flight source before sampling again", async () => {
  const f = fixture();
  const h = new History(f.config);
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<ReturnType<typeof emptySnapshot>>();
  const resumed = Promise.withResolvers<void>();
  let calls = 0;
  const session = new Session(
    f.config,
    join(f.root, "config.toml"),
    {
      sample: async () => {
        calls++;
        if (calls === 1) {
          started.resolve();
          return pending.promise;
        }
        return emptySnapshot(2000);
      },
    },
    h,
    { frame: () => resumed.resolve(), error: (error) => resumed.reject(error) },
  );
  try {
    session.start();
    await started.promise;
    await session.configure({ ...f.config, refreshMs: 100 });
    expect(calls).toBe(1);
    pending.resolve(emptySnapshot(1000));
    await resumed.promise;
    expect(calls).toBe(2);
  } finally {
    session.stop();
    f.cleanup();
  }
});
test("failed settings writes leave the active history and source usable", async () => {
  const f = fixture();
  const path = join(f.root, "file/config.toml");
  f.write(join(f.root, "file"), "not a directory");
  const h = new History(f.config);
  h.add(emptySnapshot(1000));
  const session = new Session(
    f.config,
    path,
    { sample: async () => emptySnapshot(2000) },
    h,
    { frame: () => {}, error: () => {} },
  );
  try {
    await expect(
      session.configure({ ...f.config, refreshMs: 100 }),
    ).rejects.toThrow();
    expect(h.at(1000)?.time).toBe(1000);
  } finally {
    session.stop();
    f.cleanup();
  }
});
test("source jobs close even when history shutdown fails", () => {
  const f = fixture();
  const h = new History(f.config);
  let closed = false;
  h.close = () => {
    throw new Error("close failure");
  };
  const session = new Session(
    f.config,
    join(f.root, "config.toml"),
    {
      sample: async () => emptySnapshot(),
      close: () => {
        closed = true;
      },
    },
    h,
    { frame: () => {}, error: () => {} },
  );
  try {
    expect(() => session.stop()).toThrow();
    expect(closed).toBe(true);
  } finally {
    f.cleanup();
  }
});
test("a source failure still reaches terminal cleanup when history close fails", async () => {
  const f = fixture();
  const h = new History(f.config);
  const reported = Promise.withResolvers<unknown>();
  const readError = new Error("read failure");
  const closeError = new Error("close failure");
  h.close = () => {
    throw closeError;
  };
  const session = new Session(
    f.config,
    join(f.root, "config.toml"),
    {
      sample: async () => {
        throw readError;
      },
    },
    h,
    { frame: () => {}, error: reported.resolve },
  );
  try {
    session.start();
    const error = await reported.promise;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([readError, closeError]);
  } finally {
    session.stop();
    f.cleanup();
  }
});
