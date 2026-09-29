import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SccacheCollector } from "./collect/sccache";
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
    path,
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
    join(f.root, "config.toml"),
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
    join(f.root, "config.toml"),
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
    join(f.root, "config.toml"),
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
    configPath,
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
    configPath,
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
    const configDir = join(f.root, "readonly");
    const configPath = join(configDir, "config.toml");
    f.write(configPath, "");
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
    const session = new Session(
      config,
      configPath,
      { sample: async () => emptySnapshot(1000) },
      h,
      { frame: () => {}, error: () => {} },
      {
        makeSource: async () => ({ sample: async () => emptySnapshot(2000) }),
        agentToolsPath: f.agentToolsPath,
      },
    );
    try {
      // Control: keeping the overlay write before a failed config write leaks this.
      chmodSync(configDir, 0o500);
      await expect(
        session.configure({
          ...config,
          agentTools: [...config.agentTools, "new-agent"],
        }),
      ).rejects.toThrow();
      if (existingOverlay)
        expect(readFileSync(f.agentToolsPath, "utf8")).toBe(overlayBody);
      else expect(existsSync(f.agentToolsPath)).toBe(false);
    } finally {
      chmodSync(configDir, 0o700);
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
    configPath,
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
    ).rejects.toThrow("Shipped names cannot be removed");
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
    configPath,
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
