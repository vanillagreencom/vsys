import { dirname, join, relative } from "node:path";
import type { Group } from "../model/types";
import { pairs, pressure, type Reader } from "./io";

/** io.stat has one line per device; the group's cost is their sum. */
export function ioTotals(text: string): { read: number; write: number } | null {
  const totals = { read: 0, write: 0 };
  let seen = false;
  for (const [, key, raw] of text.matchAll(/\b(rbytes|wbytes)=(\S+)/g)) {
    if (!/^\d+$/.test(raw)) throw new Error("Invalid io.stat counter");
    seen = true;
    totals[key === "rbytes" ? "read" : "write"] += Number(raw);
  }
  return seen ? totals : null;
}
/** memory.stat charges page cache to the group that faulted it in. */
export function pageCache(text: string): number | null {
  const match = text.match(/^file (\d+)$/m);
  return match ? Number(match[1]) : null;
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
        let io: { read: number; write: number } | null = null;
        if (ioRaw !== null) {
          try {
            io = ioTotals(ioRaw);
          } catch (e) {
            r.error(join(path, "io.stat"), e);
          }
        }
        const memRaw = r.text(join(path, "memory.stat"), true);
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
          max: r.number(join(path, "memory.max"), true),
          swap: r.number(join(path, "memory.swap.current"), true),
          swapMax: r.number(join(path, "memory.swap.max"), true),
          tasks: r.number(join(path, "pids.current"), true),
          tasksMax: r.number(join(path, "pids.max"), true),
          cache: memRaw === null ? null : pageCache(memRaw),
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
