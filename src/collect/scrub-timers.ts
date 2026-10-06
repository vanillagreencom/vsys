/**
 * Whether the packaged scrub reporter has a scrub to report. The vsys
 * packages install the reporter's `btrfs-scrub@.service` drop-in, but a
 * package enables no timer, so a filesystem is checked only once the reader
 * enables `btrfs-scrub@<mount>.timer` for it. Reads only: `systemctl enable`
 * leaves a link in `timers.target.wants`, and that directory is listed here.
 */

import { readdir, stat } from "node:fs/promises";
import type { Reader } from "./io";

/** Where the packaged drop-in and the enabled system timers are found. */
export interface ScrubUnits {
  dropIn: string;
  wants: string;
}
export const packagedScrubUnits: ScrubUnits = {
  dropIn: "/usr/lib/systemd/system/btrfs-scrub@.service.d/vsys-report.conf",
  wants: "/etc/systemd/system/timers.target.wants",
};

/** A Btrfs mount, its filesystem where known, and whether vsys watches it. */
export interface ScrubMount {
  mount: string;
  fsid: string | null;
  watched: boolean;
}

/** A path as `systemd-escape --path` writes it into an instance name. */
export function escapePath(path: string): string {
  const trimmed = path.split("/").filter(Boolean).join("/");
  if (!trimmed) return "-";
  return [...Buffer.from(trimmed)]
    .map((byte, i) => {
      const char = String.fromCharCode(byte);
      if (char === "/") return "-";
      if (/[A-Za-z0-9:_]/.test(char) || (char === "." && i > 0)) return char;
      return `\\x${byte.toString(16).padStart(2, "0")}`;
    })
    .join("");
}
export const scrubTimer = (mount: string): string =>
  `btrfs-scrub@${escapePath(mount)}.timer`;

/**
 * One timer per watched filesystem with no enabled scrub timer on any of its
 * mounts, watched or not, named for its first watched mount: a scrub of one
 * mount checks the whole filesystem. Undefined where the packaged drop-in is
 * not installed, and null where the enabled timers could not be listed, which
 * is not a list of none.
 */
export async function missingScrubTimers(
  r: Reader,
  units: ScrubUnits,
  mounts: ScrubMount[],
): Promise<string[] | null | undefined> {
  try {
    await stat(units.dropIn);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      r.error(units.dropIn, e);
    return undefined;
  }
  let enabled: Set<string>;
  try {
    enabled = new Set(await readdir(units.wants));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      r.error(units.wants, e);
      return null;
    }
    enabled = new Set();
  }
  const filesystems = new Map<string, ScrubMount[]>();
  for (const mount of mounts) {
    const key = mount.fsid ?? mount.mount;
    filesystems.set(key, [...(filesystems.get(key) ?? []), mount]);
  }
  return [...filesystems.values()].flatMap((shared) =>
    shared.some((m) => enabled.has(scrubTimer(m.mount)))
      ? []
      : shared
          .filter((m) => m.watched)
          .slice(0, 1)
          .map((m) => scrubTimer(m.mount)),
  );
}
