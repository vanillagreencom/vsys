/**
 * The scrub report contract. A privileged timer runs the scrub and leaves one
 * report per filesystem in `scrubDir`; vsys reads that file and runs nothing.
 * The report's opening lines are prose and may be reworded, so every reading
 * here anchors on a labelled field or on the `logical <address>:` heading, and
 * a report that carries no damaged-file section at all still parses.
 *
 * `docs/architecture/storage-integrity.md` holds the format the reporter must write,
 * and `scripts/scrub-reporter/` ships the reporter that writes it.
 */

import type { DamagedAddress } from "../model/types";

/**
 * Whether a file in the report directory is a report. A reporter writes its
 * report under a hidden name and renames it whole, so a hidden file is one
 * still being written, or one a stopped run left behind.
 */
export const isReportName = (name: string): boolean => !name.startsWith(".");

/** What one report file says, with every field it did not carry left null. */
export interface ScrubReport {
  /** The filesystem UUID, which is also its directory name under `btrfsRoot`. */
  uuid: string | null;
  /** When the scrub started, in milliseconds. */
  startedAt: number | null;
  /** The scrub's own status word, lowercased: finished, running, aborted. */
  status: string | null;
  /** How long the scrub ran, in milliseconds. */
  duration: number | null;
  uncorrectable: number | null;
  corrected: number | null;
  /** The checksum errors the scrub counted, from its `Error summary`. */
  csum: number | null;
  /**
   * The damaged addresses, or null where the report has no such section. A
   * report written before the section existed lists no files; it does not
   * claim there are none.
   */
  addresses: DamagedAddress[] | null;
}

/**
 * One labelled field. A report stating the same label twice, as a per-device
 * listing does, holds no single reading for it, and taking the first would
 * report one device's count as the filesystem's.
 */
const field = (raw: string, name: string): string | null => {
  const found = [
    ...raw.matchAll(new RegExp(`^\\s*${name}:[ \\t]+(.*\\S)`, "gm")),
  ];
  return found.length === 1 ? (found[0]?.[1] ?? null) : null;
};
/**
 * How many times the report states a labelled field. None is a field the
 * report does not carry; more than one is a report that holds no single
 * reading for it, and the two are different facts to the caller.
 */
export function stated(raw: string, name: string): number {
  return (raw.match(new RegExp(`^\\s*${name}:`, "gm")) ?? []).length;
}
const number = (raw: string, name: string): number | null => {
  const text = field(raw, name);
  // The whole field must be the count. Reading its leading digits would take
  // "0 (invalid)" as a zero and report a malformed result as clean.
  if (text === null || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};
/**
 * A `Duration` field: hours, minutes and seconds, as btrfs-progs prints it.
 * The hours are not bounded at a day, because a scrub can run for longer.
 */
const duration = (raw: string): number | null => {
  const parts = field(raw, "Duration")?.match(/^(\d+):([0-5]\d):([0-5]\d)$/);
  if (!parts) return null;
  const [hours, minutes, seconds] = parts.slice(1).map(Number);
  if (hours === undefined || minutes === undefined || seconds === undefined)
    return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
};
/**
 * The checksum errors an `Error summary` field counts. btrfs-progs writes
 * `no errors found`, or one `kind=N` entry per kind it counted, so a summary
 * that lists other kinds and no csum counted none. Any other text is no
 * reading.
 */
const csum = (raw: string): number | null => {
  const text = field(raw, "Error summary");
  if (text === null) return null;
  if (text === "no errors found") return 0;
  const entries = text
    .split(/\s+/)
    .map((entry) => entry.match(/^(\w+)=(\d+)$/));
  if (entries.some((entry) => entry === null)) return null;
  return Number(entries.find((entry) => entry?.[1] === "csum")?.[2] ?? 0);
};
/**
 * Whether a labelled count is a reading. A label the report states more than
 * once, or states with something that is not a number, carries no count, and
 * a caller defaulting that to zero would call a malformed report clean.
 */
export function counted(raw: string, name: string): boolean {
  return stated(raw, name) === 1 && number(raw, name) !== null;
}

/**
 * Whether a report line carries a name exactly: no whitespace at either end,
 * which a reader trimming the line would drop, no control character, and no
 * byte that was not UTF-8, which reading replaced with U+FFFD.
 */
const carried = (name: string): boolean =>
  name !== "" &&
  name === name.trim() &&
  ![...name].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (
      code < 0x20 ||
      code === 0x7f ||
      code === 0xfffd ||
      code === 0x2028 ||
      code === 0x2029
    );
  });

/**
 * Read a report. Unknown text is not an error here: `scrubProblem` is what
 * refuses to call unreadable output clean, and this fills what it can.
 */
export function parseScrub(raw: string): ScrubReport {
  const started = field(raw, "Scrub started");
  const at = started === null ? Number.NaN : Date.parse(started);
  const lines = raw.split("\n");
  // The fixed section label separates addresses from report prose. The text
  // after that label is prose; address headings carry the readings below it.
  const opened = lines.findIndex((line) => /^Damaged files:/.test(line));
  let addresses: DamagedAddress[] | null = opened < 0 ? null : [];
  let current: DamagedAddress | null = null;
  // Only the lines under the section heading hold addresses. Anything above
  // it is the report's own prose, and a prose line shaped like an address
  // would otherwise become damage with a file listed under it.
  for (const line of opened < 0 ? [] : lines.slice(opened + 1)) {
    const heading = line.match(/^logical (\d+):\s*$/);
    if (heading) {
      current = { logical: Number(heading[1]), paths: [] };
      addresses = [...(addresses ?? []), current];
      continue;
    }
    // A path is indented under its address, and taken byte for byte: the
    // screen lists exactly the name read here. A parenthesised line
    // is not a path, and a line at column zero ends the group. The "s" flag
    // lets "." reach a line terminator code point (U+2028, U+2029) the
    // reporter wrote inside a name, rather than dropping the line.
    const name = line.match(/^ {2}(.*)$/s)?.[1];
    if (name === undefined || !current) {
      if (!/^\s/.test(line)) current = null;
      continue;
    }
    // The reporter could not name every file under this address. It is
    // damage all the same, and no path under it is listed. Any name already
    // collected for this address is dropped too, whichever line marks it: an
    // address is all-or-none regardless of where in its group the mark falls.
    if (name.startsWith("(not resolved")) {
      current.resolved = false;
      current.paths = [];
    } else if (name.startsWith("(")) continue;
    // A name this text cannot carry exactly may be a different file's name
    // once read, so the address is not resolved either.
    else if (!carried(name)) {
      current.resolved = false;
      current.paths = [];
    }
    // Once the address is marked unresolved, a later name under it stays
    // unlisted too, so the set a reader sees is never a partial one.
    else if (current.resolved !== false) current.paths.push(name);
  }
  return {
    uuid: field(raw, "UUID")?.match(/^[0-9a-f-]{36}$/i)?.[0] ?? null,
    startedAt: Number.isFinite(at) ? at : null,
    status: field(raw, "Status")?.toLowerCase().split(/\s/)[0] ?? null,
    duration: duration(raw),
    uncorrectable: number(raw, "Uncorrectable"),
    corrected: number(raw, "Corrected"),
    csum: csum(raw),
    addresses,
  };
}
