/** Labels explain stored values without changing the configuration contract. */
export const settingLabels: Record<string, string> = {
  refreshMs: "Refresh interval (ms)",
  historyHours: "History window (hours)",
  persistence: "Save history across restarts",
  sqlitePath: "History database path",
  cgroupRoot: "Resource groups path",
  procRoot: "Process information path",
  btrfsRoot: "Btrfs information path",
  sysBlockRoot: "Block device information path",
  watchedSlices: "Slices shown in Fleet",
  agentSlice: "Agent resource slice",
  desktopSlice: "Desktop resource slice",
  agentTools: "Agent program names",
  memoryFloor: "Low memory limit warning (bytes)",
  pressureAmber: "Resource wait warning (%)",
  pressureRed: "Resource wait danger (%)",
  pressureHoldSeconds: "Wait before pressure alert (seconds)",
  laneNaming: "Lane name source",
  laneEnv: "Lane name environment variable",
  scratchDirs: "Scratch directories",
  scratchQuota: "Scratch quota per directory (bytes)",
  scratchRefreshMs: "Scratch scan interval (ms)",
  btrfsMounts: "Watched Btrfs mounts",
  scrubDir: "Scrub report directory",
  columns: "Table columns in display order",
  sort: "Fleet sort column",
  descending: "Sort largest first",
  theme: "Colour theme",
  sparkline: "Chart style",
  units: "Storage units",
  notifications: "Rules with desktop notifications",
};
export function settingLabel(key: string): string {
  return (
    settingLabels[key] ??
    (key.startsWith("keys.") ? `Key: ${key.slice(5)}` : key)
  );
}
