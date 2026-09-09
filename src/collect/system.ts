import { cpus, hostname } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/config";
import type { System } from "../model/types";
import { pairs, type Reader, readPressure } from "./io";

/** Global reads do not depend on systemd or a particular filesystem. */
export function collectSystem(r: Reader, c: Config): System {
  const load = r.text(join(c.procRoot, "loadavg"));
  const up = r.text(join(c.procRoot, "uptime"));
  const mem = r.text(join(c.procRoot, "meminfo"));
  if (load === null || up === null || mem === null)
    throw new Error("Cannot read core system counters");
  const loadValues = load.split(/\s+/).slice(0, 3).map(Number);
  const uptime = Number(up.split(" ")[0]);
  if (
    loadValues.length !== 3 ||
    loadValues.some((x) => !Number.isFinite(x)) ||
    !Number.isFinite(uptime)
  )
    throw new Error("Invalid load or uptime");
  const zram: System["zram"] = [];
  for (const device of r
    .names(c.sysBlockRoot)
    .filter((n) => /^zram\d+$/.test(n))) {
    const raw = r.text(join(c.sysBlockRoot, device, "mm_stat"));
    if (raw !== null) {
      const [original, compressed, used] = raw.split(/\s+/).map(Number);
      if ([original, compressed, used].every(Number.isFinite))
        zram.push({ device, original, compressed, used });
      else r.error(device, "Invalid zram mm_stat");
    }
  }
  return {
    host: hostname(),
    cores: cpus().length,
    load: loadValues,
    uptime,
    memory: pairs(mem),
    pressure: readPressure(r, join(c.procRoot, "pressure")),
    zram,
  };
}
