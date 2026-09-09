import type { Config } from "../config/config";
import type { Group, Snapshot } from "./types";
import { sliceSum } from "./verdict";

/** One row of written bytes. A null total is unknown, never a measured zero. */
export interface WriteTotal {
  name: string;
  written: number | null;
}
export interface WriteTotals {
  slices: WriteTotal[];
  devices: WriteTotal[];
  lifetime: WriteTotal[];
  /** False when the source could not be read, which is not an empty result. */
  devicesAvailable: boolean;
  smartAvailable: boolean;
}
/** The most written first; an unknown total sorts last and keeps its name. */
function order(a: WriteTotal, b: WriteTotal): number {
  if (a.written === null || b.written === null)
    return a.written === b.written ? 0 : a.written === null ? 1 : -1;
  return b.written - a.written || a.name.localeCompare(b.name);
}
/**
 * A cgroup's io.stat counts its whole subtree, so the top of the tree holds the
 * machine's device totals. Summing every group would count the same bytes twice.
 */
export function deviceWrites(groups: Group[]): Record<string, number> | null {
  const root = groups.find((g) => g.path === ".");
  const tops = root ? [root] : groups.filter((g) => g.parent === ".");
  if (!tops.length || tops.some((g) => g.ioWriteByDevice === null)) return null;
  const totals: Record<string, number> = {};
  for (const g of tops)
    for (const [device, written] of Object.entries(g.ioWriteByDevice ?? {}))
      totals[device] = (totals[device] ?? 0) + written;
  return totals;
}
/** Bytes written since boot, by slice and by device, with SSD lifetime writes. */
export function writeTotals(s: Snapshot, c: Config): WriteTotals {
  const devices = s.storage.devices ?? [];
  const names = new Map(
    devices.flatMap((d) => (d.number ? [[d.number, d.name] as const] : [])),
  );
  const perDevice = deviceWrites(s.groups);
  return {
    slices: [...new Set([...c.watchedSlices, c.agentSlice, c.desktopSlice])]
      .map((name) => ({
        name,
        written: sliceSum(s.groups, name, (g) => g.ioWrite),
      }))
      .sort(order),
    devices: Object.entries(perDevice ?? {})
      .map(([id, written]) => ({ name: names.get(id) ?? id, written }))
      .sort(order),
    lifetime: devices
      .filter((d) => d.lifetimeWritten !== null)
      .map((d) => ({
        name: d.model ? `${d.name} (${d.model})` : d.name,
        written: d.lifetimeWritten,
      }))
      .sort(order),
    devicesAvailable: perDevice !== null,
    smartAvailable: s.storage.smartAvailable !== false,
  };
}
