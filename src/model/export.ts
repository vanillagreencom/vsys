import { memberless } from "./lanes";
import type { Snapshot } from "./types";

/** Escape terminal control characters before showing process-supplied strings. */
export function safe(value: unknown): string {
  // Kernel process strings can contain terminal escape and control bytes.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove terminal controls
  return String(value ?? "?").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/**
 * The snapshot both export formats write. A lane with no member read leads no
 * process, so its main PID is written as unknown.
 */
export function exportedSnapshot(snapshot: Snapshot) {
  return {
    ...snapshot,
    lanes: snapshot.lanes.map((lane) => ({
      ...lane,
      mainPid: memberless(lane.mainPid) ? null : lane.mainPid,
    })),
  };
}

export function exportJson(snapshot: Snapshot): string {
  return `${JSON.stringify(exportedSnapshot(snapshot), null, 2)}\n`;
}
