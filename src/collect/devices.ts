import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Device } from "../model/types";
import { classify, type Outcome } from "./capabilities";
import type { Reader } from "./io";
import type { CollectionConfig } from "./settings";
import type { UdisksDrive } from "./udisks";

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
 * The smartctl reports in `smartDir`, by the device name each is for, and
 * whether the directory could be listed, as `classify` diagnoses it. A
 * directory that does not exist is no timer installed, which is a capability
 * and not a source error.
 */
export function smartReports(
  r: Reader,
  c: CollectionConfig,
): { reports: Map<string, string>; outcome: Outcome } {
  let names: string[];
  try {
    names = readdirSync(c.smartDir);
  } catch (error) {
    // Only a directory that is not there is no timer installed; anything
    // else that stopped the listing is an error in the sample, as it was
    // before udisks could stand in.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      r.error(c.smartDir, error);
    return { reports: new Map(), outcome: classify(error) };
  }
  return {
    reports: new Map(
      names.map((file) => [
        file.replace(/\.[^.]+$/, ""),
        join(c.smartDir, file),
      ]),
    ),
    outcome: null,
  };
}

/**
 * Block devices carry the names behind io.stat's device numbers. A report a
 * privileged timer left is read first, because a read-only monitor cannot run
 * smartctl itself; udisks answers only for a drive with no report, and the
 * caller asks it only where no report directory exists.
 */
export function collectDevices(
  r: Reader,
  c: CollectionConfig,
  reports: Map<string, string>,
  udisks: UdisksDrive[] | null = null,
): Device[] {
  const fromUdisks = new Map((udisks ?? []).map((d) => [d.name, d]));
  const devices: Device[] = [];
  for (const name of r.names(c.sysBlockRoot, true).sort()) {
    // Loop, memory and optical devices have no lifetime to report.
    if (
      /^(?:loop|ram|zram|sr|fd)\d+$/.test(name) &&
      !reports.has(name) &&
      !fromUdisks.has(name)
    )
      continue;
    const dev = r.text(join(c.sysBlockRoot, name, "dev"), true);
    const number = dev && /^\d+:\d+$/.test(dev) ? dev : null;
    const report = reports.get(name);
    const raw = report === undefined ? null : r.text(report);
    const drive = fromUdisks.get(name);
    if (raw !== null) {
      const read = smartWrites(raw);
      devices.push({
        name,
        number,
        ...read,
        source: read.lifetimeWritten === null ? null : "smartctl",
      });
    } else if (report === undefined && drive) {
      devices.push({
        name,
        number,
        model: drive.model,
        lifetimeWritten: drive.written,
        source: drive.written === null ? null : "udisks",
      });
    } else
      devices.push({
        name,
        number,
        model: null,
        lifetimeWritten: null,
        source: null,
      });
  }
  return devices;
}
