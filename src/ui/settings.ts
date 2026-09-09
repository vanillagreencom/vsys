import type { Capability, CapabilityId } from "../model/types";

/** Labels explain stored values without changing the configuration contract. */
export const settingLabels: Record<string, string> = {
  refreshMs: "Refresh interval (ms)",
  historyHours: "History window (hours)",
  persistence: "Save history across restarts",
  sqlitePath: "History database path",
  cgroupRoot: "Resource groups path",
  cgroupTop: "Machine-wide resource group root",
  procRoot: "Process information path",
  btrfsRoot: "Btrfs information path",
  sysBlockRoot: "Block device information path",
  watchedSlices: "Slices shown in Fleet",
  agentSlice: "Agent resource slice",
  desktopSlice: "Desktop resource slice",
  agentTools: "Agent program names",
  excludeArgv: "Command patterns that are not agents",
  capMarkers: "Environment names that prove a build cap",
  linkerNames: "Linker program names",
  compilerNames: "Compiler program names",
  jobserverEnv: "Environment names that carry the build token pool",
  memoryFloor: "Low memory limit warning (bytes)",
  swapFloor: "Desktop swap warning (bytes)",
  freeFloor: "Low free space warning (bytes)",
  pressureAmber: "Resource wait warning (%)",
  pressureRed: "Resource wait danger (%)",
  pressureHoldSeconds: "Wait before pressure alert (seconds)",
  laneNaming: "Lane name source",
  laneEnv: "Lane name environment variable",
  laneNameParts: "Parts that name a lane, in order",
  accountEnv: "Environment names that carry the account",
  paneEnv: "Environment names that carry the pane address",
  titleEnv: "Environment names that carry the window title",
  sccacheNames: "Compiler cache program names",
  scratchDirs: "Scratch directories",
  scratchQuota: "Scratch quota per directory (bytes)",
  scratchRefreshMs: "Scratch scan interval (ms)",
  btrfsMounts: "Watched Btrfs mounts",
  scrubDir: "Scrub report directory",
  smartDir: "SMART report directory",
  columns: "Table columns in display order",
  sort: "Fleet sort column",
  descending: "Sort largest first",
  theme: "Colour theme",
  sparkline: "Chart style",
  units: "Storage units",
  notifications: "Rules with desktop notifications",
  writeMode: "Allow vsys to change the system (reserved; vsys only reads)",
};
/** Names and missing-interface wording for the capabilities probed at start. */
export const capabilityLabels: Record<CapabilityId, string> = {
  cgroup2: "Resource groups (cgroup v2)",
  delegation: "Resource control for this login session",
  psi: "Pressure stall information",
  "io-stat": "Per-group disk counters",
  scrub: "Disk scrub reports",
};
/** What the interface never existing means, per capability. */
const absentReasons: Record<CapabilityId, string> = {
  cgroup2: "no cgroup v2 at the configured path",
  delegation: "resource control is not delegated to this login session",
  psi: "no PSI on this kernel",
  "io-stat": "no io.stat for these resource groups",
  scrub: "no readable scrub report directory",
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
    settingLabels[key] ??
    (key.startsWith("keys.") ? `Key: ${key.slice(5)}` : key)
  );
}
