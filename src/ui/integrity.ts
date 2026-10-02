import {
  type DamagedGroup,
  damageCounts,
  type ErrorSource,
  type Integrity,
} from "../model/integrity";
import { shellLine } from "../model/shell";
import type { Capability, CsumFailure } from "../model/types";
import { age, count, gap } from "./format";
import { capabilityReason } from "./settings";

/**
 * What one filesystem's integrity state says in words. Every state but
 * `healthy` says something is wrong or unknown, so a filesystem nothing has
 * checked never reads as one that has been checked and found sound. A
 * filesystem nothing checks because the reports cannot be read at all says
 * why, so the reader is not left waiting for a check that cannot come.
 */
export function integrityWords(item: Integrity, scrub?: Capability): string {
  switch (item.state) {
    case "damaged": {
      const n = damageCounts(item);
      return n.files
        ? `Damaged files found: ${count(n.files, "file")}${n.other ? "" : ", all build output"}`
        : "Damaged data found";
    }
    case "new-errors":
      return "New errors since last check";
    case "never-checked":
      return scrub && !scrub.available
        ? `Never checked: ${capabilityReason(scrub)}`
        : "Never checked";
    case "stale":
      return `Not checked in ${age(item.checkAge ?? 0)}`;
    case "checking":
      return "Checking now";
    case "unknown":
      return "Damage state unknown";
    case "healthy":
      return "Healthy";
  }
}
/**
 * The line a reader gets without opening anything. It always carries both
 * times, because "when was the last corruption" and "has anything checked the
 * disk since" is one question and needs one answer. Each time names the
 * source that gave it: a check report read the whole filesystem, while the
 * counter and the kernel log saw only the reads that happened, and a reader
 * deciding whether to trust a green line needs to know which spoke.
 */
export function integrityLine(item: Integrity, scrub?: Capability): string {
  return [
    integrityWords(item, scrub),
    `last full check ${item.checkAge === null ? "never" : `${age(item.checkAge)} ago (scrub report)`}`,
    `last new error ${errorTime(item)}`,
  ].join(" · ");
}
/**
 * The headline reading: what the last check found. A count vsys did not read
 * never becomes a zero, and the two reasons it can be missing are different
 * facts: nothing has checked, or the check's report omitted the count.
 */
export function blocksText(item: Integrity): string {
  if (!item.scrub) return `${gap}: no check has reported on this filesystem`;
  if (!item.readable) return `${gap}: the report could not be read`;
  // A check still running, or one that stopped early, has counted nothing
  // yet. Saying its report carried no count would blame the report for that.
  if (!item.complete) return `${gap}: the check has not finished`;
  if (item.blocks === null || item.blocks === undefined)
    return `${gap}: the report carried no count`;
  return `${item.blocks} by the last full check`;
}
/**
 * Why a filesystem lists no damaged address. The three reasons are different
 * facts, and one of them is that nothing has looked: the sentence never lets
 * an absent list read as a check that found nothing.
 */
export function noDamageText(item: Integrity): string {
  if (!item.scrub)
    return "No check has reported on this filesystem, so no file is named.";
  if (!item.readable)
    return "The report could not be read, so nothing in it names a file.";
  if (!item.complete)
    return "The check has not finished, so it has named no file yet.";
  if (item.scrub.addresses === null || item.scrub.addresses === undefined)
    return "The report carries no damaged-file section, so it names no file. That is not a report of none.";
  return "No damaged address is left on this filesystem.";
}
/** What the reader should do with one damaged address. */
export function damageAdvice(group: DamagedGroup): string {
  // A name written since the check no longer proves what was read, so no
  // advice sends the reader at it with a delete.
  if (group.changed)
    return "written since the check: look before you remove anything";
  if (group.kind === "build") return "safe to delete and rebuild";
  if (group.kind === "other") return "restore from a backup or a snapshot";
  return "free space or already deleted, clears on the next check";
}
/**
 * The command that removes one damaged address, offered only for an address a
 * rebuild replaces. Every path of such an address goes in one line: a Cargo
 * build script writes one extent under two names, and removing the first
 * leaves the damage on disk for the next check to find again, which reads as a
 * delete that worked and fixed nothing.
 *
 * An address holding anything else gets no command at all. A line a reader can
 * copy is a line a reader will run, and the data under that address is
 * restored from a backup rather than deleted.
 */
export function deleteCommand(group: DamagedGroup): string | undefined {
  return group.kind === "build" && !group.changed && group.paths.length
    ? shellLine(["rm", "-f", ...group.paths])
    : undefined;
}
/** One line that removes every damaged path a rebuild would replace. */
export function rebuildCommand(item: Integrity): string | undefined {
  const paths = item.groups
    .filter((group) => group.kind === "build" && !group.changed)
    .flatMap((group) => group.paths);
  return paths.length ? shellLine(["rm", "-f", ...paths]) : undefined;
}
const sourceWords: Record<ErrorSource, string> = {
  counter: "error counter",
  "kernel-log": "kernel log",
};
/**
 * The last new error and the source that recorded it. An unreadable record of
 * past growth is not an absence of errors, so the two never share a word, and
 * "none" names the sources that recorded none: a kernel log vsys could not
 * search recorded nothing either way.
 */
const errorTime = (item: Integrity): string => {
  if (!item.errorKnown) return gap;
  if (item.errorSource === null)
    return item.kernelLog
      ? "none (error counter, kernel log)"
      : "none (error counter only)";
  return `${age(item.errorAge ?? 0)} ago (${sourceWords[item.errorSource]})`;
};
/**
 * One inode the kernel logged a failed read in. Naming its file needs root,
 * so it stays an inode until a check names the file.
 */
export function loggedText(failure: CsumFailure, time: number): string {
  return `inode ${failure.inode} in subvolume ${failure.root}, logged ${age(Math.max(0, time - failure.at) / 1000)} ago`;
}
/** What the inodes under a filesystem are, in one sentence. */
export const loggedSentence =
  "The kernel logged failed checksum reads in these files since the last full check. Naming a file takes root, so the next check names them.";
/** Why a flat counter is not a healthy disk, in one sentence. */
export const counterSentence =
  "The counter counts reads that failed their checksum, not files. Every read of the same damaged block counts again, and a block nothing reads never counts at all.";
