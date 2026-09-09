import type { Config } from "../config/config";
import type { Snapshot } from "../model/types";
import { type WriteTotal, writeTotals } from "../model/writes";
import { amount, unavailable } from "./format";

/**
 * The write totals that open the Storage view. Filesystem state follows them,
 * because a drive is worn out by what was written to it, not by its free space.
 */
export function writeLines(s: Snapshot, c: Config): string[] {
  const t = writeTotals(s, c);
  const rows = (available: boolean, entries: WriteTotal[]) =>
    available && entries.length
      ? entries.map((e) => `  ${e.name} ${amount(e.written, c)}`)
      : [`  ${unavailable}`];
  // A device-mapper row and the disk under it both count the same bytes.
  const mapped = t.devices.some((d) => /^dm-/.test(d.name));
  return [
    "Written since boot, by slice",
    ...rows(true, t.slices),
    "Written since boot, by device",
    ...rows(t.devicesAvailable, t.devices),
    ...(mapped
      ? ["  A dm- row repeats the writes of the disk beneath it."]
      : []),
    "Lifetime writes reported by the drive",
    ...rows(t.smartAvailable, t.lifetime),
  ];
}
