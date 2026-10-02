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
