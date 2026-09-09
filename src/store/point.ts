import type { Config } from "../config/config";
import { inSlice } from "../model/lanes";
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
    if (
      !v.fsid ||
      v.countersAvailable === false ||
      !Object.keys(v.errors).some((key) => key.endsWith("/corruption_errs"))
    ) {
      corruption = null;
      break;
    }
    if (seen.has(v.fsid)) continue;
    seen.add(v.fsid);
    corruption += Object.entries(v.errors)
      .filter(([key]) => key.endsWith("corruption_errs"))
      .reduce((sum, [, value]) => sum + value, 0);
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
    unconfined: s.procs.filter((p) => p.tool && !inSlice(p.group, c.agentSlice))
      .length,
    builds: s.procs.filter((p) => p.build).length,
    alerts: s.alerts.map((alert) => ({ ...alert })),
    events,
  };
}
