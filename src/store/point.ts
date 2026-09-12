import { corruptionTotal } from "../collect/btrfs";
import type { Config } from "../config/config";
import { escaped } from "../model/lanes";
import type { Alert, Snapshot } from "../model/types";
import { sliceSum } from "../model/verdict";
import type { TimelineEvent } from "./events";

export interface Point {
  time: number;
  agents: number | null;
  desktop: number | null;
  memory: number | null;
  pressure: number | null;
  memoryPressure: number | null;
  ioPressure: number | null;
  corruption: number | null;
  unconfined: number;
  builds: number;
  alerts: Alert[];
  /** What changed since the previous sample, derived once by the store. */
  events: TimelineEvent[];
}
/**
 * A point marks the timeline strip when it recorded a change. Only a point
 * persisted before events existed falls back to its alerts, so an alert still
 * inside its hold does not mark a change the reader cannot find.
 */
export function changed(p: Point): boolean {
  return p.events ? p.events.length > 0 : p.alerts.length > 0;
}
/** Logical roles use configured slice names; nested groups are not counted twice. */
export function point(
  s: Snapshot,
  c: Config,
  events: TimelineEvent[] = [],
): Point {
  const seen = new Set<string>();
  let corruption: number | null =
    s.storage.mountsAvailable === false ? null : 0;
  for (const v of s.storage.volumes) {
    if (corruption === null) break;
    const total = v.fsid
      ? corruptionTotal(v.errors, v.countersAvailable !== false)
      : null;
    if (total === null) {
      corruption = null;
      break;
    }
    if (seen.has(v.fsid as string)) continue;
    seen.add(v.fsid as string);
    corruption += total;
  }
  const total = s.system.memory.MemTotal;
  const available = s.system.memory.MemAvailable;
  return {
    time: s.time,
    agents: sliceSum(s.groups, c.agentSlice, (g) => g.cpuPercent),
    desktop: sliceSum(s.groups, c.desktopSlice, (g) => g.cpuPercent),
    memory:
      total === undefined || available === undefined ? null : total - available,
    pressure: s.system.pressure.cpu?.some ?? null,
    memoryPressure: s.system.pressure.memory?.some ?? null,
    ioPressure: s.system.pressure.io?.some ?? null,
    corruption,
    unconfined: s.procs.filter((p) => escaped(p, c)).length,
    builds: s.procs.filter((p) => p.build).length,
    alerts: s.alerts.map((alert) => ({ ...alert })),
    events,
  };
}
