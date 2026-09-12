import { corruptionTotal } from "../collect/btrfs";
import type { Config } from "../config/config";
import type { Scrub, Snapshot, Volume } from "./types";
import type { Level } from "./verdict";

/**
 * Btrfs subvolumes of one filesystem each mount separately and each report the
 * whole filesystem's free space and error counters, so the filesystem is the
 * unit here and its mounts sit under it.
 */
export interface DeviceVolumes {
  /** The identity the group was formed on: the filesystem id where resolved. */
  id: string;
  /** The device a reader would type, taken from the group's first mount. */
  device: string;
  volumes: Volume[];
}
/**
 * What identifies the filesystem a mount belongs to. The collector resolves a
 * Btrfs filesystem id per mount, and that is the identity the counters and the
 * scrub reports are keyed by. The mount source is not: one filesystem reached
 * through a mapper alias, a canonical path or a second member device carries
 * three different source strings and would split into three filesystems, each
 * repeating the one integrity state this grouping exists to state once. The
 * source is the fallback for a mount whose filesystem id could not be resolved.
 */
const filesystemKey = (v: Volume): string => v.fsid ?? v.device;
export function volumesByDevice(volumes: Volume[]): DeviceVolumes[] {
  const order: string[] = [];
  const byDevice = new Map<string, Volume[]>();
  for (const volume of volumes) {
    const key = filesystemKey(volume);
    const group = byDevice.get(key);
    if (group) group.push(volume);
    else {
      byDevice.set(key, [volume]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const volumes = byDevice.get(key) ?? [];
    // The heading names the device a reader would type. The identity stays
    // beside it, because two filesystems can report one device string and
    // only the id tells the groups apart.
    return { id: key, device: volumes[0]?.device ?? key, volumes };
  });
}

/**
 * A path glob. `**` crosses directory separators, `*` and `?` do not, so
 * `**​/target/**` names build output at any depth without also naming a file
 * called `target`.
 */
export function globMatch(pattern: string, path: string): boolean {
  let source = "^";
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at];
    if (char === "*") {
      if (pattern[at + 1] === "*") {
        // A `**/` segment must also match nothing at all, so `**​/target/**`
        // matches an absolute path whose first segment is already `target`.
        source += pattern[at + 2] === "/" ? "(?:.*/)?" : ".*";
        at += pattern[at + 2] === "/" ? 2 : 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`).test(path);
}

/** What a reader should do with a damaged address. */
export type DamageKind = "build" | "other" | "none";
/**
 * One damaged block address as the screen groups it. Every path of a group is
 * deleted together: one extent under two names is one piece of damage, and
 * removing the first name leaves it on disk for the next scrub to find again.
 */
export interface DamagedGroup {
  logical: number;
  paths: string[];
  kind: DamageKind;
  /**
   * True where a path under this address was written after the check began.
   * The check resolved these names as it ended, so a block freed and reused
   * since then resolves to an unrelated file: the name no longer proves what
   * was read, and no command offers to remove it.
   */
  changed: boolean;
}
/**
 * A filesystem's integrity state, worst first. Every state but `healthy` and
 * `checking` says something is wrong or unknown, and nothing vsys has not
 * checked is ever `healthy`.
 */
export type IntegrityState =
  | "damaged"
  | "new-errors"
  | "never-checked"
  | "stale"
  | "unknown"
  | "checking"
  | "healthy";
/** One filesystem's answer to: is my data damaged, and was the disk checked. */
export interface Integrity {
  id: string;
  device: string;
  mounts: string[];
  state: IntegrityState;
  /** Seconds since the last full check ended, null where there was none. */
  checkAge: number | null;
  /** Seconds since the counter last grew, null while no growth was observed. */
  errorAge: number | null;
  /** False where the record of past growth could not be read at all. */
  errorKnown: boolean;
  /** How far the counter grew that time. */
  errorSize: number | null;
  /** Uncorrectable blocks the last scrub counted. */
  blocks: number | null;
  /** The lifetime failed-read counter, which counts reads and not files. */
  counter: number | null;
  groups: DamagedGroup[];
  /** The report the state was read from, for the raw text one level down. */
  scrub: Scrub | null;
  /**
   * False where a report exists but its output could not be read. Nothing
   * parsed out of such a report is a reading, so the fields above carry
   * nothing from it and the words say that rather than reporting none.
   */
  readable: boolean;
}
const level: Record<IntegrityState, Level> = {
  damaged: "danger",
  "new-errors": "danger",
  "never-checked": "warn",
  stale: "warn",
  unknown: "warn",
  checking: "ok",
  healthy: "ok",
};
export function integrityLevel(state: IntegrityState): Level {
  return level[state];
}
/** A damaged address is safe to rebuild only when every name under it is. */
function classify(paths: string[], c: Config): DamageKind {
  if (!paths.length) return "none";
  return paths.every((path) =>
    c.buildOutputGlobs.some((glob) => globMatch(glob, path)),
  )
    ? "build"
    : "other";
}
/** The newest report naming this filesystem, or none where no report does. */
function reportFor(id: string, scrubs: Scrub[]): Scrub | null {
  const matching = scrubs.filter((scrub) => scrub.fsid && scrub.fsid === id);
  return (
    [...matching].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ??
    null
  );
}
/**
 * The state of one filesystem. The order below is the priority order: damage
 * that is still on disk outranks a counter that grew, which outranks never
 * having looked, which outranks having looked too long ago.
 */
export function integrity(
  group: DeviceVolumes,
  scrubs: Scrub[],
  time: number,
  c: Config,
): Integrity {
  const scrub = reportFor(group.id, scrubs);
  // Output vsys could not read names no file it can stand behind. An address
  // parsed out of otherwise unreadable text would put a delete command under a
  // headline saying the state is unknown, which is two claims at once.
  const readable = !scrub || scrub.readable !== false;
  const groups: DamagedGroup[] = (readable ? (scrub?.addresses ?? []) : []).map(
    (address) => ({
      logical: address.logical,
      paths: address.paths,
      kind: classify(address.paths, c),
      changed: (address.changed ?? []).length > 0,
    }),
  );
  const counted = group.volumes.find((v) => v.countersAvailable !== false);
  const counter = counted
    ? corruptionTotal(counted.errors, counted.countersAvailable !== false)
    : null;
  // Every mount of one filesystem carries the same remembered growth, so the
  // time and its size are read from one of them rather than from two.
  const grew = group.volumes.find((v) => v.lastErrorAt != null);
  const errorAt = grew?.lastErrorAt;
  const errorSize = grew?.lastErrorSize;
  // The record of past growth failed to load, so "no error recorded" is a
  // reading vsys does not have rather than a reading of none.
  const errorKnown = group.volumes.every((v) => v.lastErrorKnown !== false);
  // A report whose status the helper did not write is treated as finished:
  // the file exists because a scrub ended, and calling it a running scrub
  // would leave a stale report reading "checking" forever.
  const running = scrub?.status === "running";
  // A scrub that stopped early checked part of the filesystem, so it is not a
  // full check and its time is not a last-checked time.
  const stopped = /^(aborted|cancell?ed|interrupted)$/.test(
    scrub?.status ?? "",
  );
  const checkedAt = running || stopped ? null : (scrub?.startedAt ?? null);
  const checkAge = checkedAt === null ? null : Math.max(0, time - checkedAt);
  const errorAge = errorAt == null ? null : Math.max(0, time - errorAt);
  const state: IntegrityState =
    scrub && scrub.readable === false
      ? "unknown"
      : groups.length || (scrub?.uncorrectable ?? 0) > 0
        ? "damaged"
        : // A check that repaired every error it found left no damage behind,
          // so a report counting no uncorrectable block is not damage however
          // many errors it corrected. A problem report whose count vsys could
          // not read says nothing either way, and reads as damage.
          scrub?.problem &&
            !running &&
            !stopped &&
            (scrub.uncorrectable === null || scrub.uncorrectable === undefined)
          ? "damaged"
          : errorAt != null && (checkedAt === null || errorAt > checkedAt)
            ? "new-errors"
            : running
              ? "checking"
              : scrub === null
                ? "never-checked"
                : stopped
                  ? "unknown"
                  : // A report carrying no start time dates no check, so it
                    // cannot say the filesystem was read end to end recently.
                    // Neither can a filesystem whose counter, or whose record
                    // of past growth, is unreadable say nothing failed since.
                    checkAge === null || counter === null || !errorKnown
                    ? "unknown"
                    : checkAge > c.scrubMaxAgeDays * 86400000
                      ? "stale"
                      : "healthy";
  return {
    id: group.id,
    device: group.device,
    mounts: group.volumes.map((v) => v.mount),
    state,
    checkAge: checkAge === null ? null : checkAge / 1000,
    errorAge: errorAge === null ? null : errorAge / 1000,
    errorKnown,
    errorSize: errorSize ?? null,
    blocks: readable ? (scrub?.uncorrectable ?? null) : null,
    counter,
    groups,
    scrub,
    readable,
  };
}
/** One integrity reading per filesystem, in the order Storage draws them. */
export function integrities(s: Snapshot, c: Config): Integrity[] {
  return volumesByDevice(s.storage.volumes).map((group) =>
    integrity(group, s.storage.scrubs, s.time, c),
  );
}
/** The damaged addresses a reader can delete and rebuild, and the rest. */
export function damageCounts(item: Integrity): {
  files: number;
  build: number;
  other: number;
  free: number;
} {
  const of = (kind: DamageKind) =>
    item.groups.filter((group) => group.kind === kind);
  return {
    files: item.groups.reduce((sum, group) => sum + group.paths.length, 0),
    build: of("build").length,
    other: of("other").length,
    free: of("none").length,
  };
}
