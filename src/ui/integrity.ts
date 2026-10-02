import {
  type DamagedGroup,
  damageCounts,
  type ErrorSource,
  type Integrity,
} from "../model/integrity";
import type { Capability, CsumFailure } from "../model/types";
import { age, count, gap } from "./format";
import { capabilityReason } from "./settings";

/**
 * What one filesystem's integrity state says in words. Every state but
 * `healthy` says something is wrong or unknown, so a filesystem nothing has
 * checked never reads as one that has been checked and found sound. A
 * filesystem whose reports cannot be read at all says why, so the reader is
 * not left waiting for a report that cannot come.
 */
export function integrityWords(item: Integrity, scrub?: Capability): string {
  switch (item.state) {
    case "damaged": {
      const n = damageCounts(item);
      // Blocks no file is named for are damage the listed files do not
      // cover, so the count of them stands beside the files.
      const unnamed = n.unresolved + n.unnamed;
      return n.files
        ? `Damage found: ${count(n.files, "possibly damaged file")}${unnamed ? `, ${count(unnamed, "block")} unnamed` : ""}`
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
  const { unnamed } = damageCounts(item);
  if (unnamed)
    return `The check counted ${count(unnamed, "damaged block")} and its report names none of them, so no file is offered.`;
  return "No damaged address is left on this filesystem.";
}
/**
 * Why the listed files are not all of the damage, where they are not. The
 * kernel rate-limits the line that names an address, so a check can count
 * more damaged blocks than its report lists.
 */
export function unnamedText(item: Integrity): string | undefined {
  const { unnamed } = damageCounts(item);
  return unnamed && item.groups.length
    ? `The check counted ${count(unnamed, "more damaged block")} than its report names, so the files above are not all of the damage.`
    : undefined;
}
/** What one damaged address names, beside its block number. */
export function damageAdvice(group: DamagedGroup): string {
  switch (group.kind) {
    case "files":
      return "possibly damaged";
    case "unresolved":
      return "its files could not be named";
    case "none":
      return "free space or already deleted, clears on the next check";
  }
}
/**
 * Why a listed file is possibly damaged rather than damaged, in one sentence
 * Storage and the damage card both read. On some kernels the line the
 * reporter reads carries only the start of the block the check could not
 * repair, and vsys cannot tell which kernel wrote it, so the reporter
 * resolves every 4 KiB sector of that block rather than just its start. More
 * than one file can share a block, so no report names the damaged file for
 * certain, and vsys offers no command to remove one.
 */
export const possibleSentence =
  "On some kernels the check logs where each 64 KiB block it could not repair starts, not the damaged sector, so the report resolves every 4 KiB sector of that block: more than one file can share a block, a listed file may be sound, and the files listed are possibly damaged rather than proven so.";
const sourceWords: Record<ErrorSource, string> = {
  counter: "error counter",
  "kernel-log": "kernel log",
};
/**
 * The last new error and the source that recorded it. An unreadable record of
 * past growth is not an absence of errors, so the two never share a word, and
 * "none" names only the sources vsys read: a counter it could not read, or a
 * kernel log it could not search, recorded nothing either way, and with
 * neither read the time is not available.
 */
const errorTime = (item: Integrity): string => {
  // A failure the kernel logged is a dated reading whatever the counter's
  // record says. Only a time the counter alone would give goes unread.
  if (!item.errorKnown && item.errorSource !== "kernel-log") return gap;
  if (item.errorSource === null) {
    const read = [
      ...(item.counter !== null ? [sourceWords.counter] : []),
      ...(item.kernelLog ? [sourceWords["kernel-log"]] : []),
    ];
    return read.length ? `none (${read.join(", ")})` : gap;
  }
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
  "The kernel logged failed checksum reads in these files since the last full check. Naming a file takes root, so each stays an inode here.";
/** Why a flat counter is not a healthy disk, in one sentence. */
export const counterSentence =
  "The counter counts reads that failed their checksum, not files. Every read of the same damaged block counts again, and a block nothing reads never counts at all.";
