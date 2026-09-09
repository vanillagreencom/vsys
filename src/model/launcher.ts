import type { Config } from "../config/config";
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

export interface LauncherStep {
  pid: number;
  comm: string;
  group: string;
  scope: string | null;
  executable: string | null;
}
export type LauncherConclusion = "shadowed" | "bare" | "unknown";
export interface LauncherTrail {
  pid: number;
  tool: string;
  scope: string | null;
  /** Ancestors from the immediate parent outwards. */
  ancestors: LauncherStep[];
  capsPresent: string[];
  capsMissing: string[];
  /** Leading PATH entries the login shell does not have. */
  pathPrefix: string[];
  conclusion: LauncherConclusion;
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
  c: Config,
  basePath: string[],
): LauncherTrail {
  const step = (p: Proc): LauncherStep => ({
    pid: p.pid,
    comm: p.comm,
    group: p.group,
    scope: scopeUnit(p.group),
    executable: p.executable,
  });
  const capsPresent = c.capMarkers.filter((name) => proc.env[name]);
  const capsMissing = c.capMarkers.filter((name) => !proc.env[name]);
  const scope = scopeUnit(proc.group);
  const prefix = proc.env.PATH ? pathPrefix(proc.env.PATH, basePath) : [];
  const conclusion: LauncherConclusion =
    proc.envAvailable === false
      ? "unknown"
      : capsPresent.length
        ? "shadowed"
        : "bare";
  const where = scope ? `the scope ${scope}` : `the cgroup ${proc.group}`;
  const summary =
    conclusion === "unknown"
      ? `Cannot read the environment of PID ${proc.pid}, so the launcher is unknown.`
      : conclusion === "shadowed"
        ? `The launcher was shadowed: ${capsPresent.join(" and ")} ${
            capsPresent.length > 1 ? "are" : "is"
          } set, but the process sits in ${where}.${
            prefix.length
              ? ` PATH starts with ${prefix.join(", ")}, which the login shell does not have.`
              : ""
          }`
        : `Launched bare: none of ${c.capMarkers.join(", ")} is set on PID ${proc.pid} in ${where}.`;
  return {
    pid: proc.pid,
    tool: proc.tool ?? "",
    scope,
    ancestors: parentChain(proc, procs).map(step),
    capsPresent,
    capsMissing,
    pathPrefix: prefix,
    conclusion,
    summary,
  };
}
