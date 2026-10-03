import { afterEach, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fixture, underHome } from "../test/fixture";
import { shippedAgentTools } from "./agent-tools";
import {
  defaults,
  loadConfig,
  patchConfigBody,
  saveConfig,
  serialize,
  validate,
} from "./config";

const fixtures: ReturnType<typeof fixture>[] = [];
const scratchRoots: string[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
  for (const root of scratchRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A directory under tmp/ that the next afterEach removes. */
function scratchRoot(name: string) {
  const root = join(process.cwd(), "tmp", `${name}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  scratchRoots.push(root);
  return root;
}
function agentToolsDocument(names: string[]) {
  return `${JSON.stringify(
    {
      version: 1,
      tools: names.map((name) => ({ name, mise: [] })),
      desktopExePrefixes: [],
      bundledCliSuffixes: [],
    },
    null,
    2,
  )}\n`;
}
function writeAgentTools(path: string, names: string[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, agentToolsDocument(names));
}
function tomlArray(values: string[]) {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}
test("TOML settings round-trip, including quotes and custom keys", async () => {
  const f = fixture();
  fixtures.push(f);
  const path = join(f.root, "settings/config.toml");
  const c = defaults();
  c.laneEnv = 'LANE_"NAME';
  c.keys.quit = "ctrl+q";
  await saveConfig(c, path, f.agentToolsPath);
  expect(await loadConfig(path, f.agentToolsPath)).toEqual(c);
});
test("invalid settings stop loading", () => {
  for (const value of [
    { refreshMs: 0 },
    { historyHours: -1 },
    { pressureAmber: 101 },
    { pressureHoldSeconds: Number.NaN },
    { persistence: "false" },
    { watchedSlices: ["../agents.slice"] },
    { columns: [] },
    { sort: "nope" },
    { notifications: ["unknown"] },
    { laneNameParts: ["hostname"] },
    { keys: { quit: "j" } },
    // At a scan share of zero the rest a slice earns is not a finite number,
    // and the traversal runs unbounded rather than slowly.
    { scratchDutyPercent: 0 },
    { scratchDutyPercent: 101 },
    { sqlitePath: "relative" },
    { unknown: 1 },
  ])
    expect(() => validate(value)).toThrow();
  // A saved binding on the key a new default takes names the key and both
  // actions, so the fix is one edit.
  expect(() => validate({ keys: { details: "o" } })).toThrow(
    "Keybindings must be unique: o is bound to details and hold",
  );
});
test("saving linked settings preserves the link and updates its target", async () => {
  const f = fixture();
  fixtures.push(f);
  const target = join(f.root, "target.toml");
  const link = join(f.root, "config.toml");
  await saveConfig(f.config, target, f.agentToolsPath);
  symlinkSync(target, link);
  const next = { ...f.config, refreshMs: 2000 };
  await saveConfig(next, link, f.agentToolsPath);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(await loadConfig(target, f.agentToolsPath)).toEqual(next);
});
test("missing config uses defaults but malformed TOML fails", async () => {
  const f = fixture();
  fixtures.push(f);
  const path = join(f.root, "config.toml");
  expect(await loadConfig(path, f.agentToolsPath)).toEqual(defaults());
  f.write(path, "refreshMs = [");
  expect(loadConfig(path, f.agentToolsPath)).rejects.toThrow();
});

test("every host-specific name ships a systemd user-session default", () => {
  const c = defaults();
  expect(c.agentSlice).toBe("agents.slice");
  expect(c.desktopSlice).toBe("app.slice");
  expect(c.watchedSlices).toEqual(["agents.slice", "app.slice"]);
  expect(c.cgroupRoot).toContain("/user.slice/user-");
  expect(c.cgroupRoot).toContain("/user@");
  expect(c.agentTools).toContain("claude");
  expect(c.excludeArgv).toContain("rust-analyzer");
  expect(c.capMarkers).toContain("CARGO_BUILD_JOBS");
  expect(c.linkerNames).toContain("mold");
  expect(c.compilerNames).toContain("rustc");
  expect(c.jobserverEnv).toEqual(["MAKEFLAGS"]);
  // No host-specific list ships empty, which would silently match nothing.
  for (const list of [
    c.agentTools,
    c.excludeArgv,
    c.capMarkers,
    c.linkerNames,
    c.compilerNames,
    c.jobserverEnv,
    c.watchedSlices,
    c.scratchDirs,
  ])
    expect(list.length).toBeGreaterThan(0);
});

/** Prints each row's settings file, loaded refresh and state paths. */
const resolvedPaths = `
const out = [];
for (const env of JSON.parse(process.env.VSYS_TEST_INPUT)) {
  const file = subject.configPath(env);
  const c = subject.defaults(undefined, env);
  out.push({
    file,
    refreshMs: (await subject.loadConfig(file)).refreshMs,
    sqlite: c.sqlitePath,
    memory: c.errorMemoryPath,
  });
}
console.log(JSON.stringify(out));
`;

test("the settings file follows XDG_CONFIG_HOME and history follows XDG_STATE_HOME", async () => {
  const home = join(scratchRoot("xdg-home"), "home");
  mkdirSync(home);
  // Today's paths. A machine with no config file and both variables set to
  // these, or neither set, must keep reading and writing exactly here.
  const config = join(home, ".config/vsys/config.toml");
  const history = join(home, ".local/state/vsys/history.db");
  const errors = join(home, ".local/state/vsys/filesystem-errors.json");
  const rows: [string, NodeJS.ProcessEnv, string, string, string][] = [
    ["both unset", {}, config, history, errors],
    [
      "both empty",
      { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" },
      config,
      history,
      errors,
    ],
    [
      "both relative",
      { XDG_CONFIG_HOME: "x/config", XDG_STATE_HOME: "x/state" },
      config,
      history,
      errors,
    ],
    [
      "both set to today's paths",
      {
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_STATE_HOME: join(home, ".local/state"),
      },
      config,
      history,
      errors,
    ],
    [
      "config set",
      { XDG_CONFIG_HOME: "/x/config" },
      "/x/config/vsys/config.toml",
      history,
      errors,
    ],
    [
      "state set",
      { XDG_STATE_HOME: "/x/state" },
      config,
      "/x/state/vsys/history.db",
      "/x/state/vsys/filesystem-errors.json",
    ],
  ];
  const resolved = await underHome(
    home,
    join(import.meta.dir, "config.ts"),
    resolvedPaths,
    rows.map(([, env]) => env),
  );
  expect(resolved).toEqual(
    rows.map(([, , file, sqlite, memory]) => ({
      file,
      refreshMs: 1000,
      sqlite,
      memory,
    })),
  );
});

test("an install under the home defaults keeps its settings and history when the variables move", async () => {
  const root = scratchRoot("xdg-legacy");
  const home = join(root, "home");
  const config = join(home, ".config/vsys/config.toml");
  const state = join(home, ".local/state/vsys");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, "refreshMs = 2500\n");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "filesystem-errors.json"), "{}\n");
  const moved = join(root, "xdg-config");
  mkdirSync(join(moved, "vsys"), { recursive: true });
  writeFileSync(join(moved, "vsys/config.toml"), "refreshMs = 4000\n");
  const env = (config: string) => ({
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: join(root, "xdg-state"),
  });
  const resolved = await underHome(
    home,
    join(import.meta.dir, "config.ts"),
    resolvedPaths,
    [env(join(root, "empty-config")), env(moved)],
  );
  expect(resolved).toEqual([
    {
      file: config,
      refreshMs: 2500,
      sqlite: join(state, "history.db"),
      memory: join(state, "filesystem-errors.json"),
    },
    {
      file: join(moved, "vsys/config.toml"),
      refreshMs: 4000,
      sqlite: join(state, "history.db"),
      memory: join(state, "filesystem-errors.json"),
    },
  ]);
});

test("a save after the reader moves the state directory pins no state path", async () => {
  const root = scratchRoot("xdg-moved-state");
  const home = join(root, "home");
  const legacy = join(home, ".local/state/vsys");
  const moved = join(root, "xdg-state");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(moved);
  const saved = await underHome(
    home,
    join(import.meta.dir, "config.ts"),
    `
const { renameSync } = await import("node:fs");
const { legacy, moved } = JSON.parse(process.env.VSYS_TEST_INPUT);
// A save resolves its defaults from the process environment.
process.env.XDG_STATE_HOME = moved;
const c = subject.defaults();
renameSync(legacy, moved + "/vsys");
console.log(JSON.stringify({
  sqlite: c.sqlitePath,
  body: subject.configBody({ ...c, refreshMs: 2000 }, c.agentTools),
}));
`,
    { legacy, moved },
  );
  expect(saved).toEqual({
    sqlite: join(legacy, "history.db"),
    body: "refreshMs = 2000\n",
  });
});

test("vsys observes only: the reserved write mode defaults off", async () => {
  expect(defaults().writeMode).toBe(false);
  expect(validate({}).writeMode).toBe(false);
  const f = fixture();
  fixtures.push(f);
  const path = join(f.root, "settings/write-mode.toml");
  await saveConfig(defaults(), path, f.agentToolsPath);
  expect((await loadConfig(path, f.agentToolsPath)).writeMode).toBe(false);
});

test("agent tool overlay reaches defaults and config overrides it", async () => {
  const root = scratchRoot("config-agent-tools");
  const configPath = join(root, "config.toml");
  const toolsPath = join(process.cwd(), "data/owner-agent-tools.json");
  expect((await loadConfig(configPath, toolsPath)).agentTools).toEqual([
    "claude",
    "codex",
    "gemini",
    "copilot",
    "opencode",
    "crush",
    "cursor-agent",
    "pi",
    "grok",
    "antigravity",
    "dsh",
    "agy",
    "omp",
    "ori",
    "fx",
    "muse",
  ]);
  writeFileSync(configPath, 'agentTools = ["local-agent"]\n');
  expect((await loadConfig(configPath, toolsPath)).agentTools).toEqual([
    "local-agent",
  ]);
});

test("saving defaults leaves agent tools unpinned and later overlay edits visible", async () => {
  const root = scratchRoot("config-agent-tools-unpinned");
  const configPath = join(root, "config.toml");
  const toolsPath = join(root, ".config/vsys/agent-tools.json");
  const config = defaults();
  await saveConfig(config, configPath, toolsPath);
  expect(readFileSync(configPath, "utf8")).not.toContain("agentTools");
  writeAgentTools(toolsPath, ["local-agent"]);
  expect((await loadConfig(configPath, toolsPath)).agentTools).toEqual([
    ...config.agentTools,
    "local-agent",
  ]);
});

test("a diverging agent tools pin hides later overlay edits", async () => {
  const root = scratchRoot("config-agent-tools-pinned");
  const configPath = join(root, "config.toml");
  const toolsPath = join(root, ".config/vsys/agent-tools.json");
  const pinned = [
    ...shippedAgentTools.tools.map((tool) => tool.name),
    "pinned-extra",
  ];
  writeFileSync(configPath, `agentTools = ${tomlArray(pinned)}\n`);
  writeAgentTools(toolsPath, ["overlay-extra"]);
  expect((await loadConfig(configPath, toolsPath)).agentTools).toEqual(pinned);
});

test("agent tools pins matching shipped or layered names migrate away", async () => {
  const root = scratchRoot("config-agent-tools-migrate");
  const toolsPath = join(root, ".config/vsys/agent-tools.json");
  writeAgentTools(toolsPath, ["overlay-extra"]);
  const shippedNames = shippedAgentTools.tools.map((tool) => tool.name);
  const layeredNames = [...shippedNames, "overlay-extra"];

  const shippedConfig = join(root, "shipped.toml");
  writeFileSync(shippedConfig, `agentTools = ${tomlArray(shippedNames)}\n`);
  const fromShipped = await loadConfig(shippedConfig, toolsPath);
  expect(fromShipped.agentTools).toEqual(layeredNames);
  await saveConfig(fromShipped, shippedConfig, toolsPath);
  expect(readFileSync(shippedConfig, "utf8")).not.toContain("agentTools");

  const layeredConfig = join(root, "layered.toml");
  writeFileSync(
    layeredConfig,
    `agentTools = ${tomlArray([...layeredNames].reverse())}\n`,
  );
  const fromLayered = await loadConfig(layeredConfig, toolsPath);
  expect(fromLayered.agentTools).toEqual(layeredNames);
  await saveConfig(fromLayered, layeredConfig, toolsPath);
  expect(readFileSync(layeredConfig, "utf8")).not.toContain("agentTools");
});

test("serialize writes only settings and keybindings changed from the base", () => {
  const base = defaults();
  expect(serialize(base)).toBe("");
  const config = {
    ...base,
    refreshMs: 2000,
    keys: { ...base.keys, quit: "ctrl+q" },
  };
  expect(serialize(config, base)).toBe(
    'refreshMs = 2000\n\n[keys]\nquit = "ctrl+q"\n',
  );
  expect(serialize({ ...base, refreshMs: 2000 }, base)).toBe(
    "refreshMs = 2000\n",
  );
  expect(
    serialize({ ...base, agentTools: [...base.agentTools].reverse() }),
  ).toBe("");
});

test("patchConfigBody reads an indented or commented [keys] header as the keys table", () => {
  const base = defaults();
  // A same-named top-level setting change must not land inside [keys], and
  // the keybinding sharing that name must survive untouched.
  const indented = patchConfigBody(
    '  [keys]\nsort = "ctrl+q"\n',
    { ...base, sort: "rss" },
    base,
    { changedKeys: ["sort"], changedKeyActions: [] },
  );
  expect(indented).toBe('sort = "rss"\n  [keys]\nsort = "ctrl+q"\n');
  expect(Bun.TOML.parse(indented)).toEqual({
    sort: "rss",
    keys: { sort: "ctrl+q" },
  });
  // A keybinding-only save must add its line to the existing table, never
  // open a second one.
  const commented = patchConfigBody(
    '  [keys] # my keys\nquit = "ctrl+q"\n',
    { ...base, keys: { ...base.keys, help: "shift+/" } },
    base,
    { changedKeys: [], changedKeyActions: ["help"] },
  );
  expect(commented).toBe(
    '  [keys] # my keys\nquit = "ctrl+q"\nhelp = "shift+/"\n',
  );
  expect((commented.match(/\[keys\]/g) ?? []).length).toBe(1);
  expect(Bun.TOML.parse(commented)).toEqual({
    keys: { quit: "ctrl+q", help: "shift+/" },
  });
});

test("patchConfigBody edits or removes a quoted key in place, never duplicating it", () => {
  const base = defaults();
  const reverted = patchConfigBody(
    '"historyHours" = 12\n',
    { ...base, historyHours: 24 },
    base,
    { changedKeys: ["historyHours"], changedKeyActions: [] },
  );
  expect(reverted).toBe("");
  const changed = patchConfigBody(
    '"historyHours" = 12\n',
    { ...base, historyHours: 6 },
    base,
    { changedKeys: ["historyHours"], changedKeyActions: [] },
  );
  expect(changed).toBe("historyHours = 6\n");
  expect(Bun.TOML.parse(changed)).toEqual({ historyHours: 6 });
});

test("reverting a quoted string key to default removes the line rather than keeping its old value", () => {
  const base = defaults();
  const reverted = patchConfigBody(
    '"sort" = "rss"\n',
    { ...base, sort: "cpu" },
    base,
    { changedKeys: ["sort"], changedKeyActions: [] },
  );
  expect(reverted).toBe("");
  expect(validate(Bun.TOML.parse(reverted), base).sort).toBe("cpu");
});

test("reverting a keybinding under [keys] to default removes the line rather than keeping its old value", () => {
  const base = defaults();
  const reverted = patchConfigBody(
    '[keys]\nquit = "ctrl+q"\n',
    { ...base, keys: { ...base.keys, quit: base.keys.quit } },
    base,
    { changedKeys: [], changedKeyActions: ["quit"] },
  );
  expect(reverted).not.toContain("ctrl+q");
  expect(validate(Bun.TOML.parse(reverted), base).keys.quit).toBe(
    base.keys.quit,
  );
});

test("patchConfigBody leaves a hand-written multi-line array alone and replaces it whole when it is the changed key", () => {
  const base = defaults();
  const body = 'columns = [\n  "name",\n  "cpu"\n]\n';
  const untouched = patchConfigBody(
    body,
    { ...base, columns: ["name", "cpu"], refreshMs: 2000 },
    base,
    { changedKeys: ["refreshMs"], changedKeyActions: [] },
  );
  expect(untouched).toBe(`${body}refreshMs = 2000\n`);
  const replaced = patchConfigBody(body, { ...base, columns: ["rss"] }, base, {
    changedKeys: ["columns"],
    changedKeyActions: [],
  });
  expect(replaced).toBe('columns = ["rss"]\n');
});

test("patchConfigBody opens a [keys] table when a keybinding change has none to join", () => {
  const base = defaults();
  const out = patchConfigBody(
    "refreshMs = 2000\n",
    { ...base, refreshMs: 2000, keys: { ...base.keys, help: "shift+/" } },
    base,
    { changedKeys: [], changedKeyActions: ["help"] },
  );
  expect(out).toBe('refreshMs = 2000\n\n[keys]\nhelp = "shift+/"\n');
});

test("patchConfigBody refuses a write that would combine into a config the loader rejects", () => {
  const base = defaults();
  // A hand-edited pressureRed, valid alone, combines with a Settings-raised
  // pressureAmber, also valid alone against the session's own stale
  // pressureRed, into a pair the loader refuses.
  expect(() =>
    patchConfigBody(
      "pressureRed = 15\n",
      { ...base, pressureAmber: 20 },
      base,
      {
        changedKeys: ["pressureAmber"],
        changedKeyActions: [],
      },
    ),
  ).toThrow("Pressure thresholds must increase");
  // A hand-edited keybinding, valid alone, collides with a different
  // keybinding the Settings screen is saving to the same key.
  expect(() =>
    patchConfigBody(
      '[keys]\nhelp = "ctrl+q"\n',
      { ...base, keys: { ...base.keys, quit: "ctrl+q" } },
      base,
      { changedKeys: [], changedKeyActions: ["quit"] },
    ),
  ).toThrow("Keybindings must be unique");
});

test("patchConfigBody refuses rather than silently drops an untouched line beside a triple-quoted string", () => {
  const base = defaults();
  // The scanner tracks quote state one character at a time, with no notion
  // of TOML's triple-quote delimiter: the embedded, unescaped quote inside
  // this valid triple-quoted string desyncs its idea of where the
  // excludeArgv assignment ends, so it would otherwise swallow the untouched
  // sort line below it. This never writes a shortened file; it refuses.
  const body = 'excludeArgv = [\n  """foo " bar""",\n]\nsort = "rss"\n';
  expect(Bun.TOML.parse(body)).toEqual({
    excludeArgv: ['foo " bar'],
    sort: "rss",
  });
  expect(() =>
    patchConfigBody(body, { ...base, excludeArgv: ['foo " bar'] }, base, {
      changedKeys: ["excludeArgv"],
      changedKeyActions: [],
    }),
  ).toThrow("sort, which this save never touched");
});
