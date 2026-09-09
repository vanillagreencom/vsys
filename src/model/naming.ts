import { basename } from "node:path";
import type { Config } from "../config/config";
import type { Proc } from "./types";

/**
 * The first of the named variables that carries a value. An unreadable
 * environment is not an unset variable, so it stays unknown.
 */
export function firstEnv(
  proc: Proc | undefined,
  names: string[],
): string | null {
  if (!proc || proc.envAvailable === false) return null;
  for (const name of names) {
    const value = proc.env[name];
    if (value) return value;
  }
  return null;
}
/**
 * Two agents in one worktree differ by their account, so the configuration
 * directory basename names the lane. A readable environment without any of
 * the configured variables is the tool's own default account.
 */
export function accountName(main: Proc | undefined, c: Config): string | null {
  if (!main || main.envAvailable === false) return null;
  const dir = firstEnv(main, c.accountEnv);
  return dir ? basename(dir) : "default";
}
/**
 * tmux exports the pane address into every pane. A shell that knows the
 * window title exports it under the configured name; neither is required.
 */
export function paneName(main: Proc | undefined, c: Config): string {
  return firstEnv(main, c.paneEnv) ?? "";
}
export function windowTitle(main: Proc | undefined, c: Config): string {
  return firstEnv(main, c.titleEnv) ?? "";
}
/** Make writes the job count and the jobserver into MAKEFLAGS. */
export function jobserver(main: Proc | undefined): {
  jobs: number | null;
  jobserver: string | null;
} {
  const flags = firstEnv(main, ["MAKEFLAGS"]) ?? "";
  const jobs = flags.match(/(?:^|\s)-j\s*(\d+)/);
  const auth = flags.match(/--jobserver-(?:auth|fds)=(\S+)/);
  return {
    jobs: jobs ? Number(jobs[1]) : null,
    jobserver: auth ? auth[1] : null,
  };
}
/**
 * Config chooses which parts name a lane and in which order. Parts with no
 * value are left out, so a lane never carries an empty separator.
 */
export function laneName(
  parts: Record<string, string | null>,
  order: string[],
): string {
  return order
    .map((part) => parts[part])
    .filter((value): value is string => Boolean(value))
    .join(" ");
}
