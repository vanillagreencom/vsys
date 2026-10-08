import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SccacheCollector } from "./collect/sccache";
import { writeFileAtomic } from "./config/atomic";
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
    () => join(f.root, "config.toml"),
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
    { agentToolsPath: f.agentToolsPath },
  );
  try {
    session.start();
    await initial.promise;
    await session.configure({ ...f.config, refreshMs: 100 });
    expect(settingsFrames).toBe(1);
    await collectedAgain.promise;
    expect(
      (await loadConfig(join(f.root, "config.toml"), f.agentToolsPath))
        .refreshMs,
    ).toBe(100);
  } finally {
    session.stop();
    f.cleanup();
  }
});
test("the frame's settings path follows the resolver on the next sample, before any save", async () => {
  const f = fixture();
  const h = new History(f.config);
  let resolved = join(f.root, "config.toml");
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<string>();
  let calls = 0;
  const session = new Session(
    f.config,
    () => resolved,
    { sample: async () => emptySnapshot(++calls * 1000) },
    h,
    {
      frame: (s, _history, _c, settingsPath) => {
        if (s.time === 1000) {
          expect(settingsPath).toBe(resolved);
          first.resolve();
        }
        if (s.time === 2000) second.resolve(settingsPath);
      },
      error: (error) => {
        first.reject(error);
        second.reject(error);
      },
    },
    { agentToolsPath: f.agentToolsPath },
  );
  try {
    session.start();
    await first.promise;
    // The reader moved XDG_CONFIG_HOME's target mid-session; no save ran, so
    // this is the resolver changing underneath the session, not a new value
    // it chose.
    resolved = join(f.root, "moved-config.toml");
    expect(await second.promise).toBe(resolved);
  } finally {
    session.stop();
    f.cleanup();
  }
});
test("a save publishes the moved file's path before it writes, with no sample in between", async () => {
  const f = fixture();
  const h = new History(f.config);
  let resolved = join(f.root, "config.toml");
  const first = Promise.withResolvers<void>();
  let calls = 0;
  const framePaths: string[] = [];
  let writeConfigCalls = 0;
  const session = new Session(
    f.config,
    () => resolved,
    { sample: async () => emptySnapshot(++calls * 1000) },
    h,
    {
      frame: (s, _history, _c, settingsPath) => {
        framePaths.push(settingsPath);
        if (s.time === 1000) first.resolve();
      },
      error: (error) => first.reject(error),
    },
    {
      agentToolsPath: f.agentToolsPath,
      writeConfig: async (path, body) => {
        writeConfigCalls++;
        // The write is about to use `path`; the fix publishes that same
        // value to the screen before this call, so the last frame already
        // names it. Without the fix, the last frame still names the file
        // from before the move, and this assertion catches that.
        expect(framePaths.at(-1)).toBe(path);
        await writeFileAtomic(path, body);
      },
    },
  );
  try {
    session.start();
    await first.promise;
    // The reader moved XDG_CONFIG_HOME's target and saves right away, before
    // the next sample tick would have re-resolved and republished the path.
    const moved = join(f.root, "moved-config.toml");
    resolved = moved;
    await session.configure({ ...f.config, refreshMs: 2000 });
    expect(writeConfigCalls).toBe(1);
    expect(framePaths.at(-1)).toBe(moved);
    expect(existsSync(moved)).toBe(true);
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
    () => join(f.root, "config.toml"),
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
    { agentToolsPath: f.agentToolsPath },
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
    () => path,
    { sample: async () => emptySnapshot(2000) },
    h,
    { frame: () => {}, error: () => {} },
    { agentToolsPath: f.agentToolsPath },
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
test("a settings save writes where the path resolves at save time", async () => {
  const f = fixture();
  let path = join(f.root, "home-config/config.toml");
  const h = new History(f.config);
  const session = new Session(
    f.config,
    () => path,
    { sample: async () => emptySnapshot(1000) },
    h,
    { frame: () => {}, error: () => {} },
    {
      makeSource: async () => ({ sample: async () => emptySnapshot(2000) }),
      agentToolsPath: f.agentToolsPath,
    },
  );
  try {
    await session.configure({ ...f.config, refreshMs: 2500 });
    const home = path;
    path = join(f.root, "moved-config/config.toml");
    mkdirSync(dirname(path));
    renameSync(home, path);
    await session.configure({ ...f.config, refreshMs: 3000 });
    expect(readFileSync(path, "utf8")).toContain("refreshMs = 3000\n");
    expect(existsSync(home)).toBe(false);
  } finally {
    session.stop();
    f.cleanup();
  }
});
test("a Settings save keeps a hand edit and a comment made while vsys runs", async () => {
  const f = fixture();
  const path = join(f.root, "config.toml");
  const h = new History(f.config);
  const session = new Session(
    f.config,
    () => path,
    { sample: async () => emptySnapshot(1000) },
    h,
    { frame: () => {}, error: () => {} },
    { agentToolsPath: f.agentToolsPath },
  );
  try {
    f.write(path, '# keep RSS first on this box\nsort = "rss"\n');
    // One unrelated toggle on the Settings screen.
    await session.configure({ ...f.config, descending: false });
    const body = readFileSync(path, "utf8");
    const after = await loadConfig(path, f.agentToolsPath);
    expect({
      comment: body.includes("# keep RSS"),
      sort: after.sort,
      descending: after.descending,
    }).toEqual({ comment: true, sort: "rss", descending: false });
  } finally {
    session.stop();
    f.cleanup();
  }
});
test("a Settings save that reverts a setting to default removes its line and keeps a comment beside it", async () => {
  const f = fixture();
  const path = join(f.root, "config.toml");
  f.write(path, "# a note about this file\nhistoryHours = 12\n");
  const config = { ...f.config, historyHours: 12 };
  const h = new History(config);
  const session = new Session(
    config,
    () => path,
    { sample: async () => emptySnapshot(1000) },
    h,
    { frame: () => {}, error: () => {} },
    { agentToolsPath: f.agentToolsPath },
  );
  try {
    await session.configure({ ...config, historyHours: 24 });
    const body = readFileSync(path, "utf8");
    expect(body).toContain("# a note about this file");
    expect(body).not.toContain("historyHours");
    expect((await loadConfig(path, f.agentToolsPath)).historyHours).toBe(24);
  } finally {
    session.stop();
    f.cleanup();
  }
});
test("a Settings save of a new keybinding preserves a hand-edited one in the keys table", async () => {
  const f = fixture();
  const path = join(f.root, "config.toml");
  const h = new History(f.config);
  const session = new Session(
    f.config,
    () => path,
    { sample: async () => emptySnapshot(1000) },
    h,
    { frame: () => {}, error: () => {} },
    { agentToolsPath: f.agentToolsPath },
  );
  try {
    f.write(path, '[keys]\nquit = "ctrl+q"\n');
    await session.configure({
      ...f.config,
      keys: { ...f.config.keys, help: "shift+/" },
    });
    const body = readFileSync(path, "utf8");
    const after = await loadConfig(path, f.agentToolsPath);
    expect(body).toContain('quit = "ctrl+q"');
    expect({ quit: after.keys.quit, help: after.keys.help }).toEqual({
      quit: "ctrl+q",
      help: "shift+/",
    });
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
    () => join(f.root, "config.toml"),
    {
      sample: async () => emptySnapshot(),
      close: () => {
        closed = true;
      },
    },
    h,
    { frame: () => {}, error: () => {} },
    { agentToolsPath: f.agentToolsPath },
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
    () => join(f.root, "config.toml"),
    {
      sample: async () => {
        throw readError;
      },
    },
    h,
    { frame: () => {}, error: reported.resolve },
    { agentToolsPath: f.agentToolsPath },
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
test("a settings change hands the running source to its replacement", async () => {
  const f = fixture();
  const h = new History(f.config);
  // A reader with an injected query, so nothing starts a build cache server.
  const carried = new SccacheCollector(async () => "", 0);
  const sample = async () => emptySnapshot(1000);
  const first = { sample, sccache: carried };
  let handed: unknown;
  const session = new Session(
    f.config,
    () => join(f.root, "config.toml"),
    first,
    h,
    { frame: () => {}, error: () => {} },
    {
      makeSource: async (_config, previous) => {
        handed = previous;
        return { sample, sccache: previous.sccache };
      },
      agentToolsPath: f.agentToolsPath,
    },
  );
  try {
    session.start();
    await session.configure({ ...f.config, procRoot: join(f.root, "proc2") });
    expect(handed).toBe(first);
  } finally {
    session.stop();
    f.cleanup();
  }
});

test("a saved collection setting rebuilds the source before the next sample", async () => {
  const f = fixture();
  const h = new History(f.config);
  const built: string[] = [];
  const collected = Promise.withResolvers<void>();
  const session = new Session(
    f.config,
    () => join(f.root, "config.toml"),
    { sample: async () => emptySnapshot(1000) },
    h,
    {
      frame: () => collected.resolve(),
      error: (error) => collected.reject(error),
    },
    {
      makeSource: async (c) => {
        built.push(c.smartDir);
        return { sample: async () => emptySnapshot(2000) };
      },
      agentToolsPath: f.agentToolsPath,
    },
  );
  try {
    session.start();
    await collected.promise;
    // A display setting keeps the running source.
    await session.configure({ ...f.config, units: "decimal" });
    expect(built).toEqual([]);
    // So does a notification rule: rebuilding would discard counters and the
    // alert state that decides which rule hits are new.
    await session.configure({ ...f.config, notifications: ["scrub"] });
    expect(built).toEqual([]);
    await session.configure({ ...f.config, smartDir: join(f.root, "smart2") });
    expect(built).toEqual([join(f.root, "smart2")]);
  } finally {
    session.stop();
    f.cleanup();
  }
});

test("editing agent tools saves the shared overlay and leaves config unpinned", async () => {
  const f = fixture();
  const configPath = join(f.root, "config.toml");
  f.write(
    f.agentToolsPath,
    `${JSON.stringify(
      {
        version: 1,
        tools: [{ name: "local-agent", mise: ["local-agent"] }],
        desktopExePrefixes: ["/apps/"],
        bundledCliSuffixes: ["/bin/agent"],
      },
      null,
      2,
    )}\n`,
  );
  const config = {
    ...f.config,
    agentTools: [...f.config.agentTools, "local-agent"],
  };
  const h = new History(config);
  const built: string[][] = [];
  const session = new Session(
    config,
    () => configPath,
    { sample: async () => emptySnapshot(1000) },
    h,
    { frame: () => {}, error: () => {} },
    {
      makeSource: async (next) => {
        built.push(next.agentTools);
        return { sample: async () => emptySnapshot(2000) };
      },
      agentToolsPath: f.agentToolsPath,
    },
  );
  try {
    // Control: replacing the overlay from the stale Settings list drops this.
    f.write(
      f.agentToolsPath,
      `${JSON.stringify(
        {
          version: 1,
          tools: [
            { name: "local-agent", mise: ["local-agent"] },
            { name: "external-agent", mise: ["external-agent"] },
          ],
          desktopExePrefixes: ["/apps/"],
          bundledCliSuffixes: ["/bin/agent"],
        },
        null,
        2,
      )}\n`,
    );
    await session.configure({
      ...config,
      agentTools: [...config.agentTools, "new-agent"],
    });
    const expected = [
      ...f.config.agentTools,
      "local-agent",
      "external-agent",
      "new-agent",
    ];
    expect(built).toEqual([expected]);
    expect(readFileSync(configPath, "utf8")).not.toContain("agentTools");
    expect(JSON.parse(readFileSync(f.agentToolsPath, "utf8"))).toEqual({
      version: 1,
      tools: [
        { name: "local-agent", mise: ["local-agent"] },
        { name: "external-agent", mise: ["external-agent"] },
        { name: "new-agent", mise: [] },
      ],
      desktopExePrefixes: ["/apps/"],
      bundledCliSuffixes: ["/bin/agent"],
    });
    expect((await loadConfig(configPath, f.agentToolsPath)).agentTools).toEqual(
      expected,
    );
  } finally {
    session.stop();
    f.cleanup();
  }
});

test("pinned agent tool edits that omit shipped tools are refused before writes", async () => {
  const f = fixture();
  const configPath = join(f.root, "config.toml");
  const missingShipped = f.config.agentTools[0];
  const pinned = f.config.agentTools.slice(1);
  const configBody = `agentTools = ${JSON.stringify(pinned)}\n`;
  const overlayBody = `${JSON.stringify(
    {
      version: 1,
      tools: [{ name: "local-agent", mise: ["local-agent"] }],
      desktopExePrefixes: ["/apps/"],
      bundledCliSuffixes: ["/bin/agent"],
    },
    null,
    2,
  )}\n`;
  f.write(configPath, configBody);
  f.write(f.agentToolsPath, overlayBody);
  const config = await loadConfig(configPath, f.agentToolsPath);
  const h = new History(config);
  const session = new Session(
    config,
    () => configPath,
    { sample: async () => emptySnapshot(1000) },
    h,
    { frame: () => {}, error: () => {} },
    {
      makeSource: async () => {
        throw new Error("source should not rebuild after refused agent tools");
      },
      agentToolsPath: f.agentToolsPath,
    },
  );
  try {
    // Control: the union rebase path puts the missing shipped name back.
    await expect(
      session.configure({
        ...config,
        agentTools: [...config.agentTools, "new-agent"],
      }),
    ).rejects.toMatchObject({
      refusal: { kind: "pinned-omits-shipped", missing: [missingShipped] },
    });
    expect(readFileSync(configPath, "utf8")).toBe(configBody);
    expect(readFileSync(f.agentToolsPath, "utf8")).toBe(overlayBody);
  } finally {
    session.stop();
    f.cleanup();
  }
});

test("pinned agent tool edits preserve current overlay-only tools", async () => {
  const f = fixture();
  const configPath = join(f.root, "config.toml");
  const pinned = [...f.config.agentTools, "pinned-agent"];
  f.write(configPath, `agentTools = ${JSON.stringify(pinned)}\n`);
  f.write(
    f.agentToolsPath,
    `${JSON.stringify(
      {
        version: 1,
        tools: [{ name: "local-agent", mise: ["local-agent"] }],
        desktopExePrefixes: ["/apps/"],
        bundledCliSuffixes: ["/bin/agent"],
      },
      null,
      2,
    )}\n`,
  );
  const config = await loadConfig(configPath, f.agentToolsPath);
  const h = new History(config);
  const built: string[][] = [];
  const session = new Session(
    config,
    () => configPath,
    { sample: async () => emptySnapshot(1000) },
    h,
    { frame: () => {}, error: () => {} },
    {
      makeSource: async (next) => {
        built.push(next.agentTools);
        return { sample: async () => emptySnapshot(2000) };
      },
      agentToolsPath: f.agentToolsPath,
    },
  );
  try {
    // Control: saving only the edited pinned list drops the unseen overlay tool.
    await session.configure({
      ...config,
      agentTools: [...config.agentTools, "new-agent"],
    });
    const expected = [...pinned, "local-agent", "new-agent"];
    expect(built).toEqual([expected]);
    expect(readFileSync(configPath, "utf8")).not.toContain("agentTools");
    expect(JSON.parse(readFileSync(f.agentToolsPath, "utf8"))).toEqual({
      version: 1,
      tools: [
        { name: "pinned-agent", mise: [] },
        { name: "local-agent", mise: ["local-agent"] },
        { name: "new-agent", mise: [] },
      ],
      desktopExePrefixes: ["/apps/"],
      bundledCliSuffixes: ["/bin/agent"],
    });
    expect((await loadConfig(configPath, f.agentToolsPath)).agentTools).toEqual(
      expected,
    );
  } finally {
    session.stop();
    f.cleanup();
  }
});

test("pinned unrelated settings saves keep diverging agent tools", async () => {
  const f = fixture();
  const configPath = join(f.root, "config.toml");
  const pinned = [...f.config.agentTools, "pinned-agent"];
  const configBody = `agentTools = ${JSON.stringify(pinned)}\n`;
  const overlayBody = `${JSON.stringify(
    {
      version: 1,
      tools: [{ name: "local-agent", mise: ["local-agent"] }],
      desktopExePrefixes: ["/apps/"],
      bundledCliSuffixes: ["/bin/agent"],
    },
    null,
    2,
  )}\n`;
  f.write(configPath, configBody);
  f.write(f.agentToolsPath, overlayBody);
  const config = await loadConfig(configPath, f.agentToolsPath);
  const h = new History(config);
  const initialFrame = Promise.withResolvers<void>();
  let calls = 0;
  const built: string[][] = [];
  const frames: string[][] = [];
  const session = new Session(
    config,
    () => configPath,
    { sample: async () => emptySnapshot(++calls * 1000) },
    h,
    {
      frame: (_sample, _history, current) => {
        frames.push(current.agentTools);
        initialFrame.resolve();
      },
      error: (error) => initialFrame.reject(error),
    },
    {
      makeSource: async (next) => {
        built.push(next.agentTools);
        return { sample: async () => emptySnapshot(++calls * 1000) };
      },
      agentToolsPath: f.agentToolsPath,
    },
  );
  try {
    session.start();
    await initialFrame.promise;
    // Control: replacing the pinned list with the layered list drops this pin.
    await session.configure({ ...config, refreshMs: 2000 });
    expect(built).toEqual([]);
    expect(frames.at(-1)).toEqual(pinned);
    const saved = readFileSync(configPath, "utf8");
    expect(saved).toContain("refreshMs = 2000");
    expect(saved).toContain(`agentTools = ${JSON.stringify(pinned)}`);
    expect(readFileSync(f.agentToolsPath, "utf8")).toBe(overlayBody);
    expect((await loadConfig(configPath, f.agentToolsPath)).agentTools).toEqual(
      pinned,
    );
  } finally {
    session.stop();
    f.cleanup();
  }
});

test("unpinned settings saves reload current agent tools before writing config", async () => {
  const f = fixture();
  const configPath = join(f.root, "config.toml");
  f.write(
    f.agentToolsPath,
    `${JSON.stringify(
      {
        version: 1,
        tools: [{ name: "local-agent", mise: ["local-agent"] }],
        desktopExePrefixes: [],
        bundledCliSuffixes: [],
      },
      null,
      2,
    )}\n`,
  );
  const config = {
    ...f.config,
    agentTools: [...f.config.agentTools, "local-agent"],
  };
  const h = new History(config);
  const built: string[][] = [];
  const session = new Session(
    config,
    () => configPath,
    { sample: async () => emptySnapshot(1000) },
    h,
    { frame: () => {}, error: () => {} },
    {
      makeSource: async (next) => {
        built.push(next.agentTools);
        return { sample: async () => emptySnapshot(2000) };
      },
      agentToolsPath: f.agentToolsPath,
    },
  );
  try {
    // Control: using the session's stale list pins config and hides this.
    f.write(
      f.agentToolsPath,
      `${JSON.stringify(
        {
          version: 1,
          tools: [
            { name: "local-agent", mise: ["local-agent"] },
            { name: "external-agent", mise: ["external-agent"] },
          ],
          desktopExePrefixes: [],
          bundledCliSuffixes: [],
        },
        null,
        2,
      )}\n`,
    );
    await session.configure({ ...config, refreshMs: 2000 });
    const expected = [...config.agentTools, "external-agent"];
    expect(built).toEqual([expected]);
    const saved = readFileSync(configPath, "utf8");
    expect(saved).toContain("refreshMs = 2000");
    expect(saved).not.toContain("agentTools");
    expect((await loadConfig(configPath, f.agentToolsPath)).agentTools).toEqual(
      expected,
    );
  } finally {
    session.stop();
    f.cleanup();
  }
});

test("agent tool overlay rolls back when config writing fails", async () => {
  for (const existingOverlay of [false, true]) {
    const f = fixture();
    const configPath = join(f.root, "config.toml");
    const overlayBody = `${JSON.stringify(
      {
        version: 1,
        tools: [{ name: "local-agent", mise: ["local-agent"] }],
        desktopExePrefixes: ["/apps/"],
        bundledCliSuffixes: ["/bin/agent"],
      },
      null,
      2,
    )}\n`;
    if (existingOverlay) f.write(f.agentToolsPath, overlayBody);
    const config = existingOverlay
      ? { ...f.config, agentTools: [...f.config.agentTools, "local-agent"] }
      : f.config;
    const h = new History(config);
    const configError = new Error("config write failed");
    const session = new Session(
      config,
      () => configPath,
      { sample: async () => emptySnapshot(1000) },
      h,
      { frame: () => {}, error: () => {} },
      {
        makeSource: async () => ({ sample: async () => emptySnapshot(2000) }),
        agentToolsPath: f.agentToolsPath,
        writeConfig: async () => {
          const editedOverlay = JSON.parse(
            readFileSync(f.agentToolsPath, "utf8"),
          ) as { tools: Array<{ name: string }> };
          expect(editedOverlay.tools.map((tool) => tool.name)).toContain(
            "new-agent",
          );
          throw configError;
        },
      },
    );
    try {
      // Control: keeping the overlay write before a failed config write leaks this.
      await expect(
        session.configure({
          ...config,
          agentTools: [...config.agentTools, "new-agent"],
        }),
      ).rejects.toBe(configError);
      if (existingOverlay)
        expect(readFileSync(f.agentToolsPath, "utf8")).toBe(overlayBody);
      else expect(existsSync(f.agentToolsPath)).toBe(false);
    } finally {
      session.stop();
      f.cleanup();
    }
  }
});

test("agent tool overlay rollback after config writing fails is skipped over a newer overlay and reported when it fails", async () => {
  const cases = [
    { overlay: "newer", kind: "rollback-skipped" },
    { overlay: "unreadable", kind: "rollback-failed" },
  ] as const;
  for (const [existingOverlay, { overlay, kind }] of [false, true].flatMap(
    (existing) => cases.map((c) => [existing, c] as const),
  )) {
    const f = fixture();
    const configPath = join(f.root, "config.toml");
    const overlayBody = `${JSON.stringify(
      {
        version: 1,
        tools: [{ name: "local-agent", mise: ["local-agent"] }],
        desktopExePrefixes: ["/apps/"],
        bundledCliSuffixes: ["/bin/agent"],
      },
      null,
      2,
    )}\n`;
    const newerOverlayBody = `${JSON.stringify(
      {
        version: 1,
        tools: [
          { name: "local-agent", mise: ["local-agent"] },
          { name: "external-agent", mise: ["external-agent"] },
        ],
        desktopExePrefixes: ["/apps/"],
        bundledCliSuffixes: ["/bin/agent"],
      },
      null,
      2,
    )}\n`;
    if (existingOverlay) f.write(f.agentToolsPath, overlayBody);
    const config = existingOverlay
      ? { ...f.config, agentTools: [...f.config.agentTools, "local-agent"] }
      : f.config;
    const h = new History(config);
    const configError = new Error("config write failed");
    const session = new Session(
      config,
      () => configPath,
      { sample: async () => emptySnapshot(1000) },
      h,
      { frame: () => {}, error: () => {} },
      {
        makeSource: async () => ({ sample: async () => emptySnapshot(2000) }),
        agentToolsPath: f.agentToolsPath,
        writeConfig: async () => {
          if (overlay === "newer") f.write(f.agentToolsPath, newerOverlayBody);
          else {
            rmSync(f.agentToolsPath);
            mkdirSync(f.agentToolsPath);
          }
          throw configError;
        },
      },
    );
    try {
      // Control: unconditional rollback restores or removes the overlay here.
      let thrown: unknown;
      try {
        await session.configure({
          ...config,
          agentTools: [...config.agentTools, "new-agent"],
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ refusal: { kind } });
      expect(thrown).toHaveProperty("refusal.saveError", configError);
      if (overlay === "newer")
        expect(readFileSync(f.agentToolsPath, "utf8")).toBe(newerOverlayBody);
    } finally {
      session.stop();
      f.cleanup();
    }
  }
});

test("removing a shipped agent tool is refused before settings writes", async () => {
  const f = fixture();
  const configPath = join(f.root, "config.toml");
  const h = new History(f.config);
  const session = new Session(
    f.config,
    () => configPath,
    { sample: async () => emptySnapshot(1000) },
    h,
    { frame: () => {}, error: () => {} },
    {
      makeSource: async () => {
        throw new Error("source should not rebuild after refused agent tools");
      },
      agentToolsPath: f.agentToolsPath,
    },
  );
  try {
    await expect(
      session.configure({
        ...f.config,
        agentTools: f.config.agentTools.slice(1),
      }),
    ).rejects.toThrow();
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(f.agentToolsPath)).toBe(false);
  } finally {
    session.stop();
    f.cleanup();
  }
});

test("settings agent tools edits match the warden overlay loader", async () => {
  const f = fixture();
  const configPath = join(f.root, ".config/vsys/config.toml");
  const h = new History(f.config);
  const session = new Session(
    f.config,
    () => configPath,
    { sample: async () => emptySnapshot(1000) },
    h,
    { frame: () => {}, error: () => {} },
    {
      makeSource: async () => ({ sample: async () => emptySnapshot(2000) }),
      agentToolsPath: f.agentToolsPath,
    },
  );
  try {
    await session.configure({
      ...f.config,
      agentTools: [...f.config.agentTools, "parity-agent"],
    });
    const vsysNames = (await loadConfig(configPath, f.agentToolsPath))
      .agentTools;
    const child = Bun.spawn(
      [
        "python3",
        "-c",
        'import importlib.machinery, json; module = importlib.machinery.SourceFileLoader("agent_warden_vsys_test", "warden/agent-warden").load_module(); print(json.dumps([tool["name"] for tool in module.AGENT_TOOLS["tools"]]))',
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: f.root,
          XDG_DATA_HOME: join(f.root, ".local/share"),
          XDG_RUNTIME_DIR: join(f.root, "run"),
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual(vsysNames);
  } finally {
    session.stop();
    f.cleanup();
  }
});

test("an unrelated save removes a dormant agentTools list that matches the shipped defaults", async () => {
  // D006: a hand-written list equal to the shipped and layered lists is not a
  // pin. An unrelated Settings save must remove it, so a later overlay tool is
  // not hidden by a stale pin on restart.
  const f = fixture();
  const configPath = join(f.root, "config.toml");
  f.write(configPath, `agentTools = ${JSON.stringify(f.config.agentTools)}\n`);
  const config = await loadConfig(configPath, f.agentToolsPath);
  const h = new History(config);
  const session = new Session(
    config,
    () => configPath,
    { sample: async () => emptySnapshot(1000) },
    h,
    { frame: () => {}, error: () => {} },
    {
      makeSource: async () => ({
        sample: async () => emptySnapshot(2000),
      }),
      agentToolsPath: f.agentToolsPath,
    },
  );
  try {
    await session.configure({ ...config, refreshMs: 2000 });
    const body = readFileSync(configPath, "utf8");
    expect(body).not.toContain("agentTools");
    expect(body).toContain("refreshMs = 2000");
    expect((await loadConfig(configPath, f.agentToolsPath)).agentTools).toEqual(
      f.config.agentTools,
    );
  } finally {
    session.stop();
    f.cleanup();
  }
});
test("a notifier that does not exit leaves sample publication running, and its failures reach later frames", async () => {
  const f = fixture();
  const notifier = join(f.root, "bin/notify-send");
  const driver = join(f.root, "driver.ts");
  f.write(
    driver,
    `import { Session } from ${JSON.stringify(resolve("src/runtime.ts"))};
    import { defaults } from ${JSON.stringify(resolve("src/config/config.ts"))};
    import { History } from ${JSON.stringify(resolve("src/store/history.ts"))};
    import { emptySnapshot } from ${JSON.stringify(resolve("src/test/fixture.ts"))};
    const c = { ...defaults(), refreshMs: 100, notifications: ["unconfined"] };
    let frames = 0, samples = 0, notifyErrors = 0;
    const errors = [];
    const session = new Session(c, () => "unused", {
      sample: async () => {
        const s = emptySnapshot(++samples * 100);
        s.alerts = [{ time: s.time, rule: "unconfined", subject: String(samples), message: "fixture" }];
        return s;
      },
    }, new History(c), {
      frame: (s) => {
        frames++;
        notifyErrors += s.errors.filter((e) => e.source === "notify-send").length;
      },
      error: (e) => errors.push(String(e)),
    });
    session.start();
    await Bun.sleep(350);
    session.stop();
    console.log(JSON.stringify({ frames, samples, notifyErrors, errors }));`,
  );
  const run = async (script: string) => {
    f.write(notifier, script);
    chmodSync(notifier, 0o755);
    const child = Bun.spawn([process.execPath, driver], {
      env: { PATH: join(f.root, "bin"), HOME: f.root, TMPDIR: f.root },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [out, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      return JSON.parse(out) as {
        frames: number;
        samples: number;
        notifyErrors: number;
        errors: string[];
      };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const control = await run("#!/bin/sh\nexit 0\n");
    expect(control.errors).toEqual([]);
    expect(control.frames).toBeGreaterThanOrEqual(2);
    expect(control.notifyErrors).toBe(0);
    const failing = await run("#!/bin/sh\nexit 3\n");
    expect(failing.errors).toEqual([]);
    expect(failing.frames).toBeGreaterThanOrEqual(2);
    expect(failing.notifyErrors).toBeGreaterThan(0);
    const slow = await run("#!/bin/sh\nexec /bin/sleep 1\n");
    expect(slow.errors).toEqual([]);
    expect(slow.frames).toBeGreaterThanOrEqual(2);
    // Alerts raised while the first call still runs are reported unsent.
    expect(slow.notifyErrors).toBeGreaterThan(0);
  } finally {
    f.cleanup();
  }
}, 20000);
