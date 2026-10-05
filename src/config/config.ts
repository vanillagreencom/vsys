import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Rule } from "../model/types";
import {
  agentToolsPath,
  loadAgentToolNames,
  shippedAgentTools,
} from "./agent-tools";
import { writeFileAtomic } from "./atomic";
import { normalizeKey } from "./keys";
import { xdgHome, xdgPath } from "./xdg";

export const columns = [
  "name",
  "account",
  "cwd",
  "branch",
  "tool",
  "cpu",
  "pressure",
  "rss",
  "swap",
  "tasks",
  "rustc",
  "cargo",
  "tests",
  "age",
  "state",
  "cgroup",
  "cache",
  "readRate",
  "writeRate",
  "sccache",
  "blocked",
] as const;
/**
 * The parts a lane name can be built from, in the order config lists them.
 * `pane` is still accepted so a stored config file keeps loading, but it
 * composes nothing: a tmux pane address is a server handle, not a name.
 */
export const nameParts = [
  "account",
  "tool",
  "pane",
  "title",
  "workspace",
] as const;
/**
 * The values an enum setting may hold. The picker offers these and `validate`
 * accepts these, so a value a reader can choose is a value that saves, and a
 * new choice cannot reach the picker without also reaching the validator.
 */
export const choices: Record<string, readonly string[]> = {
  laneNaming: ["worktree", "branch", "env"],
  sparkline: ["braille", "block"],
  units: ["binary", "decimal"],
  sort: columns,
};
export const rules: Rule[] = [
  "unconfined",
  "memory-cap",
  "btrfs-ro",
  "btrfs-errors",
  "scrub",
  "memory-high",
  "pressure",
  "scratch",
];
/** Every action a key can be bound to; `defaults()` binds each one. */
export type KeyAction =
  | "home"
  | "agents"
  | "resources"
  | "builds"
  | "storage"
  | "timeline"
  | "settings"
  | "next"
  | "previous"
  | "tiles"
  | "attention"
  | "changes"
  | "busiest"
  | "filesystems"
  | "scrub"
  | "scratch"
  | "help"
  | "quit"
  | "down"
  | "up"
  | "left"
  | "right"
  | "open"
  | "back"
  | "search"
  | "details"
  | "columns"
  | "sort"
  | "reverse"
  | "pin"
  | "hold"
  | "window"
  | "copy"
  | "exportJson"
  | "exportMarkdown";

/** All host-specific paths and user preferences live in this contract. */
export interface Config {
  refreshMs: number;
  historyHours: number;
  persistence: boolean;
  sqlitePath: string;
  cgroupRoot: string;
  cgroupTop: string;
  procRoot: string;
  btrfsRoot: string;
  sysBlockRoot: string;
  watchedSlices: string[];
  agentSlice: string;
  desktopSlice: string;
  agentTools: string[];
  excludeArgv: string[];
  capMarkers: string[];
  linkerNames: string[];
  compilerNames: string[];
  jobserverEnv: string[];
  memoryFloor: number;
  swapFloor: number;
  freeFloor: number;
  pressureAmber: number;
  pressureRed: number;
  pressureHoldSeconds: number;
  laneNaming: "worktree" | "branch" | "env";
  laneEnv: string;
  laneNameParts: string[];
  accountEnv: string[];
  paneEnv: string[];
  titleEnv: string[];
  sccacheNames: string[];
  scratchDirs: string[];
  scratchQuota: number;
  scratchRefreshMs: number;
  /** The share of one core a background scratch scan may hold while it runs. */
  scratchDutyPercent: number;
  btrfsMounts: string[];
  scrubDir: string;
  smartDir: string;
  /** Where the last corruption growth per filesystem is remembered. */
  errorMemoryPath: string;
  /** A filesystem unchecked for longer than this stops reading as healthy. */
  scrubMaxAgeDays: number;
  columns: string[];
  sort: string;
  descending: boolean;
  sparkline: "braille" | "block";
  units: "binary" | "decimal";
  notifications: string[];
  /**
   * Off by default: vsys only reads system state. On, the agent detail's
   * Freeze, Thaw and Stop actions may run after a confirmation.
   */
  writeMode: boolean;
  keys: Record<KeyAction, string>;
}
/**
 * The settings file, under `$XDG_CONFIG_HOME` or else `~/.config`, as
 * `xdgPath()` resolves it. A save resolves it again, so it writes where the
 * next start will read even after the reader moves the file.
 */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return xdgPath("XDG_CONFIG_HOME", "vsys/config.toml", env);
}
/**
 * The shipped scratch roots. They are one workstation's layout. A list equal
 * to this one is the default, whether `config.toml` omits it or pins it
 * unchanged, and a root on it that does not exist is not configured at all.
 * Any other list is the reader's and reports its missing roots.
 */
export function defaultScratchDirs(): string[] {
  return [
    join(homedir(), "dev/.scratch/agents"),
    join(homedir(), "dev/.scratch/claude"),
    "/var/tmp/claude",
  ];
}
/**
 * The state directory each `XDG_STATE_HOME` base first resolved to in this
 * process. History holds its database open there for the life of the process,
 * so every later default names that same directory: re-resolved after the
 * reader moves it, the default would differ from the loaded path, and a save
 * would pin the old directory into `config.toml`.
 */
const stateDirs = new Map<string, string>();
function stateDir(env: NodeJS.ProcessEnv): string {
  const base = xdgHome("XDG_STATE_HOME", env);
  let dir = stateDirs.get(base);
  if (dir === undefined) {
    dir = xdgPath("XDG_STATE_HOME", "vsys", env);
    stateDirs.set(base, dir);
  }
  return dir;
}
/**
 * The shipped settings. History and error memory live under
 * `$XDG_STATE_HOME/vsys`, or else `~/.local/state/vsys`, as `xdgPath()`
 * resolves the directory, so the two never split across locations.
 */
export function defaults(
  agentTools = shippedAgentTools.tools.map((tool) => tool.name),
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const state = stateDir(env);
  return {
    refreshMs: 1000,
    historyHours: 24,
    persistence: false,
    sqlitePath: join(state, "history.db"),
    cgroupRoot: `/sys/fs/cgroup/user.slice/user-${process.getuid?.() ?? 1000}.slice/user@${process.getuid?.() ?? 1000}.service`,
    cgroupTop: "/sys/fs/cgroup",
    procRoot: "/proc",
    btrfsRoot: "/sys/fs/btrfs",
    sysBlockRoot: "/sys/block",
    watchedSlices: ["agents.slice", "app.slice"],
    agentSlice: "agents.slice",
    desktopSlice: "app.slice",
    agentTools: [...agentTools],
    excludeArgv: [
      "--chrome-native-host",
      "--type=",
      "rust-analyzer",
      "typescript-language-server",
    ],
    capMarkers: ["RUST_TEST_THREADS", "CARGO_BUILD_JOBS"],
    linkerNames: [
      "ld",
      "lld",
      "ld.lld",
      "mold",
      "ld.mold",
      "ld.gold",
      "ld.bfd",
    ],
    compilerNames: ["rustc", "cc", "gcc", "g++", "clang", "clang++", "tsc"],
    jobserverEnv: ["MAKEFLAGS"],
    memoryFloor: 1073741824,
    swapFloor: 536870912,
    freeFloor: 5368709120,
    pressureAmber: 10,
    pressureRed: 25,
    pressureHoldSeconds: 10,
    laneNaming: "worktree",
    laneEnv: "VSYS_LANE",
    laneNameParts: [...nameParts],
    accountEnv: ["CLAUDE_CONFIG_DIR", "CODEX_HOME"],
    paneEnv: ["VSYS_PANE", "TMUX_PANE"],
    titleEnv: ["VSYS_PANE_TITLE"],
    sccacheNames: ["sccache"],
    scratchDirs: defaultScratchDirs(),
    scratchQuota: 10737418240,
    scratchRefreshMs: 30000,
    scratchDutyPercent: 25,
    btrfsMounts: [],
    scrubDir: "/var/lib/btrfs-scrub",
    smartDir: "/run/smartctl",
    errorMemoryPath: join(state, "filesystem-errors.json"),
    // A weekly timer that misses one run is eight days late on the day after
    // the run it missed, so eight days is where a weekly schedule trips.
    scrubMaxAgeDays: 8,
    columns: [...columns],
    sort: "cpu",
    descending: true,
    sparkline: "block",
    units: "binary",
    notifications: [],
    writeMode: false,
    keys: {
      home: "1",
      agents: "2",
      resources: "3",
      builds: "4",
      storage: "5",
      timeline: "6",
      settings: "7",
      next: "tab",
      previous: "shift+tab",
      tiles: "t",
      attention: "a",
      changes: "g",
      busiest: "b",
      filesystems: "f",
      scrub: "u",
      scratch: "x",
      help: "?",
      quit: "q",
      down: "j",
      up: "k",
      left: "h",
      right: "l",
      open: "return",
      back: "escape",
      search: "/",
      details: "d",
      columns: "c",
      sort: "s",
      reverse: "r",
      pin: "p",
      hold: "o",
      window: "w",
      copy: "y",
      exportJson: "e",
      exportMarkdown: "m",
    },
  };
}

/** Whether `action` is one `base` binds, which `validate` requires of every key. */
export function isKeyAction(base: Config, action: string): action is KeyAction {
  return Object.hasOwn(base.keys, action);
}

export function sameStringSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size && [...leftSet].every((v) => rightSet.has(v))
  );
}

export interface LoadedConfig {
  config: Config;
  /** True when config.toml carries an agentTools list that migration keeps. */
  agentToolsPinned: boolean;
  /** The shipped list plus the machine overlay, before any config.toml pin. */
  layeredAgentTools: string[];
}

/**
 * The refusals a caller or a test tells apart. `errorText()` in
 * `src/ui/refusals.ts` writes what the reader sees.
 */
export type ConfigRefusal =
  | { kind: "keybinding-clash"; clashes: { key: string; actions: string[] }[] }
  | { kind: "pressure-order" }
  | { kind: "multi-line-value"; key: string }
  | { kind: "untouched-value-changed"; key: string }
  | { kind: "save-unloadable" };

export class ConfigError extends Error {
  constructor(
    readonly refusal: ConfigRefusal,
    options?: ErrorOptions,
  ) {
    super(refusal.kind, options);
  }
}

/**
 * Whether a setting holds its default. `serialize` writes only the settings
 * that differ.
 */
export function sameValue(key: string, left: unknown, right: unknown): boolean {
  if (key === "agentTools" && Array.isArray(left) && Array.isArray(right))
    return sameStringSet(left, right);
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Reject unknown settings and invalid values before changing a running collector. */
export function validate(value: unknown, base = defaults()): Config {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Config must be a TOML table");
  const input = value as Record<string, unknown>;
  for (const [key, v] of Object.entries(input)) {
    if (!(key in base)) throw new Error(`Unknown setting: ${key}`);
    const expected = base[key as keyof Config];
    if (Array.isArray(expected)) {
      if (
        !Array.isArray(v) ||
        v.some((x) => typeof x !== "string" || !x.trim())
      )
        throw new Error(`${key} must contain nonempty strings`);
      if (new Set(v).size !== v.length)
        throw new Error(`${key} contains duplicates`);
    } else if (typeof v !== typeof expected || v === null || Array.isArray(v))
      throw new Error(`Invalid type for ${key}`);
  }
  const c = {
    ...base,
    ...input,
    keys: { ...base.keys, ...(input.keys as object | undefined) },
  } as Config;
  for (const key of [
    "refreshMs",
    "historyHours",
    "memoryFloor",
    "swapFloor",
    "freeFloor",
    "pressureAmber",
    "pressureRed",
    "pressureHoldSeconds",
    "scratchQuota",
    "scratchRefreshMs",
    "scratchDutyPercent",
    "scrubMaxAgeDays",
  ] as const) {
    if (!Number.isFinite(c[key]) || c[key] < 0)
      throw new Error(`${key} must be finite and nonnegative`);
  }
  if (c.refreshMs < 100 || c.refreshMs > 86400000)
    throw new Error(
      "Refresh interval must be between 100 and 86400000 milliseconds",
    );
  if (c.scratchRefreshMs < 1000 || c.scratchRefreshMs > 86400000)
    throw new Error(
      "Scratch refresh must be between 1000 and 86400000 milliseconds",
    );
  // At zero the rest a slice earns is not a finite number, and a timer given
  // one waits its shortest interval instead. The traversal would then run at
  // close to full speed, which is the one thing this setting exists to stop.
  if (c.scratchDutyPercent < 1 || c.scratchDutyPercent > 100)
    throw new Error("Scratch scan share must be between 1 and 100 percent");
  if (c.historyHours <= 0 || c.historyHours > 24)
    throw new Error(
      "History window must be greater than zero and at most 24 hours",
    );
  if (c.pressureRed > 100 || c.pressureAmber > c.pressureRed)
    throw new ConfigError({ kind: "pressure-order" });
  for (const [key, allowed] of Object.entries(choices)) {
    if (!allowed.includes(String(c[key as keyof Config])))
      throw new Error(`Invalid ${key}`);
  }
  for (const key of [
    "sqlitePath",
    "cgroupRoot",
    "cgroupTop",
    "procRoot",
    "btrfsRoot",
    "sysBlockRoot",
    "scrubDir",
    "smartDir",
    "errorMemoryPath",
  ] as const)
    if (!isAbsolute(c[key])) throw new Error(`${key} must be absolute`);
  // Zero days would call every filesystem stale the moment its scrub ends.
  if (c.scrubMaxAgeDays <= 0)
    throw new Error("Scrub age limit must be greater than zero days");
  if (
    c.scratchDirs.some((p) => !isAbsolute(p)) ||
    c.btrfsMounts.some((p) => !isAbsolute(p))
  )
    throw new Error("Storage paths must be absolute");
  if (
    ![...c.watchedSlices, c.agentSlice, c.desktopSlice].every((p) =>
      /^[^/]+\.slice$/.test(p),
    )
  )
    throw new Error("Slice names must end in .slice and contain no slash");
  if (c.agentSlice === c.desktopSlice)
    throw new Error("Agent and desktop slices must be different");
  if (
    !c.laneEnv ||
    !c.columns.length ||
    c.columns.some((x) => !columns.includes(x as (typeof columns)[number]))
  )
    throw new Error("Invalid lane environment or columns");
  if (
    c.laneNameParts.some(
      (part) => !nameParts.includes(part as (typeof nameParts)[number]),
    )
  )
    throw new Error("Unknown lane name part");
  if (c.notifications.some((r) => !rules.includes(r as Rule)))
    throw new Error("Unknown notification rule");
  for (const [action, key] of Object.entries(c.keys)) {
    if (!isKeyAction(base, action) || typeof key !== "string" || !key.trim())
      throw new Error(`Invalid keybinding: ${action}`);
    c.keys[action] = normalizeKey(key);
    if (c.keys[action] === "ctrl+c" && action !== "quit")
      throw new Error("ctrl+c is reserved for quitting");
  }
  // A clash names the key and every action on it, so a saved binding that a
  // new default collides with is one edit to fix.
  const actions = new Map<string, string[]>();
  for (const [action, key] of Object.entries(c.keys))
    actions.set(key, [...(actions.get(key) ?? []), action]);
  const clashes = [...actions]
    .filter(([, on]) => on.length > 1)
    .map(([key, on]) => ({ key, actions: on }));
  if (clashes.length)
    throw new ConfigError({ kind: "keybinding-clash", clashes });
  return c;
}

function validAgentToolList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((name) => typeof name === "string") &&
    new Set(value).size === value.length
  );
}

function prepareConfigInput(
  input: Record<string, unknown>,
  base: Config,
): { input: Record<string, unknown>; agentToolsPinned: boolean } {
  if (
    validAgentToolList(input.agentTools) &&
    (sameStringSet(
      input.agentTools,
      shippedAgentTools.tools.map((tool) => tool.name),
    ) ||
      sameStringSet(input.agentTools, base.agentTools))
  ) {
    const rest = { ...input };
    delete rest.agentTools;
    return { input: rest, agentToolsPinned: false };
  }
  return {
    input,
    agentToolsPinned: Object.hasOwn(input, "agentTools"),
  };
}

/** Parse with Bun's TOML parser; a missing file uses defaults. */
export async function loadConfigState(
  path = configPath(),
  toolsPath = agentToolsPath,
): Promise<LoadedConfig> {
  const layeredAgentTools = await loadAgentToolNames(toolsPath);
  const base = defaults(layeredAgentTools);
  try {
    const input = Bun.TOML.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    const prepared = prepareConfigInput(input, base);
    return {
      config: validate(prepared.input, base),
      agentToolsPinned: prepared.agentToolsPinned,
      layeredAgentTools,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { config: base, agentToolsPinned: false, layeredAgentTools };
    throw error;
  }
}

export async function loadConfig(
  path = configPath(),
  toolsPath = agentToolsPath,
): Promise<Config> {
  return (await loadConfigState(path, toolsPath)).config;
}
/** TOML values here are strings, numbers, booleans and arrays of strings. */
export function serialize(c: Config, base = defaults()): string {
  const { keys, ...values } = validate(c, base);
  const valueLines = Object.entries(values)
    .filter(([key, value]) => !sameValue(key, value, base[key as keyof Config]))
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
  const keyLines = Object.entries(keys)
    .filter(
      ([key, value]) => !isKeyAction(base, key) || value !== base.keys[key],
    )
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
  if (!keyLines.length)
    return valueLines.length ? `${valueLines.join("\n")}\n` : "";
  const keysTable = `[keys]\n${keyLines.join("\n")}\n`;
  return valueLines.length
    ? `${valueLines.join("\n")}\n\n${keysTable}`
    : keysTable;
}
export async function saveConfig(
  c: Config,
  path = configPath(),
  toolsPath = agentToolsPath,
): Promise<void> {
  const body = configBody(c, await loadAgentToolNames(toolsPath));
  await writeFileAtomic(path, body);
}

/** Serialize against an explicit layered agent-tool list. */
export function configBody(c: Config, agentTools: string[]): string {
  return serialize(c, defaults(agentTools));
}

// Bun.TOML.parse accepts a table header indented and followed by a comment,
// and a key wrapped in matching quotes, the same as the bare forms; these
// patterns recognize what the loader already does, so a hand-written file in
// either style is read as the table or key it is, never mistaken for one.
const sectionPattern = /^\s*\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\](?:\s*#.*)?$/;
const assignmentPattern =
  /^\s*(?:"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)'|([A-Za-z_][A-Za-z0-9_]*))\s*=/;

/** The identifier `assignmentPattern` matched, bare or quoted alike. */
function assignmentKey(match: RegExpExecArray): string {
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/**
 * How many lines the assignment starting at `lines[start]` occupies, used
 * only to skip past a key `applyConfigLineEdits` is not editing: a wrong
 * count there just copies that many lines verbatim, changing nothing. More
 * than one only for a hand-written array split across lines: this project's
 * own writer always emits one line. This tracks only a single-character
 * quote toggle, which an embedded, unescaped quote inside a TOML
 * triple-quoted string desyncs from where the value actually ends; a key
 * `applyConfigLineEdits` does edit never trusts this count for that reason,
 * verifying with `isSingleLineValue` instead.
 */
function assignmentLineCount(lines: readonly string[], start: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let count = 0;
  for (let i = start; i < lines.length; i++) {
    count++;
    const text = lines[i] ?? "";
    for (let pos = 0; pos < text.length; pos++) {
      const ch = text[pos];
      if (quote) {
        if (quote === '"' && ch === "\\") pos++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "#") break;
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "[") depth++;
      else if (ch === "]") depth--;
    }
    if (depth <= 0 && !quote) break;
  }
  return count;
}

/**
 * Whether `line`, read alone as a standalone TOML document, already gives
 * `key` the exact value `currentValue` holds for it in the real file's own
 * full parse: proof this one line holds the key's whole value, with nothing
 * carried over from an earlier or later line. A value that takes more than
 * this line — a multi-line array, a string split across lines, a
 * triple-quoted string opened here — parses differently alone, or not at
 * all, and this reports false rather than guess from brackets or quotes.
 */
function isSingleLineValue(
  line: string,
  key: string,
  currentValue: unknown,
): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(line) as Record<string, unknown>;
  } catch {
    return false;
  }
  return Object.hasOwn(parsed, key) && sameTomlValue(parsed[key], currentValue);
}

/**
 * Rewrites only the lines `topEdits` and `keyEdits` name, leaving every
 * other line, comments and blank lines included, exactly as `currentBody`
 * has it. A `null` edit value removes that key's line; any other string
 * replaces it, or, for a key `currentBody` does not have, adds it. A new
 * top-level line lands at the end of the top-level block, before `[keys]`
 * when the file has one. A new `[keys]` line lands at the end of that table,
 * which this function creates, after a blank line, when `keyEdits` needs one
 * and `currentBody` has none. Refuses, throwing, a key or keybinding that
 * `topEdits`/`keyEdits` names whose current line is not `isSingleLineValue`
 * on its own: vsys's own writer always emits one line per setting, so only a
 * hand-formatted value reaches this refusal, and changing it by hand is
 * already how the reader put it there.
 */
function applyConfigLineEdits(
  currentBody: string,
  topEdits: ReadonlyMap<string, string | null>,
  keyEdits: ReadonlyMap<string, string | null>,
  currentTop: Readonly<Record<string, unknown>>,
  currentKeysTable: Readonly<Record<string, unknown>>,
): string {
  const lines = currentBody.length ? currentBody.split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const remainingTop = new Map(topEdits);
  const remainingKeys = new Map(keyEdits);
  const out: string[] = [];
  const flush = (pending: Map<string, string | null>) => {
    for (const line of pending.values()) if (line !== null) out.push(line);
    pending.clear();
  };
  let inKeys = false;
  let sawKeys = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const section = sectionPattern.exec(line);
    if (section) {
      flush(inKeys ? remainingKeys : remainingTop);
      inKeys = section[1] === "keys";
      if (inKeys) sawKeys = true;
      out.push(line);
      i++;
      continue;
    }
    const assignment = assignmentPattern.exec(line);
    if (assignment) {
      const pending = inKeys ? remainingKeys : remainingTop;
      const key = assignmentKey(assignment);
      if (pending.has(key)) {
        const currentValue = (inKeys ? currentKeysTable : currentTop)[key];
        if (!isSingleLineValue(line, key, currentValue))
          throw new ConfigError({ kind: "multi-line-value", key });
        const replacement = pending.get(key) ?? null;
        if (replacement !== null) out.push(replacement);
        pending.delete(key);
        i += 1;
        continue;
      }
      const count = assignmentLineCount(lines, i);
      for (let k = 0; k < count; k++) out.push(lines[i + k] ?? "");
      i += count;
      continue;
    }
    out.push(line);
    i++;
  }
  flush(inKeys ? remainingKeys : remainingTop);
  if (!sawKeys && remainingKeys.size) {
    const keyLines = [...remainingKeys.values()].filter(
      (line): line is string => line !== null,
    );
    if (keyLines.length) {
      if (out.length) out.push("");
      out.push("[keys]", ...keyLines);
    }
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

/** The settings and keybindings a Settings-screen save actually changed. */
export interface ConfigEdit {
  /** Every key but `keys`, which `changedKeyActions` carries instead. */
  changedKeys: readonly Exclude<keyof Config, "keys">[];
  changedKeyActions: readonly KeyAction[];
}

/** True for two values `Bun.TOML.parse` could produce that read the same. */
function sameTomlValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameTomlValue(v, b[i]))
    );
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => sameTomlValue(left[key], right[key]));
  }
  return false;
}

/**
 * Refuses a patch whose raw TOML, reparsed, differs anywhere from
 * `currentBody`'s own parse except at the keys and keybindings `edit`
 * names: the backstop proof, independent of which raw line carried it, that
 * a setting or keybinding `applyConfigLineEdits` never meant to touch keeps
 * its value. It compares values, never raw lines, so it never refuses a
 * comment or a blank line that happens to sit inside the old or new text of
 * a key this save does mean to change; `isSingleLineValue` is what keeps
 * `applyConfigLineEdits` from touching such a line in the first place.
 */
function verifyOnlyNamedKeysChanged(
  currentBody: string,
  configText: string,
  edit: ConfigEdit,
): void {
  let currentParsed: Record<string, unknown>;
  let newParsed: Record<string, unknown>;
  try {
    currentParsed = Bun.TOML.parse(currentBody) as Record<string, unknown>;
    newParsed = Bun.TOML.parse(configText) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError({ kind: "save-unloadable" }, { cause: error });
  }
  const changedTop = new Set<string>(edit.changedKeys);
  const topKeys = new Set([
    ...Object.keys(currentParsed),
    ...Object.keys(newParsed),
  ]);
  for (const key of topKeys) {
    if (key === "keys" || changedTop.has(key)) continue;
    if (!sameTomlValue(currentParsed[key], newParsed[key]))
      throw new ConfigError({ kind: "untouched-value-changed", key });
  }
  const changedActions = new Set<string>(edit.changedKeyActions);
  const currentKeysTable = (currentParsed.keys ?? {}) as Record<
    string,
    unknown
  >;
  const newKeysTable = (newParsed.keys ?? {}) as Record<string, unknown>;
  const actions = new Set([
    ...Object.keys(currentKeysTable),
    ...Object.keys(newKeysTable),
  ]);
  for (const action of actions) {
    if (changedActions.has(action)) continue;
    if (!sameTomlValue(currentKeysTable[action], newKeysTable[action]))
      throw new Error(
        `Settings save would change the ${action} keybinding, which this save never touched: refusing to write a config.toml that moved content it did not mean to change`,
      );
  }
}

/**
 * A patch this project's own loader cannot read back the way it was meant: a
 * hand edit left in an untouched line combined with a value this patch wrote
 * into a config `validate()` refuses whole, or a line `applyConfigLineEdits`
 * could not place the way `patchConfigBody` intended. Thrown instead of
 * writing the file, because a reader who then restarts vsys would meet a
 * config.toml it cannot load, with no save-time error to explain why.
 */
function verifyPatchedBody(
  configText: string,
  next: Config,
  base: Config,
  edit: ConfigEdit,
): void {
  let reloaded: Config;
  try {
    const parsed = Bun.TOML.parse(configText) as Record<string, unknown>;
    reloaded = validate(prepareConfigInput(parsed, base).input, base);
  } catch (error) {
    throw new ConfigError({ kind: "save-unloadable" }, { cause: error });
  }
  for (const key of edit.changedKeys) {
    if (!sameValue(key, reloaded[key], next[key]))
      throw new Error(
        `Settings save did not take effect for ${key}: the written config.toml would load it as ${JSON.stringify(reloaded[key])}, not ${JSON.stringify(next[key])}`,
      );
  }
  for (const action of edit.changedKeyActions) {
    if (reloaded.keys[action] !== next.keys[action])
      throw new Error(
        `Settings save did not take effect for the ${action} keybinding: the written config.toml would load it as ${JSON.stringify(reloaded.keys[action])}, not ${JSON.stringify(next.keys[action])}`,
      );
  }
}

/**
 * The body for a save made while vsys is running, which keeps every line a
 * hand edit added to `currentBody` since the session started: only the keys
 * `edit` names get a line changed, added or removed, so an untouched
 * setting keeps the file's current value, its line and any comment beside
 * it, whether or not that value matches `base`'s default. Refuses, throwing,
 * a changed key or keybinding whose line in `currentBody` is not
 * `isSingleLineValue`, rather than guess at a multi-line or triple-quoted
 * value's real span: vsys's own writer always emits one line, so this names
 * only a value the reader hand-formatted across more than one. Also refuses,
 * throwing, rather than returning a body that would not load back the way it
 * was meant to, when a hand edit this patch's own new value combines into an
 * invalid config.
 */
export function patchConfigBody(
  currentBody: string,
  next: Config,
  base: Config,
  edit: ConfigEdit,
): string {
  const topEdits = new Map<string, string | null>(
    edit.changedKeys.map((key) => [
      key,
      sameValue(key, next[key], base[key])
        ? null
        : `${key} = ${JSON.stringify(next[key])}`,
    ]),
  );
  const keyEdits = new Map<string, string | null>(
    edit.changedKeyActions.map((action) => [
      action,
      next.keys[action] === base.keys[action]
        ? null
        : `${action} = ${JSON.stringify(next.keys[action])}`,
    ]),
  );
  const currentParsed = Bun.TOML.parse(currentBody) as Record<string, unknown>;
  const currentKeysTable = (currentParsed.keys ?? {}) as Record<
    string,
    unknown
  >;
  const configText = applyConfigLineEdits(
    currentBody,
    topEdits,
    keyEdits,
    currentParsed,
    currentKeysTable,
  );
  verifyOnlyNamedKeysChanged(currentBody, configText, edit);
  verifyPatchedBody(configText, next, base, edit);
  return configText;
}
