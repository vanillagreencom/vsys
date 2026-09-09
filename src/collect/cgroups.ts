import { dirname, join, relative } from "node:path";
import type { Group } from "../model/types";
import { pairs, pressure, type Reader } from "./io";

interface IoTotals {
  read: number;
  write: number;
  /** Bytes written since boot, keyed by the kernel device number "MAJ:MIN". */
  byDevice: Record<string, number>;
}
/** io.stat has one line per device; the group's cost is their sum. */
function ioTotals(text: string): IoTotals | null {
  const totals: IoTotals = { read: 0, write: 0, byDevice: {} };
  let seen = false;
  for (const line of text.split("\n")) {
    const device = line.trim().split(/\s+/)[0];
    if (!device) continue;
    for (const [, key, raw] of line.matchAll(/\b(rbytes|wbytes)=(\S+)/g)) {
      if (!/^\d+$/.test(raw)) throw new Error("Invalid io.stat counter");
      seen = true;
      if (key === "rbytes") totals.read += Number(raw);
      else {
        totals.write += Number(raw);
        totals.byDevice[device] = (totals.byDevice[device] ?? 0) + Number(raw);
      }
    }
  }
  return seen ? totals : null;
}
/**
 * The cgroup v2 root counts every writer on the machine, including services and
 * containers outside the user manager the watched tree covers.
 */
export function collectDeviceWrites(
  r: Reader,
  top: string,
): Record<string, number> | null {
  const file = join(top, "io.stat");
  const raw = r.text(file, true);
  if (raw === null) return null;
  try {
    return ioTotals(raw)?.byDevice ?? null;
  } catch (e) {
    r.error(file, e);
    return null;
  }
}
function rate(
  now: number | null,
  before: number | null | undefined,
  elapsedMs: number,
): number | null {
  const known = now !== null && before !== null && before !== undefined;
  return known && elapsedMs > 0 && now >= before
    ? ((now - before) * 1000) / elapsedMs
    : null;
}

/** Walk every child so escaped scopes in other user slices remain visible. */
export function collectGroups(
  r: Reader,
  root: string,
  previous: Group[],
  elapsedMs: number,
): Group[] {
  const result: Group[] = [];
  const before = new Map(previous.map((g) => [g.path, g]));
  function visit(path: string) {
    const id = relative(root, path) || ".";
    const stat = r.text(join(path, "cpu.stat"));
    const pids = r.text(join(path, "cgroup.procs"));
    if (stat !== null && pids !== null) {
      try {
        const cpuUsec = pairs(stat).usage_usec;
        if (!Number.isFinite(cpuUsec))
          throw new Error("Missing cpu usage_usec");
        const old = before.get(id);
        const psi = Object.fromEntries(
          ["cpu", "memory", "io"].map((kind) => {
            const file = join(path, `${kind}.pressure`);
            const raw = r.text(file, true);
            try {
              return [kind, raw === null ? null : pressure(raw)];
            } catch (e) {
              r.error(file, e);
              return [kind, null];
            }
          }),
        );
        const ioRaw = r.text(join(path, "io.stat"), true);
        let io: IoTotals | null = null;
        if (ioRaw !== null) {
          try {
            io = ioTotals(ioRaw);
          } catch (e) {
            r.error(join(path, "io.stat"), e);
          }
        }
        // memory.stat charges page cache to the group that faulted it in.
        const file = r
          .text(join(path, "memory.stat"), true)
          ?.match(/^file (\d+)$/m)?.[1];
        const memoryMax = r.limit(join(path, "memory.max"), true);
        const members = pids ? pids.split(/\s+/).map(Number) : [];
        if (members.some((p) => !Number.isInteger(p) || p <= 0))
          throw new Error("Invalid cgroup process ID");
        result.push({
          path: id,
          parent: dirname(id),
          name:
            id === "."
              ? (root.split("/").at(-1) ?? root)
              : (id.split("/").at(-1) ?? id),
          pids: members,
          cpuUsec,
          cpuPercent:
            old && elapsedMs > 0 && cpuUsec >= old.cpuUsec
              ? (cpuUsec - old.cpuUsec) / (elapsedMs * 10)
              : null,
          weight: r.number(join(path, "cpu.weight"), true),
          cpuMax: r.text(join(path, "cpu.max"), true),
          memory: r.number(join(path, "memory.current"), true),
          high: r.number(join(path, "memory.high"), true),
          max: memoryMax.value,
          maxRead: memoryMax.read,
          swap: r.number(join(path, "memory.swap.current"), true),
          swapMax: r.number(join(path, "memory.swap.max"), true),
          tasks: r.number(join(path, "pids.current"), true),
          tasksMax: r.number(join(path, "pids.max"), true),
          cache: file === undefined ? null : Number(file),
          ioRead: io ? io.read : null,
          ioWrite: io ? io.write : null,
          readRate: rate(io ? io.read : null, old?.ioRead, elapsedMs),
          writeRate: rate(io ? io.write : null, old?.ioWrite, elapsedMs),
          pressure: psi,
        });
      } catch (e) {
        r.error(path, e);
      }
    }
    for (const child of r.dirs(path)) visit(join(path, child));
  }
  visit(root);
  return result;
}
