import type { Config } from "../config/config";
import { inSlice } from "../model/lanes";
import type { Alert, Group, Snapshot } from "../model/types";

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
}
function sliceCpu(groups: Group[], name: string): number | null {
  const matching = groups.filter((g) => g.name === name);
  const roots = matching.filter(
    (g) =>
      !matching.some(
        (parent) =>
          parent !== g &&
          (parent.path === "." || g.path.startsWith(`${parent.path}/`)),
      ),
  );
  return roots.length && roots.every((g) => g.cpuPercent !== null)
    ? roots.reduce((sum, g) => sum + (g.cpuPercent ?? 0), 0)
    : null;
}
/** Logical roles use configured slice names; nested groups are not counted twice. */
export function point(s: Snapshot, c: Config): Point {
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
    agents: sliceCpu(s.groups, c.agentSlice),
    desktop: sliceCpu(s.groups, c.desktopSlice),
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
  };
}
