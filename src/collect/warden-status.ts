import { isAbsolute, join } from "node:path";
import type { Leftovers, LeftoversState } from "../model/types";
import type { Reader } from "./io";

/**
 * Where the warden writes its status, null where the session names no runtime
 * directory: with none, there is no warden status vsys could share.
 */
export function wardenStatusPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime && isAbsolute(runtime)
    ? join(runtime, "agent-warden/status.json")
    : null;
}
/**
 * A status older or newer than this is from a warden that stopped: three
 * missed ticks at its default 30 s interval, the bound the desktop widget
 * reading the same file uses.
 */
export const staleAfterMs = 90_000;
const unknown = (state: LeftoversState, time: number | null): Leftovers => ({
  state,
  time,
  testWorlds: null,
  failedUnits: null,
  testProcesses: null,
});
const count = (value: unknown): number | null =>
  typeof value === "number" ? value : null;
/** The fields vsys reads; JSON gives no promise any of them is there. */
type StatusDoc = {
  schema?: unknown;
  time?: unknown;
  leftovers?: {
    testWorlds?: unknown;
    failedUnits?: unknown;
    testProcesses?: unknown;
  } | null;
} | null;
/**
 * The leftover counts from the warden's `status.json`, under the contract in
 * `docs/architecture/warden.md`. No file is an absent warden, with no source
 * error; a file that cannot be read or parsed, or a schema major vsys does not
 * know, is a source error. Every count is unknown unless it was read from a
 * fresh status, never zero.
 */
export function readLeftovers(
  r: Reader,
  path: string | null,
  now: number,
): Leftovers {
  if (path === null) return unknown("absent", null);
  const errors = r.errors.length;
  const text = r.text(path, true);
  if (text === null)
    return unknown(r.errors.length > errors ? "failed" : "absent", null);
  let doc: StatusDoc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    r.error(path, error);
    return unknown("failed", null);
  }
  // A new major can change what any field means.
  const schema = doc?.schema;
  if (typeof schema !== "string" || !/^1\.\d+$/.test(schema)) {
    r.error(path, `Unknown warden status schema ${String(schema)}`);
    return unknown("failed", null);
  }
  const seconds = doc?.time;
  if (typeof seconds !== "number") {
    r.error(path, "The warden status carries no time");
    return unknown("failed", null);
  }
  const time = seconds * 1000;
  if (Math.abs(now - time) > staleAfterMs) return unknown("stale", time);
  // The warden writes null for the whole object when its tick failed.
  const counts = doc?.leftovers;
  return {
    state: "read",
    time,
    testWorlds: count(counts?.testWorlds),
    failedUnits: count(counts?.failedUnits),
    testProcesses: count(counts?.testProcesses),
  };
}
