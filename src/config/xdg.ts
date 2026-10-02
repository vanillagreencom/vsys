import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Each XDG base directory's default, under the home directory. */
const fallbacks = {
  XDG_CONFIG_HOME: ".config",
  XDG_DATA_HOME: ".local/share",
  XDG_STATE_HOME: ".local/state",
} as const;

/**
 * An XDG base directory: the variable when it holds an absolute path,
 * otherwise its default under the home directory. The base directory
 * specification has an empty or relative value ignored, and systemd's own
 * lookup does the same, so a unit directory vsys reads is the one systemd
 * reads.
 */
export function xdgHome(
  name: keyof typeof fallbacks,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];
  return value && isAbsolute(value) ? value : join(homedir(), fallbacks[name]);
}

/**
 * Where a vsys file or directory lives under an XDG base directory. A path
 * that exists only under the home default, while the variable points
 * elsewhere, belongs to an install that kept its settings and history there,
 * so it stays in use until the reader moves it: answering with the empty new
 * location would reset every setting and orphan the history without a word.
 * A path that cannot be checked for any reason but absence stops the caller.
 */
export function xdgPath(
  name: keyof typeof fallbacks,
  relative: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const chosen = join(xdgHome(name, env), relative);
  const home = join(homedir(), fallbacks[name], relative);
  return chosen === home || present(chosen) || !present(home) ? chosen : home;
}

function present(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false }) !== undefined;
}
