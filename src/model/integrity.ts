import {
  corruptionTotal,
  scrubCoverage,
  scrubFoundDamage,
} from "../collect/btrfs";
import type { Config } from "../config/config";
import type { CsumFailure, Scrub, Snapshot, Storage, Volume } from "./types";
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
 * What a damaged address names. `files` lists every name the reporter
 * resolved for it, `none` is an address with no path left: the free space
 * or file already gone that an older report wrote, or the files a report
 * listed that have all been removed since it was written, which the
 * collector drops because only paths still on disk are listed. `unresolved`
 * is damage the reporter could not name every file of, so no file under it
 * is listed.
 */
export type DamageKind = "files" | "none" | "unresolved";
/**
 * One damaged block address as the screen groups it. On some kernels the
 * address is the start of the 64 KiB block the check could not repair, not
 * the damaged sector, so the reporter resolves every 4 KiB sector of that
 * block and lists every name any of them gives: every path under it is
 * possibly damaged rather than proven so, more than one file can share the
 * block, and one extent under two names lists both.
 */
export interface DamagedGroup {
  logical: number;
  paths: string[];
  kind: DamageKind;
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
/**
 * Which source dated the last new error. They are different facts: the
 * counter grew while a vsys process watched it, or the kernel logged a failed
 * checksum read, whether or not anything was watching.
 */
export type ErrorSource = "counter" | "kernel-log";
/** One filesystem's answer to: is my data damaged, and was the disk checked. */
export interface Integrity {
  id: string;
  device: string;
  mounts: string[];
  state: IntegrityState;
  /**
   * Seconds since the last FINISHED full check started, null where none has
   * ever finished. A later report that stopped early never moves this
   * backward to null: the collector remembers the last finished report's
   * start time across the one it overwrote, so a reader still learns how old
   * the last proof of a sound filesystem is.
   */
  checkAge: number | null;
  /**
   * Seconds since the newest error either source recorded, null while neither
   * recorded one.
   */
  errorAge: number | null;
  /** The source that recorded that error, null where neither did. */
  errorSource: ErrorSource | null;
  /** Seconds since the counter last grew, null while no growth was observed. */
  growthAge: number | null;
  /**
   * Whether that growth is new: after the last finished check, and not that
   * check's own finding.
   */
  growthNew: boolean;
  /** Seconds since the kernel last logged a failed checksum read here. */
  loggedAge: number | null;
  /** Whether that failure was logged after the last finished check. */
  loggedNew: boolean;
  /** False where the kernel log was not read, which is not a log of none. */
  kernelLog: boolean;
  /**
   * The inodes the kernel logged a failed read in since the last finished
   * check, newest first. A check that finished later read the filesystem end
   * to end, so an older failure is its to report.
   */
  logged: CsumFailure[];
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
  /**
   * Whether a check finished. Only a finished one has a result, so the fields
   * above carry nothing from a running or half-written report, and the words
   * say the check has not finished rather than that it counted nothing.
   */
  complete: boolean;
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
/** The newest report naming this filesystem, or none where no report does. */
function reportFor(id: string, scrubs: Scrub[]): Scrub | null {
  // A filesystem id is a UUID, and a report writing it in capitals names the
  // same filesystem. Matching on the spelling would read as never checked.
  const key = id.toLowerCase();
  const matching = scrubs.filter(
    (scrub) => scrub.fsid && scrub.fsid.toLowerCase() === key,
  );
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
  storage: Pick<Storage, "scrubs" | "csumFailures" | "lastFinishedScrub">,
  time: number,
  c: Config,
): Integrity {
  const scrub = reportFor(group.id, storage.scrubs);
  // Output vsys could not read names no file it can stand behind. An address
  // parsed out of otherwise unreadable text would list damaged files under a
  // headline saying the state is unknown, which is two claims at once.
  const readable = !scrub || scrub.readable !== false;
  // The collector's own memory of the last finished check, read here because
  // a report that finished but moved backward in time, such as a restored
  // older report, must not outrank it below.
  const remembered =
    storage.lastFinishedScrub?.[group.id.toLowerCase()] ?? null;
  // Only a finished check has a result, and only the newest one speaks for
  // it: a report that finished but started before the remembered finished
  // check is still itself finished, but it is not the authoritative, newer
  // check, so standing behind its own addresses or block count here would
  // report a stale zero over a remembered check that found damage. A report
  // with no readable start time is not known to be older, only undated: it
  // keeps standing for itself, because the restored-older-file case this
  // guards against always carries its own readable, older start time.
  const complete =
    readable &&
    scrub?.status === "finished" &&
    (remembered === null ||
      scrub?.startedAt == null ||
      scrub.startedAt >= remembered.at);
  const groups: DamagedGroup[] = (complete ? (scrub?.addresses ?? []) : []).map(
    (address) => ({
      logical: address.logical,
      paths: address.paths,
      kind:
        address.resolved === false
          ? "unresolved"
          : address.paths.length
            ? "files"
            : "none",
    }),
  );
  const counted = group.volumes.find((v) => v.countersAvailable !== false);
  const counter = counted
    ? corruptionTotal(counted.errors, counted.countersAvailable !== false)
    : null;
  // Every mount of one filesystem carries the same remembered growth, so the
  // time and its size are read from one of them rather than from two.
  const grew = group.volumes.find((v) => v.lastErrorAt != null);
  const grownAt = grew?.lastErrorAt ?? null;
  // A snapshot recorded before the kernel log was read carries nothing for
  // it, which is the same reading as a log vsys could not search.
  const kernelLog = storage.csumFailures != null;
  const failures = storage.csumFailures?.[group.id.toLowerCase()] ?? [];
  const loggedAt = failures.length
    ? Math.max(...failures.map((f) => f.at))
    : null;
  // The newer of the two is the last new error. On a tie the log speaks,
  // because it names the inode the counter cannot.
  const errorSource: ErrorSource | null =
    loggedAt !== null && (grownAt === null || loggedAt >= grownAt)
      ? "kernel-log"
      : grownAt !== null
        ? "counter"
        : null;
  const errorAt = errorSource === "kernel-log" ? loggedAt : grownAt;
  // The record of past growth failed to load, so "no error recorded" is a
  // reading vsys does not have rather than a reading of none.
  const errorKnown = group.volumes.every((v) => v.lastErrorKnown !== false);
  const running = scrub?.status === "running";
  // Only a check that says it finished, and is no older than the remembered
  // finished check, read the filesystem end to end on the newest known pass.
  // Every other word the current report carries, including one the helper
  // did not write and one vsys has never seen, is not itself a finished
  // check, and neither is a finished report that moved backward in time,
  // such as a restored older report: a list of the ways a check can stop
  // early, or an older report that still finished, would each call its own
  // word a completed, authoritative check, which is the wrong way to be
  // wrong about whether the disk was read. Soundness can still rest on an
  // earlier report that did finish, through `hasFinishedRecord` below.
  const finished = complete;
  const checkedAt = finished
    ? (scrub?.startedAt ?? null)
    : (remembered?.at ?? null);
  const checkAge = checkedAt === null ? null : Math.max(0, time - checkedAt);
  // Whether a finished check is on record at all, current or remembered. A
  // report that stopped early, or one gone from disk entirely, still leaves
  // this true when a finished one is remembered, so the ladder below judges
  // soundness from that memory instead of reading the current report's own
  // unfinished or absent state as if nothing had ever finished.
  const hasFinishedRecord = finished || remembered !== null;
  // The growth the last finished check accounts for, from the same report
  // or memory `checkedAt` comes from.
  const coverage =
    finished && scrub ? scrubCoverage(scrub) : (remembered?.covers ?? null);
  const errorSize = grew?.lastErrorSize ?? null;
  // A scrub's own finding is dated at the sample that saw the counter grow,
  // which follows the scrub's end when no vsys sample fell inside it. The
  // reading before that sample, where this process took it, bounds the
  // growth exactly; one from the file may be long stale, so without it the
  // growth is bounded by the sample that saw it. A check covers growth bounded
  // no later than its end that its own count accounts for.
  const grownSince = grew?.lastErrorBefore ?? grownAt;
  const grownCovered =
    grownSince !== null &&
    coverage !== null &&
    grownSince <= coverage.endedAt &&
    errorSize !== null &&
    errorSize <= coverage.errors;
  const growthNew =
    grownAt !== null &&
    (checkedAt === null || grownAt > checkedAt) &&
    !grownCovered;
  const loggedNew =
    loggedAt !== null && (checkedAt === null || loggedAt > checkedAt);
  const since = (at: number | null) =>
    at === null ? null : Math.max(0, time - at) / 1000;
  const state: IntegrityState =
    scrub && scrub.readable === false
      ? "unknown"
      : finished &&
          scrubFoundDamage({
            addressCount: groups.length,
            uncorrectable: scrub?.uncorrectable,
            problem: scrub?.problem ?? false,
          })
        ? "damaged"
        : // The current report does not speak for itself, either unfinished
          // or finished but older than the remembered check, while a
          // remembered finished one found damage: that memory must stand
          // until a later finished report says otherwise, never silently
          // read as sound because the report naming it is gone or moved
          // backward in time.
          !finished && remembered?.damaged
          ? "damaged"
          : growthNew || loggedNew
            ? "new-errors"
            : running
              ? "checking"
              : !hasFinishedRecord
                ? // Nothing has ever finished reading this filesystem, current
                  // or remembered. A report that exists but has not finished
                  // (or never will, like one that stopped early) is a
                  // different fact from no report ever having been written.
                  scrub === null
                  ? "never-checked"
                  : "unknown"
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
    errorAge: since(errorAt),
    errorSource,
    growthAge: since(grownAt),
    growthNew,
    loggedAge: since(loggedAt),
    loggedNew,
    kernelLog,
    logged: failures
      .filter((f) => checkedAt === null || f.at > checkedAt)
      .sort((a, b) => b.at - a.at),
    errorKnown,
    errorSize,
    blocks: complete ? (scrub?.uncorrectable ?? null) : null,
    counter,
    groups,
    scrub,
    readable,
    complete,
  };
}
/** One integrity reading per filesystem, in the order Storage draws them. */
export function integrities(s: Snapshot, c: Config): Integrity[] {
  return volumesByDevice(s.storage.volumes).map((group) =>
    integrity(group, s.storage, s.time, c),
  );
}
/**
 * The damaged addresses by what they name, and the files they list.
 * `unnamed` is how many blocks the check counted beyond the addresses its
 * report lists: the kernel rate-limits the line that names an address, and a
 * reporter lists a bounded number, so a list can be shorter than the damage.
 * Any unnamed or unresolved block means the listed files are not all of it.
 */
export function damageCounts(item: Integrity): {
  files: number | null;
  free: number | null;
  unresolved: number | null;
  unnamed: number | null;
} {
  // A `damaged` state reached only through a remembered finished check (the
  // current report does not itself speak: it stopped early, or is gone) has
  // no address data to count at all. That is unread, not a report that named
  // zero, so every count here is unknown rather than a zero that would read
  // as a check that found nothing to name.
  if (!item.complete)
    return { files: null, free: null, unresolved: null, unnamed: null };
  const of = (kind: DamageKind) =>
    item.groups.filter((group) => group.kind === kind);
  return {
    files: item.groups.reduce((sum, group) => sum + group.paths.length, 0),
    free: of("none").length,
    unresolved: of("unresolved").length,
    unnamed:
      item.blocks === null ? 0 : Math.max(0, item.blocks - item.groups.length),
  };
}
