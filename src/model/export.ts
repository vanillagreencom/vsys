import type { Config } from "../config/config";
import { memberless } from "./lanes";
import type { Snapshot, SourceError } from "./types";
import {
  type CauseId,
  causes,
  type Level,
  type Meter,
  meters,
} from "./verdict";

export const summarySchema = "vsys.summary.v1";

export interface SummaryCause {
  cause: CauseId;
  level: Level | null;
  subject: string | null;
}
export interface SummaryMeter {
  id: Meter["id"];
  value: number | null;
  max: number | null;
  level: Level;
}
export interface Summary {
  schema: typeof summarySchema;
  time: number;
  verdict: SummaryCause[];
  meters: SummaryMeter[];
  errors: SourceError[];
}
export interface SummaryOptions {
  errors?: SourceError[];
  scratchMeasured?: boolean;
}

/** Escape terminal control characters before showing process-supplied strings. */
export function safe(value: unknown): string {
  // Kernel process strings can contain terminal escape and control bytes.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove terminal controls
  return String(value ?? "?").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function subject(cause: ReturnType<typeof causes>[number]): string | null {
  if (cause.lanes[0]) return cause.lanes[0].id;
  if (cause.groups[0]) return cause.groups[0].path;
  if (cause.paths[0]) return cause.paths[0];
  return null;
}

/** A reading `meters()` sets on every meter of this id; an unread one is null. */
function reading(meter: Meter, name: string): number | null {
  const value = meter.values[name];
  if (value === undefined)
    throw new Error(`Meter ${meter.id} carries no ${name} reading`);
  return value;
}

function summaryMeter(meter: ReturnType<typeof meters>[number]): SummaryMeter {
  switch (meter.id) {
    case "cpu":
      return {
        id: meter.id,
        value: reading(meter, "system"),
        max: 100,
        level: meter.level,
      };
    case "memory":
      return {
        id: meter.id,
        value: reading(meter, "used"),
        max: reading(meter, "total"),
        level: meter.level,
      };
    case "disk":
      return {
        id: meter.id,
        value: reading(meter, "some"),
        max: 100,
        level: meter.level,
      };
    case "builds":
      return {
        id: meter.id,
        value: reading(meter, "builds"),
        max: reading(meter, "cores"),
        level: meter.level,
      };
    default:
      throw new Error(`Unknown meter id: ${meter.id}`);
  }
}

/** Cheap machine verdict for external consumers. */
export function summarySnapshot(
  s: Snapshot,
  c: Config,
  options: SummaryOptions = {},
): Summary {
  const verdict: SummaryCause[] = causes(s, c).map((cause) => ({
    cause: cause.id,
    level: cause.level,
    subject: subject(cause),
  }));
  if (options.scratchMeasured === false)
    verdict.push({ cause: "scratch", level: null, subject: null });
  // Until a unit has an hour average, as in a `--once` run, the cause is
  // unmeasured, not clear.
  const units = s.services;
  if (
    units === null ||
    (units.length > 0 && units.every((u) => u.cpuHourPercent === null))
  )
    verdict.push({ cause: "service-cpu", level: null, subject: null });
  return {
    schema: summarySchema,
    time: s.time,
    verdict,
    meters: meters(s, c).map(summaryMeter),
    errors: options.errors ?? s.errors,
  };
}

export function exportSummary(
  s: Snapshot,
  c: Config,
  errors: SourceError[] = s.errors,
  options: Omit<SummaryOptions, "errors"> = {},
): string {
  return `${JSON.stringify(
    summarySnapshot(s, c, { ...options, errors }),
    null,
    2,
  )}\n`;
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
