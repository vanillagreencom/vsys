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
/** What one process says about its launcher. The prose is written from these. */
export interface LauncherTrail {
  conclusion: LauncherConclusion;
  /** The process this trail was read from. */
  pid: number;
  /** The configured confinement markers set on that process. */
  caps: string[];
  /** The unit name of the scope it sits in, null outside any scope. */
  scope: string | null;
  /** The cgroup path it sits in, which names the place when the scope does not. */
  group: string;
  /** PATH entries ahead of the first the login shell also has. */
  prefix: string[];
  /** Each ancestor as its command and cgroup, nearest first. */
  chain: string[];
}
/** One group's prose in two parts: a narrow card gives up the second. */
export interface LauncherSentence {
  /** The conclusion, its markers and where the processes sit. */
  conclusion: string;
  /** The ancestors of one named process, or nothing when it has none. */
  started: string;
  /** What the sentence concluded, for a card counting conclusions by kind. */
  kind: LauncherConclusion;
}
/** Entries before the first one the login shell also has were prepended. */
export function pathPrefix(path: string, base: string[]): string[] {
  const known = new Set(base.filter((entry) => entry !== ""));
  const entries = path.split(":").filter((entry) => entry !== "");
  const index = entries.findIndex((entry) => known.has(entry));
  return index < 0 ? entries : entries.slice(0, index);
}
/** A chain naming one neighbour twice says nothing on the second reading. */
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
  return {
    conclusion:
      proc.envAvailable === false
        ? "unknown"
        : caps.length
          ? "shadowed"
          : "bare",
    pid: proc.pid,
    caps,
    scope,
    group: proc.group,
    prefix: proc.env.PATH ? pathPrefix(proc.env.PATH, basePath) : [],
    chain: collapse(
      parentChain(proc, procs).map(
        (p) => `${p.comm} in ${scopeUnit(p.group) ?? p.group}`,
      ),
    ),
  };
}
/**
 * The processes a group holds share every fact its sentence states, so the
 * sentence names them as a count and gives the chain for one of them. One
 * process is named by its PID, which is what a reader looks it up by.
 */
function groupSentence(
  trails: LauncherTrail[],
  c: CollectionConfig,
): LauncherSentence {
  const first = trails[0];
  const n = trails.length;
  const many = n === 1 ? `PID ${first.pid}` : `${n} processes`;
  const where = first.scope
    ? `the scope ${first.scope}`
    : `the cgroup ${first.group}`;
  // The example names its own PID, and is a member whose ancestors are still
  // in the sample: the first process of a group may have lost its parent
  // between samples while its neighbours still hold theirs.
  const example = trails.find((t) => t.chain.length) ?? first;
  const started = example.chain.length
    ? ` Started from PID ${example.pid}: ${example.chain.join(", ")}.`
    : "";
  const path = first.prefix.length
    ? ` PATH starts with ${first.prefix.join(", ")}, which the login shell does not have.`
    : "";
  const conclusion =
    first.conclusion === "unknown"
      ? `Cannot read the environment of ${many} in ${where}, so the launcher is unknown.`
      : first.conclusion === "shadowed"
        ? `The launcher was shadowed: ${first.caps.join(" and ")} ${
            first.caps.length > 1 ? "are" : "is"
          } set, but ${many} ${n === 1 ? "sits" : "sit"} in ${where}.${path}`
        : `Launched bare: none of ${c.capMarkers.join(", ")} is set on ${many} in ${where}.${path}`;
  return { conclusion, started, kind: first.conclusion };
}
/**
 * One sentence per group rather than one per process. A lane holds many
 * processes and each of them repeats the same conclusion, so per-process
 * sentences fill a card with one fact written over and over. A group is the
 * processes that agree on all four facts a sentence states: the conclusion,
 * the scope, the markers set on them and the PATH entries ahead of the login
 * shell's own.
 */
export function launcherCopy(
  procs: Proc[],
  all: Proc[],
  c: CollectionConfig,
  basePath: string[],
): LauncherSentence[] {
  const groups = new Map<string, LauncherTrail[]>();
  for (const proc of procs) {
    const trail = launcherTrail(proc, all, c, basePath);
    // The whole cgroup path, and the arrays as arrays: two scopes of one unit
    // name under different slices are two places, and one entry holding a
    // comma is not two entries.
    const key = JSON.stringify([
      trail.conclusion,
      trail.group,
      trail.caps,
      trail.prefix,
    ]);
    const held = groups.get(key);
    if (held) held.push(trail);
    else groups.set(key, [trail]);
  }
  return [...groups.values()].map((trails) => groupSentence(trails, c));
}
/**
 * Every group as a count per conclusion, for a card too narrow to write one
 * sentence out: at the floor a panel can be, one conclusion and the count of
 * the groups left unwritten do not fit together in the rows a card has. This
 * is what it can say there with nothing cut, and it is the same three words
 * the sentences use.
 */
export function launcherTally(sentences: LauncherSentence[]): string {
  const kinds: LauncherConclusion[] = ["bare", "shadowed", "unknown"];
  const found = kinds
    .map((kind) => [kind, sentences.filter((x) => x.kind === kind).length])
    .filter(([, n]) => n)
    .map(([kind, n]) => `${n} ${kind}`);
  const n = sentences.length;
  return `${n} ${n === 1 ? "group" : "groups"} of processes: ${found.join(", ")}.`;
}
