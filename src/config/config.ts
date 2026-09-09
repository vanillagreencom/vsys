import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Rule } from "../model/types";
import { normalizeKey } from "./keys";

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
/** The parts a lane name can be built from, in the order config lists them. */
export const nameParts = [
  "account",
  "tool",
  "pane",
  "title",
  "workspace",
] as const;
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
  btrfsMounts: string[];
  scrubDir: string;
  smartDir: string;
  columns: string[];
  sort: string;
  descending: boolean;
  sparkline: "braille" | "block";
  units: "binary" | "decimal";
  notifications: string[];
  /** Reserved for a future write mode. vsys only reads system state today. */
  writeMode: boolean;
  keys: Record<string, string>;
}
export const configPath = join(homedir(), ".config/vsys-view/config.toml");
export function defaults(): Config {
  return {
    refreshMs: 1000,
    historyHours: 24,
    persistence: false,
    sqlitePath: join(homedir(), ".local/state/vsys-view/history.db"),
    cgroupRoot: `/sys/fs/cgroup/user.slice/user-${process.getuid?.() ?? 1000}.slice/user@${process.getuid?.() ?? 1000}.service`,
    cgroupTop: "/sys/fs/cgroup",
    procRoot: "/proc",
    btrfsRoot: "/sys/fs/btrfs",
    sysBlockRoot: "/sys/block",
    watchedSlices: ["agents.slice", "app.slice"],
    agentSlice: "agents.slice",
    desktopSlice: "app.slice",
    agentTools: [
      "claude",
      "codex",
      "pi",
      "opencode",
      "gemini",
      "copilot",
      "grok",
      "agy",
      "crush",
      "dsh",
    ],
    excludeArgv: [
      "--chrome-native-host",
      "--type=renderer",
      "--type=gpu-process",
      "--type=utility",
      "--type=zygote",
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
    scratchDirs: [
      join(homedir(), "dev/.scratch/agents"),
      join(homedir(), "dev/.scratch/claude"),
      "/var/tmp/claude",
    ],
    scratchQuota: 10737418240,
    scratchRefreshMs: 30000,
    btrfsMounts: [],
    scrubDir: "/run/btrfs-scrub",
    smartDir: "/run/smartctl",
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
      window: "w",
      exportJson: "e",
      exportMarkdown: "m",
    },
  };
}

/** Reject unknown settings and invalid values before changing a running collector. */
export function validate(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Config must be a TOML table");
  const base = defaults();
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
  if (c.historyHours <= 0 || c.historyHours > 24)
    throw new Error(
      "History window must be greater than zero and at most 24 hours",
    );
  if (c.pressureRed > 100 || c.pressureAmber > c.pressureRed)
    throw new Error(
      "Pressure thresholds must increase from amber to red and cannot exceed 100 percent",
    );
  for (const [key, allowed] of Object.entries({
    laneNaming: ["worktree", "branch", "env"],
    sparkline: ["braille", "block"],
    units: ["binary", "decimal"],
  })) {
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
  ] as const)
    if (!isAbsolute(c[key])) throw new Error(`${key} must be absolute`);
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
    c.columns.some((x) => !columns.includes(x as (typeof columns)[number])) ||
    !columns.includes(c.sort as (typeof columns)[number])
  )
    throw new Error("Invalid lane environment, columns or sort");
  if (
    c.laneNameParts.some(
      (part) => !nameParts.includes(part as (typeof nameParts)[number]),
    )
  )
    throw new Error("Unknown lane name part");
  if (c.notifications.some((r) => !rules.includes(r as Rule)))
    throw new Error("Unknown notification rule");
  for (const [action, key] of Object.entries(c.keys)) {
    if (!(action in base.keys) || typeof key !== "string" || !key.trim())
      throw new Error(`Invalid keybinding: ${action}`);
    c.keys[action] = normalizeKey(key);
    if (c.keys[action] === "ctrl+c" && action !== "quit")
      throw new Error("ctrl+c is reserved for quitting");
  }
  if (new Set(Object.values(c.keys)).size !== Object.keys(c.keys).length)
    throw new Error("Keybindings must be unique");
  return c;
}

/** Parse with Bun's TOML parser; a missing file uses defaults. */
export async function loadConfig(path = configPath): Promise<Config> {
  try {
    return validate(Bun.TOML.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults();
    throw error;
  }
}
/** TOML values here are strings, numbers, booleans and arrays of strings. */
export function serialize(c: Config): string {
  const { keys, ...values } = validate(c);
  return `${Object.entries(values)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join("\n")}\n\n[keys]\n${Object.entries(keys)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join("\n")}\n`;
}
/** Atomic replacement prevents a partial config when a write is interrupted. */
export async function saveConfig(c: Config, path = configPath): Promise<void> {
  const body = serialize(c);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing?.isSymbolicLink()) path = await realpath(path);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, body, { mode: 0o600, flag: "wx" });
  try {
    await rename(temp, path);
  } catch (error) {
    try {
      await unlink(temp);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Config replacement and temporary file cleanup failed",
      );
    }
    throw error;
  }
}
