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
const number = (raw: string, name: string): number | null => {
  const text = field(raw, name);
  if (text === null) return null;
  const value = Number(text.match(/^\d+/)?.[0]);
  return Number.isFinite(value) ? value : null;
};

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
  const damaged = lines.some((line) => /^Damaged files:/.test(line));
  let addresses: DamagedAddress[] | null = damaged ? [] : null;
  let current: DamagedAddress | null = null;
  for (const line of lines) {
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
