import { basename } from "node:path";
import type { Config } from "../config/config";
import type { Proc, Sccache, SccacheDelta, Snapshot } from "./types";
import { buildLoad } from "./verdict";

/** One row per lane that is building, plus one row for everything outside them. */
export interface LaneBuilds {
  id: string;
  name: string;
  builds: number;
  linkers: number;
  /** The linker executables running there, so the disk writers are named. */
  linkerNames: string[];
}
/** A GNU make token pool, identified by the FIFO its participants share. */
export interface Jobserver {
  fifo: string;
  /** Tokens the pool was created with, unknown when MAKEFLAGS omits -j. */
  total: number | null;
  inUse: number;
}
export type Rates = SccacheDelta & { rate: number | null };
export interface CacheEffect {
  available: boolean;
  sinceStart: Rates | null;
  recent: Rates | null;
  /** Lanes whose build processes carry an empty RUSTC_WRAPPER. */
  bypassed: string[];
}
export interface BuildsSummary {
  builds: number;
  linkers: number;
  lanes: number;
  cores: number;
  rows: LaneBuilds[];
  cache: CacheEffect;
  jobservers: Jobserver[];
}
/** Undefined until the cache served a request; a zero denominator is not zero. */
export function hitRate(hits: number, misses: number): number | null {
  const total = hits + misses;
  return total > 0 ? (hits * 100) / total : null;
}
function rates(d: SccacheDelta | null): Rates | null {
  return d === null ? null : { ...d, rate: hitRate(d.hits, d.misses) };
}
/** The lane that owns a PID, so every build process is attributed once. */
function laneOwners(s: Snapshot): Map<number, { id: string; name: string }> {
  const owners = new Map<number, { id: string; name: string }>();
  for (const lane of s.lanes)
    for (const pid of lane.pids)
      if (!owners.has(pid)) owners.set(pid, { id: lane.id, name: lane.name });
  return owners;
}
/**
 * Build processes grouped by lane. Rows sum to the fleet total, so the count
 * the Overview meter shows and the per-lane breakdown cannot disagree.
 */
export function laneBuilds(s: Snapshot, c: Config): LaneBuilds[] {
  const owners = laneOwners(s);
  const rows = new Map<string, LaneBuilds>();
  for (const p of s.procs) {
    if (!p.build) continue;
    const owner = owners.get(p.pid) ?? { id: "", name: "" };
    const row = rows.get(owner.id) ?? {
      ...owner,
      builds: 0,
      linkers: 0,
      linkerNames: [],
    };
    row.builds++;
    if (c.linkerNames.includes(p.build)) {
      row.linkers++;
      if (!row.linkerNames.includes(p.build)) row.linkerNames.push(p.build);
    }
    rows.set(owner.id, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.builds - a.builds || a.name.localeCompare(b.name),
  );
}
/**
 * A build process whose RUSTC_WRAPPER is present but empty compiles without
 * sccache, whatever the cache counters say. An unreadable environment is not
 * evidence of a bypass.
 */
export function bypassedLanes(s: Snapshot): string[] {
  const owners = laneOwners(s);
  const names = new Set<string>();
  for (const p of s.procs) {
    if (!p.build || p.envAvailable === false) continue;
    if (!Object.hasOwn(p.env, "RUSTC_WRAPPER")) continue;
    if (p.env.RUSTC_WRAPPER.trim() !== "") continue;
    names.add(owners.get(p.pid)?.name || basename(p.group));
  }
  return [...names].sort();
}
/** The token pool a process advertises, or null when it holds none. */
function jobserverFifo(p: Proc): string | null {
  if (!p.build || p.envAvailable === false) return null;
  return /--jobserver-auth=fifo:(\S+)/.exec(p.env.MAKEFLAGS ?? "")?.[1] ?? null;
}
/**
 * The closest classified ancestor, found past the unclassified helpers a
 * compiler puts between itself and its linker. The start-time guard rejects a
 * reused parent PID and ends any cycle.
 */
function buildAncestor(p: Proc, byPid: Map<number, Proc>): Proc | null {
  const seen = new Set([p.pid]);
  let child = p;
  let a = byPid.get(p.ppid);
  while (a && a.start <= child.start && !seen.has(a.pid)) {
    if (a.build) return a;
    seen.add(a.pid);
    child = a;
    a = byPid.get(a.ppid);
  }
  return null;
}
/**
 * Token pools read from build process environments. The FIFO itself is never
 * opened, because reading it would take a token away from the build.
 *
 * MAKEFLAGS is inherited down the process tree, so a compiler and the linker
 * it runs advertise one pool twice. Only the outermost holder took a token,
 * and only it is counted.
 */
export function jobservers(s: Snapshot): Jobserver[] {
  const byPid = new Map(s.procs.map((p) => [p.pid, p]));
  const rows = new Map<string, Jobserver>();
  for (const p of s.procs) {
    const fifo = jobserverFifo(p);
    if (fifo === null) continue;
    const ancestor = buildAncestor(p, byPid);
    if (ancestor !== null && jobserverFifo(ancestor) === fifo) continue;
    const jobs = /(?:^|\s)(?:-j\s*|--jobs=)(\d+)/.exec(
      p.env.MAKEFLAGS ?? "",
    )?.[1];
    const row = rows.get(fifo) ?? { fifo, total: null, inUse: 0 };
    if (row.total === null && jobs !== undefined) row.total = Number(jobs);
    row.inUse++;
    rows.set(fifo, row);
  }
  return [...rows.values()].sort((a, b) => a.fifo.localeCompare(b.fifo));
}
export function cacheEffect(s: Snapshot): CacheEffect {
  const reading: Sccache | undefined = s.sccache;
  return {
    available: reading?.available === true,
    sinceStart: rates(reading?.sinceStart ?? null),
    recent: rates(reading?.recent ?? null),
    bypassed: bypassedLanes(s),
  };
}
/** The fleet total comes from the same buildLoad the Overview meter reads. */
export function buildsSummary(s: Snapshot, c: Config): BuildsSummary {
  const load = buildLoad(s, c);
  return {
    ...load,
    cores: s.system.cores,
    rows: laneBuilds(s, c),
    cache: cacheEffect(s),
    jobservers: jobservers(s),
  };
}
