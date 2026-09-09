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
 * An agent outside the agent slice was either started by a shadowed launcher,
 * which sets the confinement caps but not the cgroup, or started bare.
 */
export function launcherTrail(
  proc: Proc,
  procs: Proc[],
  c: CollectionConfig,
  basePath: string[],
): LauncherTrail {
  const capsPresent = c.capMarkers.filter((name) => proc.env[name]);
  const scope = scopeUnit(proc.group);
  const prefix = proc.env.PATH ? pathPrefix(proc.env.PATH, basePath) : [];
  const conclusion: LauncherConclusion =
    proc.envAvailable === false
      ? "unknown"
      : capsPresent.length
        ? "shadowed"
        : "bare";
  const where = scope ? `the scope ${scope}` : `the cgroup ${proc.group}`;
  const chain = parentChain(proc, procs)
    .map((p) => `${p.comm} in ${scopeUnit(p.group) ?? p.group}`)
    .join(", ");
  const started = chain ? ` Started from: ${chain}.` : "";
  const summary =
    conclusion === "unknown"
      ? `Cannot read the environment of PID ${proc.pid}, so the launcher is unknown.${started}`
      : conclusion === "shadowed"
        ? `The launcher was shadowed: ${capsPresent.join(" and ")} ${
            capsPresent.length > 1 ? "are" : "is"
          } set, but the process sits in ${where}.${
            prefix.length
              ? ` PATH starts with ${prefix.join(", ")}, which the login shell does not have.`
              : ""
          }${started}`
        : `Launched bare: none of ${c.capMarkers.join(", ")} is set on PID ${proc.pid} in ${where}.${started}`;
  return { conclusion, summary };
}
