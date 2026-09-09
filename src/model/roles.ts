import type { Config } from "../config/config";
import type { Proc, Role } from "./types";

/** The unit name of the scope a process sits in, or null outside any scope. */
export function scopeUnit(group: string): string | null {
  return (
    group
      .split("/")
      .filter((s) => s.endsWith(".scope"))
      .at(-1) ?? null
  );
}
/** A terminal pane holds a shell; the agent it starts lives in its own scope. */
export function paneScope(group: string, prefixes: string[]): boolean {
  const unit = scopeUnit(group);
  return unit !== null && prefixes.some((prefix) => unit.startsWith(prefix));
}
/**
 * Tool processes that are not lanes are recognised by their arguments. Chrome's
 * native messaging host runs the same binary as an agent and must not be one.
 */
export function excludedArgv(command: string[], patterns: string[]): boolean {
  const argv = command.join(" ");
  return patterns.some((pattern) => pattern !== "" && argv.includes(pattern));
}
/** Roles are decided per process. Membership of a pane never confers a role. */
export function classify(
  p: Pick<Proc, "command" | "tool" | "build" | "group">,
  scopeMain: boolean,
  c: Config,
): Role {
  if (excludedArgv(p.command, c.excludeArgv)) return "helper";
  if (p.tool) return "agent";
  if (p.build) return "build";
  if (scopeMain && paneScope(p.group, c.paneScopePrefixes)) return "pane";
  return "other";
}
