import type { Config } from "../config/config";
import type { Snapshot } from "./types";
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
}
/** The most written first; an unknown total sorts last and keeps its name. */
function order(a: WriteTotal, b: WriteTotal): number {
  if (a.written === null || b.written === null)
    return a.written === b.written ? 0 : a.written === null ? 1 : -1;
  return b.written - a.written || a.name.localeCompare(b.name);
}
/** Bytes written since boot, by slice and by device, with SSD lifetime writes. */
export function writeTotals(s: Snapshot, c: Config): WriteTotals {
  const devices = s.storage.devices ?? [];
  const names = new Map(
    devices.flatMap((d) => (d.number ? [[d.number, d.name] as const] : [])),
  );
  const perDevice = s.storage.deviceWrites ?? null;
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
    // Every drive keeps its row, so a drive without a report is named as the
    // one missing its lifetime writes.
    lifetime: devices
      .map((d) => ({
        name: d.model ? `${d.name} (${d.model})` : d.name,
        written: d.lifetimeWritten,
      }))
      .sort(order),
    devicesAvailable: perDevice !== null,
  };
}
