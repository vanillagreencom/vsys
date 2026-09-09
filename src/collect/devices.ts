import { join } from "node:path";
import type { Device } from "../model/types";
import type { Reader } from "./io";
import type { CollectionConfig } from "./settings";

/** A logical block is 512 bytes and an NVMe data unit is a thousand of them. */
const BLOCK = 512;
const DATA_UNIT = BLOCK * 1000;
const number = (raw: string) => Number(raw.replace(/[,\s]/g, ""));

/**
 * Lifetime writes from `smartctl -A` output. NVMe reports data units, ATA
 * reports written logical blocks, and either may be absent on a given drive.
 */
export function smartWrites(
  text: string,
): Pick<Device, "model" | "lifetimeWritten"> {
  // Model Family names a range of drives and is printed above the drive's own
  // model, so it is only a fallback.
  const model =
    text.match(/^(?:Device Model|Model Number):\s*(.+?)\s*$/m)?.[1] ??
    text.match(/^Model Family:\s*(.+?)\s*$/m)?.[1] ??
    null;
  const units = text.match(/^Data Units Written:\s*([\d,\s]+?)(?:\s*\[.*)?$/m);
  if (units) return { model, lifetimeWritten: number(units[1]) * DATA_UNIT };
  const lbas = text.match(
    /^\s*\d+\s+(?:Total_LBAs_Written|Host_Writes_32MiB)\b.*?(\d+)\s*$/m,
  );
  if (lbas) {
    const scale = /Host_Writes_32MiB/.test(lbas[0]) ? 32 * 1024 * 1024 : BLOCK;
    return { model, lifetimeWritten: number(lbas[1]) * scale };
  }
  return { model, lifetimeWritten: null };
}

/**
 * Block devices carry the names behind io.stat's device numbers. SMART output
 * is written by a privileged timer, because a read-only monitor cannot run
 * smartctl itself.
 */
export function collectDevices(r: Reader, c: CollectionConfig): Device[] {
  const reports = new Map(
    r
      .names(c.smartDir, true)
      .map((file) => [file.replace(/\.[^.]+$/, ""), join(c.smartDir, file)]),
  );
  const devices: Device[] = [];
  for (const name of r.names(c.sysBlockRoot, true).sort()) {
    // Loop, memory and optical devices have no lifetime to report.
    if (/^(?:loop|ram|zram|sr|fd)\d+$/.test(name) && !reports.has(name))
      continue;
    const dev = r.text(join(c.sysBlockRoot, name, "dev"), true);
    const report = reports.get(name);
    const raw = report === undefined ? null : r.text(report);
    devices.push({
      name,
      number: dev && /^\d+:\d+$/.test(dev) ? dev : null,
      ...(raw === null
        ? { model: null, lifetimeWritten: null }
        : smartWrites(raw)),
    });
  }
  return devices;
}
