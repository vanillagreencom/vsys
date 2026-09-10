import type { Config } from "../config/config";
import type { Capability, CapabilityId } from "../model/types";
import { age, bytes } from "./format";

/**
 * What one setting is called in the list, what it means in full, and the unit
 * its stored number is written in. The label fits its column beside its value;
 * the sentence goes under the row the reader selected, so no line has to hold
 * both.
 */
export interface SettingInfo {
  label: string;
  help: string;
  /** The unit a stored number is written in, so its value can carry it. */
  unit?: "bytes" | "ms" | "seconds" | "hours" | "percent";
}
export const settingInfo: Record<string, SettingInfo> = {
  refreshMs: {
    label: "Refresh interval",
    help: "How often vsys reads system state.",
    unit: "ms",
  },
  historyHours: {
    label: "History window",
    help: "How far back the Timeline and the charts can reach.",
    unit: "hours",
  },
  persistence: {
    label: "Save history",
    help: "Keep recorded samples across restarts in the history database.",
  },
  sqlitePath: {
    label: "History database",
    help: "Where saved history is written.",
  },
  cgroupRoot: {
    label: "Resource groups path",
    help: "The cgroup tree for this login session, which every lane sits under.",
  },
  cgroupTop: {
    label: "Machine group root",
    help: "The machine-wide cgroup mount, read for whole-machine disk totals.",
  },
  procRoot: {
    label: "Process information",
    help: "The kernel's process directory.",
  },
  btrfsRoot: {
    label: "Btrfs information",
    help: "The kernel's Btrfs directory, read for filesystem error counters.",
  },
  sysBlockRoot: {
    label: "Block devices",
    help: "The kernel's block device directory, read for drive names.",
  },
  watchedSlices: {
    label: "Watched slices",
    help: "The slices whose scopes appear under Agents.",
  },
  agentSlice: {
    label: "Agent slice",
    help: "The slice agents belong in. A tool running outside it has escaped.",
  },
  desktopSlice: {
    label: "Desktop slice",
    help: "The slice the desktop session runs in, watched for swapping.",
  },
  agentTools: {
    label: "Agent programs",
    help: "Program names vsys counts as an agent.",
  },
  excludeArgv: {
    label: "Not an agent",
    help: "Command patterns that rule a process out, such as browser helpers.",
  },
  capMarkers: {
    label: "Build cap variables",
    help: "Environment names whose presence proves a build concurrency cap.",
  },
  linkerNames: {
    label: "Linkers",
    help: "Program names counted as link work.",
  },
  compilerNames: {
    label: "Compilers",
    help: "Program names counted as compile work.",
  },
  jobserverEnv: {
    label: "Token pool variables",
    help: "Environment names carrying the make token pool.",
  },
  memoryFloor: {
    label: "Low memory limit",
    help: "A lane whose effective memory cap is under this is called dangerous.",
    unit: "bytes",
  },
  swapFloor: {
    label: "Desktop swap warning",
    help: "Desktop swap above this raises the swapped-out cause.",
    unit: "bytes",
  },
  freeFloor: {
    label: "Low free space",
    help: "A filesystem with less free space than this raises a danger.",
    unit: "bytes",
  },
  pressureAmber: {
    label: "Wait warning",
    help: "The stall share at which a meter turns amber.",
    unit: "percent",
  },
  pressureRed: {
    label: "Wait danger",
    help: "The stall share at which a meter turns red.",
    unit: "percent",
  },
  pressureHoldSeconds: {
    label: "Wait before alert",
    help: "How long a stall must hold before it becomes an alert.",
    unit: "seconds",
  },
  laneNaming: {
    label: "Lane name source",
    help: "Which fact names a lane's workspace: its worktree, its branch or a variable.",
  },
  laneEnv: {
    label: "Lane name variable",
    help: "The environment name read when the lane name source is a variable.",
  },
  laneNameParts: {
    label: "Lane name parts",
    help: "The parts that name a lane, in order. A listed pane composes nothing: a tmux pane address names no window a reader can place. Where two lanes still resolve to one name, vsys adds the working directory or the process id.",
  },
  accountEnv: {
    label: "Account variables",
    help: "Environment names carrying the agent configuration directory.",
  },
  paneEnv: {
    label: "Pane variables",
    help: "Environment names carrying the terminal pane address.",
  },
  titleEnv: {
    label: "Window title variables",
    help: "Environment names carrying the terminal window title.",
  },
  sccacheNames: {
    label: "Compiler cache",
    help: "Program names counted as compiler cache clients.",
  },
  scratchDirs: {
    label: "Scratch directories",
    help: "Directories measured against the scratch quota.",
  },
  scratchQuota: {
    label: "Scratch quota",
    help: "A scratch directory larger than this raises a housekeeping card.",
    unit: "bytes",
  },
  scratchRefreshMs: {
    label: "Scratch scan interval",
    help: "How often scratch directories are measured, separately from refresh.",
    unit: "ms",
  },
  btrfsMounts: {
    label: "Watched Btrfs mounts",
    help: "Mount points watched for error counters and free space. Empty watches every Btrfs mount.",
  },
  scrubDir: {
    label: "Scrub reports",
    help: "The directory a privileged timer leaves scrub reports in.",
  },
  smartDir: {
    label: "Drive reports",
    help: "The directory a privileged timer leaves smartctl reports in.",
  },
  columns: {
    label: "Table columns",
    help: "The columns of the Agents table, in display order.",
  },
  sort: { label: "Sort column", help: "The column the Agents list sorts on." },
  descending: {
    label: "Largest first",
    help: "Sort the Agents list from the largest value down.",
  },
  sparkline: {
    label: "Chart style",
    help: "The characters a one-row chart is drawn with.",
  },
  units: {
    label: "Storage units",
    help: "Binary units count 1024 to the step; decimal units count 1000.",
  },
  notifications: {
    label: "Desktop notifications",
    help: "The rules whose alerts also reach the desktop through notify-send.",
  },
  writeMode: {
    label: "Agent actions",
    help: "Allow the agent detail's Freeze, Thaw and Stop to run, each after a confirmation. Off, they are copy text.",
  },
};
/** Settings by what they change, so a reader finds one without a search. */
export const settingGroups: [string, string[]][] = [
  [
    "Display",
    ["units", "sparkline", "columns", "sort", "descending", "refreshMs"],
  ],
  ["History", ["historyHours", "persistence", "sqlitePath"]],
  [
    "Thresholds",
    [
      "pressureAmber",
      "pressureRed",
      "pressureHoldSeconds",
      "memoryFloor",
      "swapFloor",
      "freeFloor",
      "scratchQuota",
    ],
  ],
  [
    "Agents",
    [
      "agentTools",
      "excludeArgv",
      "watchedSlices",
      "agentSlice",
      "desktopSlice",
      "laneNaming",
      "laneEnv",
      "laneNameParts",
      "accountEnv",
      "paneEnv",
      "titleEnv",
    ],
  ],
  [
    "Builds",
    [
      "compilerNames",
      "linkerNames",
      "sccacheNames",
      "jobserverEnv",
      "capMarkers",
    ],
  ],
  [
    "Paths",
    [
      "cgroupRoot",
      "cgroupTop",
      "procRoot",
      "btrfsRoot",
      "sysBlockRoot",
      "btrfsMounts",
      "scrubDir",
      "smartDir",
      "scratchDirs",
      "scratchRefreshMs",
    ],
  ],
  ["Program", ["notifications", "writeMode"]],
];
/** Names and missing-interface wording for the capabilities probed at start. */
export const capabilityLabels: Record<CapabilityId, string> = {
  cgroup2: "Resource groups (cgroup v2)",
  delegation: "Resource control for this login session",
  psi: "Pressure stall information",
  "io-stat": "Per-group disk counters",
  scrub: "Disk scrub reports",
  smart: "Drive lifetime reports",
};
/** What the interface never existing means, per capability. */
const absentReasons: Record<CapabilityId, string> = {
  cgroup2: "no cgroup v2 at the configured path",
  delegation: "resource control is not delegated to this login session",
  psi: "no PSI on this kernel",
  "io-stat": "no io.stat for these resource groups",
  scrub: "no readable scrub report directory",
  smart: "no readable drive report directory",
};
/**
 * One cause per capability, derived from what the probe found rather than from
 * the identifier alone. A present file that cannot be read or does not parse
 * must not send the reader looking for a kernel that lacks the interface.
 */
export function capabilityReason(cap: Capability): string {
  switch (cap.failure) {
    case "absent":
      return absentReasons[cap.id];
    case "unreadable":
      return `${cap.source} exists but cannot be read`;
    case "malformed":
      return `${cap.source} is not in the expected format`;
    case "incomplete":
      return `this login session is not given ${cap.detail}`;
    default:
      return "";
  }
}
/** One Settings line per capability, naming the reason and the source that decided it. */
export function capabilityLine(cap: Capability): string {
  if (cap.available) return `${capabilityLabels[cap.id]}: available`;
  const reason = capabilityReason(cap);
  return `${capabilityLabels[cap.id]}: not available${reason ? `: ${reason}` : ""} (${cap.source}: ${cap.detail})`;
}

export function settingLabel(key: string): string {
  return (
    settingInfo[key]?.label ??
    (key.startsWith("keys.") ? `Key: ${key.slice(5)}` : key)
  );
}
/** The sentence under the selected row; a key binding needs none. */
export function settingHelp(key: string): string {
  return settingInfo[key]?.help ?? "";
}
/**
 * A stored millisecond count as the interval it sets. `age()` floors to whole
 * seconds, so a 500 ms refresh read `0s` and 1500 ms read `1s`, telling a
 * reader an interval they had set was zero. `validate()` accepts `refreshMs`
 * from 100, so sub-second and fractional-second intervals are ordinary values
 * and keep their own reading. A minute or more falls back to `age()`, which
 * every other span on screen is read in.
 */
function interval(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1).replace(/\.0$/, "")}s`
    : age(seconds);
}
/**
 * A stored value as the reader reads it: a byte count in its unit, an interval
 * as a duration, a boolean as a word, and a long list as what it starts with
 * and how much more it holds. The editor still opens the stored value, so
 * nothing here has to round-trip.
 */
export function settingDisplay(key: string, value: unknown, c: Config): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) {
    if (!value.length) return "none";
    const shown = value.slice(0, 3).join(", ");
    return value.length > 3 ? `${shown}, and ${value.length - 3} more` : shown;
  }
  if (typeof value === "number")
    switch (settingInfo[key]?.unit) {
      case "bytes":
        return bytes(value, c);
      case "ms":
        return interval(value);
      case "seconds":
        return `${value}s`;
      case "hours":
        return `${value}h`;
      case "percent":
        return `${value}%`;
    }
  return String(value);
}
