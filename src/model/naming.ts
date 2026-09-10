import { basename } from "node:path";
import type { CollectionConfig } from "../collect/settings";
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
 * directory basename names the lane. A process that names no configuration
 * directory has no account vsys can read, and a constant word in its place
 * would widen every lane name without telling the lanes apart.
 */
export function accountName(
  main: Proc | undefined,
  c: CollectionConfig,
): string | null {
  const dir = firstEnv(main, c.accountEnv);
  return dir ? basename(dir) : null;
}
/**
 * tmux exports the pane address into every pane. A shell that knows the
 * window title exports it under the configured name; neither is required.
 */
export function paneName(main: Proc | undefined, c: CollectionConfig): string {
  return firstEnv(main, c.paneEnv) ?? "";
}
export function windowTitle(
  main: Proc | undefined,
  c: CollectionConfig,
): string {
  return firstEnv(main, c.titleEnv) ?? "";
}
/** Make writes the job count and the token pool into the configured variable. */
export function jobserver(
  main: Proc | undefined,
  envNames: string[],
): {
  jobs: number | null;
  jobserver: string | null;
} {
  const flags = firstEnv(main, envNames) ?? "";
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
/**
 * tmux exports its own pane address, `%9`, which names nothing to a reader.
 * Any other value a pane exports was chosen by a person and is left alone.
 */
export function paneLabel(pane: string): string {
  const address = pane.match(/^%(\d+)$/);
  return address ? `pane ${address[1]}` : pane;
}
/**
 * systemd escapes a byte it cannot carry in a unit name as `\xNN`. Only the
 * escapes are decoded here: the caller has already split the name on systemd's
 * own separator, so a decoded hyphen cannot be mistaken for one.
 */
function unescapeUnit(field: string): string {
  return field.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}
/** The suffix systemd adds to keep a generated unit name unique. */
const generated = (field: string): boolean =>
  /^\d+$/.test(field) || /^[0-9a-f]{6,}$/.test(field);
/**
 * A unit name as a reader reads it. systemd builds a scope name from the
 * launcher, the program and a value that makes the name unique, joined with
 * hyphens, with every hyphen inside a field escaped. None of that machinery is
 * a name:
 *
 * - `app-Hyprland-chromium\x2dpersonal-af7ff2b7.scope` is the documented
 *   desktop form `app-LAUNCHER-NAME-UNIQUE`, so the launcher goes and the one
 *   escaped hyphen separates the program from its profile: `chromium (personal)`.
 * - `agent-confine-854045-20986.scope` follows no convention, so the outer
 *   field stays as context and the inner one names it: `agent 854045`.
 * - `tmux.service` carries no machinery and is already a name.
 *
 * A name whose fields were not generated keeps every field, because nothing
 * marks which of them the reader can spare.
 */
export function unitLabel(name: string): string {
  const bare = name.replace(/\.(scope|service|slice|mount|socket|target)$/, "");
  const fields = bare.split("-");
  const desktop = fields[0] === "app";
  if (desktop) fields.shift();
  const trimmed = fields.length > 1 && generated(fields[fields.length - 1]);
  if (trimmed) fields.pop();
  if (!fields.length) return bare;
  // The desktop form names the launcher before the program; anything else has
  // no such contract, so its outer field is kept as the context it gives.
  const kept = desktop
    ? [fields[fields.length - 1]]
    : trimmed && fields.length > 2
      ? [fields[0], fields[fields.length - 1]]
      : fields;
  const words = kept.map(unescapeUnit);
  const [only] = words;
  if (words.length === 1 && only.split("-").length === 2) {
    const [program, instance] = only.split("-");
    return `${program} (${instance})`;
  }
  return words.join(" ");
}
