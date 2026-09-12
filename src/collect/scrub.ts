/**
 * The scrub report contract. A privileged timer runs the scrub and leaves one
 * report per filesystem in `scrubDir`; vsys reads that file and runs nothing.
 * The report's opening lines are prose and may be reworded, so every reading
 * here anchors on a labelled field or on the `logical <address>:` heading, and
 * a report that carries no damaged-file section at all still parses.
 *
 * `docs/architecture/storage.md` holds the format the helper must write.
 */

import type { DamagedAddress } from "../model/types";

/** What one report file says, with every field it did not carry left null. */
export interface ScrubReport {
  /** The filesystem UUID, which is also its directory name under `btrfsRoot`. */
  uuid: string | null;
  /** When the scrub started, in milliseconds. */
  startedAt: number | null;
  /** The scrub's own status word, lowercased: finished, running, aborted. */
  status: string | null;
  uncorrectable: number | null;
  corrected: number | null;
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
  return found.length === 1 ? found[0][1] : null;
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
 * Whether a labelled count is a reading. A label the report states more than
 * once, or states with something that is not a number, carries no count, and
 * a caller defaulting that to zero would call a malformed report clean.
 */
export function counted(raw: string, name: string): boolean {
  return stated(raw, name) === 1 && number(raw, name) !== null;
}

/**
 * Read a report. Unknown text is not an error here: `scrubProblem` is what
 * refuses to call unreadable output clean, and this fills what it can.
 */
export function parseScrub(raw: string): ScrubReport {
  const started = field(raw, "Scrub started");
  const at = started === null ? Number.NaN : Date.parse(started);
  const lines = raw.split("\n");
  // The section heading is prose, so its presence is the only thing read from
  // it. Everything under it is anchored on the address heading instead.
  const opened = lines.findIndex((line) => /^Damaged files:/.test(line));
  let addresses: DamagedAddress[] | null = opened < 0 ? null : [];
  let current: DamagedAddress | null = null;
  // Only the lines under the section heading hold addresses. Anything above
  // it is the report's own prose, and a prose line shaped like an address
  // would otherwise become damage with a delete command attached.
  for (const line of opened < 0 ? [] : lines.slice(opened + 1)) {
    const heading = line.match(/^logical (\d+):\s*$/);
    if (heading) {
      current = { logical: Number(heading[1]), paths: [] };
      addresses = [...(addresses ?? []), current];
      continue;
    }
    // A path is indented under its address. The parenthesised line saying no
    // file resolved is not a path, and a line at column zero ends the group.
    const path = line.match(/^ {2}(\S.*?)\s*$/);
    if (!path || !current) {
      if (!/^\s/.test(line)) current = null;
      continue;
    }
    if (!path[1].startsWith("(")) current.paths.push(path[1]);
  }
  return {
    uuid: field(raw, "UUID")?.match(/^[0-9a-f-]{36}$/i)?.[0] ?? null,
    startedAt: Number.isFinite(at) ? at : null,
    status: field(raw, "Status")?.toLowerCase().split(/\s/)[0] ?? null,
    uncorrectable: number(raw, "Uncorrectable"),
    corrected: number(raw, "Corrected"),
    addresses,
  };
}
