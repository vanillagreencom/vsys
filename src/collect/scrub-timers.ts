/**
 * Whether the packaged scrub reporter has a scrub to report. The vsys
 * packages install the reporter's `btrfs-scrub@.service` drop-in, but a
 * package enables no timer, so a filesystem is checked only once the reader
 * enables `btrfs-scrub@<mount>.timer` for it. Reads only: systemd itself says
 * each timer's state, through `systemctl is-enabled`, so a runtime enable, a
 * masked template and a missing one read as systemd reads them.
 */

import { stat } from "node:fs/promises";
import { filesystemKey } from "../model/integrity";
import { type Reader, spawnText } from "./io";

/**
 * Where the packaged drop-in is found, and how systemd is asked for each
 * unit's `systemctl is-enabled` word: one per unit in order, or null where it
 * did not answer for every one.
 */
export interface ScrubUnits {
  dropIn: string;
  states: (units: string[]) => Promise<string[] | null>;
}
export const packagedScrubUnits: ScrubUnits = {
  dropIn: "/usr/lib/systemd/system/btrfs-scrub@.service.d/vsys-report.conf",
  // is-enabled exits nonzero for any unit that is not enabled, and still
  // prints a word for each, so the words are the answer, not the status.
  states: async (units) => {
    const answer = await spawnText(
      ["systemctl", "is-enabled", "--", ...units],
      2000,
    );
    const words = answer.out.split("\n").filter(Boolean);
    return !answer.timedOut && words.length === units.length ? words : null;
  },
};

/** A Btrfs mount, its filesystem where known, and whether vsys watches it. */
export interface ScrubMount {
  mount: string;
  device: string;
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
 * mount checks the whole filesystem, which `filesystemKey` identifies as
 * Storage does. A filesystem is covered where systemd calls any of its
 * timers enabled, for good or for this boot, and offered one only where it
 * calls every one disabled: a masked or missing template, or a word vsys
 * does not know, offers nothing. Undefined where the packaged drop-in is not
 * installed. Null where the drop-in, the mounts or systemd could not be read,
 * which is not a list of none.
 */
export async function missingScrubTimers(
  r: Reader,
  systemd: ScrubUnits,
  mounts: ScrubMount[] | null,
): Promise<string[] | null | undefined> {
  try {
    await stat(systemd.dropIn);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    r.error(systemd.dropIn, e);
    return null;
  }
  if (mounts === null) return null;
  if (!mounts.length) return [];
  const units = [...new Set(mounts.map((m) => scrubTimer(m.mount)))];
  let words: string[] | null;
  try {
    words = await systemd.states(units);
  } catch (e) {
    r.error("systemctl", e);
    return null;
  }
  if (!words) return null;
  const state = new Map(units.map((unit, i) => [unit, words[i]]));
  const filesystems = new Map<string, ScrubMount[]>();
  for (const mount of mounts) {
    const key = filesystemKey(mount);
    filesystems.set(key, [...(filesystems.get(key) ?? []), mount]);
  }
  return [...filesystems.values()].flatMap((shared) => {
    const read = shared.map((m) => state.get(scrubTimer(m.mount)));
    const first = shared.find((m) => m.watched);
    return first && read.every((word) => word === "disabled")
      ? [scrubTimer(first.mount)]
      : [];
  });
}
