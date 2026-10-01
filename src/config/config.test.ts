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
import { fixture } from "../test/fixture";
import { shippedAgentTools } from "./agent-tools";
import {
  defaults,
  loadConfig,
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

function scratchRoot(name: string) {
  const root = join(process.cwd(), "tmp", `${name}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
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
  scratchRoots.push(root);
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
  scratchRoots.push(root);
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
  scratchRoots.push(root);
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
  scratchRoots.push(root);
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
