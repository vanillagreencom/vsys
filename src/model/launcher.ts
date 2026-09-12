import type { CollectionConfig } from "../collect/settings";
import { parentChain } from "./lanes";
import type { Proc } from "./types";

/** The unit name of the scope a process sits in, or null outside any scope. */
export function scopeUnit(group: string): string | null {
  return (
    group
      .split("/")
      .filter((s) => s.endsWith(".scope"))
      .at(-1) ?? null
  );
}

export type LauncherConclusion = "shadowed" | "bare" | "unknown";
export interface LauncherTrail {
  conclusion: LauncherConclusion;
  /** The process this trail was read from. */
  pid: number;
  /** The configured confinement markers set on that process. */
  caps: string[];
  /** The scope or cgroup it sits in, named as prose. */
  where: string;
  /** PATH entries ahead of the first the login shell also has. */
  prefix: string[];
  /** Each ancestor as its command and cgroup, nearest first. */
  chain: string[];
  /** One sentence naming the chain, the markers and the PATH prefix. */
  summary: string;
}
/** Entries before the first one the login shell also has were prepended. */
export function pathPrefix(path: string, base: string[]): string[] {
  const known = new Set(base.filter((entry) => entry !== ""));
  const entries = path.split(":").filter((entry) => entry !== "");
  const index = entries.findIndex((entry) => known.has(entry));
  return index < 0 ? entries : entries.slice(0, index);
}
/**
 * A chain that names one neighbour twice says nothing on the second reading:
 * a deep tree ending `systemd in init.scope, systemd in init.scope` costs two
 * of the few lines a card has for one fact.
 */
const collapse = (entries: string[]): string[] =>
  entries.filter((entry, i) => entry !== entries[i - 1]);
/**
 * An agent outside the agent slice was either started by a shadowed launcher,
 * which sets the confinement caps but not the cgroup, or started bare.
 */
export function launcherTrail(
  proc: Proc,
  procs: Proc[],
  c: CollectionConfig,
  basePath: string[],
): LauncherTrail {
  const caps = c.capMarkers.filter((name) => proc.env[name]);
  const scope = scopeUnit(proc.group);
  const prefix = proc.env.PATH ? pathPrefix(proc.env.PATH, basePath) : [];
  const conclusion: LauncherConclusion =
    proc.envAvailable === false ? "unknown" : caps.length ? "shadowed" : "bare";
  const where = scope ? `the scope ${scope}` : `the cgroup ${proc.group}`;
  const chain = collapse(
    parentChain(proc, procs).map(
      (p) => `${p.comm} in ${scopeUnit(p.group) ?? p.group}`,
    ),
  );
  const started = chain.length ? ` Started from: ${chain.join(", ")}.` : "";
  const summary =
    conclusion === "unknown"
      ? `Cannot read the environment of PID ${proc.pid}, so the launcher is unknown.${started}`
      : conclusion === "shadowed"
        ? `The launcher was shadowed: ${caps.join(" and ")} ${
            caps.length > 1 ? "are" : "is"
          } set, but the process sits in ${where}.${
            prefix.length
              ? ` PATH starts with ${prefix.join(", ")}, which the login shell does not have.`
              : ""
          }${started}`
        : `Launched bare: none of ${c.capMarkers.join(", ")} is set on PID ${proc.pid} in ${where}.${started}`;
  return { conclusion, pid: proc.pid, caps, where, prefix, chain, summary };
}
/**
 * The processes a group holds share every fact its sentence states, so the
 * sentence names them as a count and gives the chain for one of them.
 */
function groupSentence(trails: LauncherTrail[], c: CollectionConfig): string {
  const first = trails[0];
  const n = trails.length;
  const many = `${n} ${n === 1 ? "process" : "processes"}`;
  const started = first.chain.length
    ? ` Started from PID ${first.pid}: ${first.chain.join(", ")}.`
    : "";
  if (first.conclusion === "unknown")
    return `Cannot read the environment of ${many} in ${first.where}, so the launcher is unknown.${started}`;
  if (first.conclusion === "shadowed")
    return `The launcher was shadowed: ${first.caps.join(" and ")} ${
      first.caps.length > 1 ? "are" : "is"
    } set, but ${many} ${n === 1 ? "sits" : "sit"} in ${first.where}.${
      first.prefix.length
        ? ` PATH starts with ${first.prefix.join(", ")}, which the login shell does not have.`
        : ""
    }${started}`;
  return `Launched bare: none of ${c.capMarkers.join(", ")} is set on ${many} in ${first.where}.${started}`;
}
/**
 * One sentence per conclusion and scope rather than one per process. A lane
 * holds many processes and each of them repeats the same markers, the same
 * scope and the same ancestors, so per-process sentences fill a card with one
 * fact written over and over.
 */
export function launcherCopy(
  procs: Proc[],
  all: Proc[],
  c: CollectionConfig,
  basePath: string[],
): string[] {
  const groups = new Map<string, LauncherTrail[]>();
  for (const proc of procs) {
    const trail = launcherTrail(proc, all, c, basePath);
    const key = [
      trail.conclusion,
      trail.where,
      trail.caps.join(","),
      trail.prefix.join(","),
    ].join("|");
    const held = groups.get(key);
    if (held) held.push(trail);
    else groups.set(key, [trail]);
  }
  return [...groups.values()].map((trails) => groupSentence(trails, c));
}
