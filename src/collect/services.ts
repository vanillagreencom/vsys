import { join } from "node:path";
import type { Service } from "../model/types";
import { pairs, type Reader } from "./io";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
/**
 * How far past an hour the oldest checkpoint may be and still give an hour's
 * average: the average comes from a checkpoint 60 to 75 minutes old. A unit
 * with no such checkpoint has no average and raises nothing at any threshold.
 */
const slackMs = 15 * minuteMs;
interface Checkpoint {
  at: number;
  cpuUsec: number;
  identity: string;
}
/**
 * The system's own services, which the user manager's tree does not hold.
 * Each minute it reads the `cpu.stat` of every `.service` unit directly under
 * `system.slice` or one level inside a slice there; a unit's children are
 * already inside its own counter. A scope, such as a container, or a mount
 * holding a FUSE daemon is not one `systemctl restart` can safely restart, so
 * it is never read. The checkpoints stay in memory, at most an
 * hour and a minute of them per unit, and a settings change hands this object
 * to the replacement collector so an alert's window does not restart.
 */
export class ServiceCpu {
  private units = new Map<string, Checkpoint[]>();
  private last: Service[] | null = null;
  private lastAt?: number;
  /** The root the cached figures were read under. */
  private lastTop?: string;
  /** `now` is monotonic, so a wall-clock step cannot stretch the hour. */
  read(r: Reader, top: string, now: number): Service[] | null {
    if (
      this.lastTop === top &&
      this.lastAt !== undefined &&
      now - this.lastAt < minuteMs
    )
      return this.last;
    this.lastAt = now;
    this.lastTop = top;
    const errors = r.errors.length;
    const slice = join(top, "system.slice");
    const service = (name: string) => name.endsWith(".service");
    const paths = r.dirs(slice, true).flatMap((name) =>
      name.endsWith(".slice")
        ? r
            .dirs(join(slice, name))
            .filter(service)
            .map((child) => join("system.slice", name, child))
        : service(name)
          ? [join("system.slice", name)]
          : [],
    );
    this.last =
      r.errors.length > errors
        ? null
        : paths.map((path) => this.checkpoint(r, top, path, now));
    for (const [path, points] of this.units)
      if (now - (points.at(-1)?.at ?? 0) > hourMs) this.units.delete(path);
    return this.last;
  }
  private checkpoint(
    r: Reader,
    top: string,
    path: string,
    now: number,
  ): Service {
    const name = path.split("/").at(-1) ?? path;
    const identity = r.identity(join(top, path));
    const stat = r.text(join(top, path, "cpu.stat"));
    let cpuUsec: number | undefined;
    if (stat !== null)
      try {
        cpuUsec = pairs(stat).usage_usec;
        if (cpuUsec === undefined) throw new Error("Missing cpu usage_usec");
      } catch (e) {
        r.error(join(top, path, "cpu.stat"), e);
      }
    if (identity === null || cpuUsec === undefined)
      return { path, name, identity, read: false, cpuHourPercent: null };
    let points = this.units.get(path) ?? [];
    const newest = points.at(-1);
    // A new cgroup is a restarted unit, and a counter that went back is not
    // the one the window started on.
    if (newest && (newest.identity !== identity || cpuUsec < newest.cpuUsec))
      points = [];
    points.push({ at: now, cpuUsec, identity });
    const base = points.findLast((p) => now - p.at >= hourMs);
    if (base) points = points.slice(points.indexOf(base));
    this.units.set(path, points);
    return {
      path,
      name,
      identity,
      read: true,
      cpuHourPercent:
        base && now - base.at <= hourMs + slackMs
          ? (cpuUsec - base.cpuUsec) / ((now - base.at) * 10)
          : null,
    };
  }
}
