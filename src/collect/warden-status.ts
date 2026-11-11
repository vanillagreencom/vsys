import { join } from "node:path";
import { xdgHome } from "../config/xdg";
import type {
  Leftovers,
  LeftoversState,
  WardenNearLimit,
} from "../model/types";
import type { Reader } from "./io";

/**
 * Where the warden writes its status: under the session's runtime directory,
 * or `/run/user/UID` where the session names none, the directory the warden
 * itself falls back to. A cron job or a `sudo -u` shell often has no
 * `XDG_RUNTIME_DIR` while the warden's user unit writes there all the same.
 */
export const wardenStatusPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => join(xdgHome("XDG_RUNTIME_DIR", env), "agent-warden/status.json");
/**
 * A status older or newer than this is from a warden that stopped: three
 * missed ticks at its default 30 s interval, the bound the desktop widget
 * reading the same file uses.
 */
export const staleAfterMs = 90_000;
/**
 * The kernel cgroup path of the slice the warden reports in `status.json`:
 * `CG_ROOT / SLICE` in `warden/agent-warden`, under the manager of the user
 * whose runtime directory holds the status.
 */
const wardenSlicePath = (): string => {
  const uid = process.getuid?.() ?? 1000;
  return `/user.slice/user-${uid}.slice/user@${uid}.service/agents.slice`;
};
const nearLimitKey = "near-limit:";
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
  lanes?: unknown;
  items?: unknown;
  leftovers?: {
    testWorlds?: unknown;
    failedUnits?: unknown;
    testProcesses?: unknown;
  } | null;
} | null;
/** What vsys takes from one read of the warden's status. */
export interface WardenStatus {
  leftovers: Leftovers;
  /**
   * The warden's own per-scope `near-limit` warnings, each with the limits
   * its lane lists as near. Null unless the status was fresh.
   */
  nearLimits: WardenNearLimit[] | null;
}
/**
 * The warden's `status.json`, under the contract in
 * `docs/architecture/warden.md`. No file is an absent warden, with no source
 * error; a file that cannot be read or parsed, or a schema major vsys does not
 * know, is a source error. Every count is unknown unless it was read from a
 * fresh status, never zero, and so is every warning the warden gave.
 */
export function readWardenStatus(
  r: Reader,
  path: string,
  now: number,
): WardenStatus {
  const unread = (state: LeftoversState, time: number | null) => ({
    leftovers: unknown(state, time),
    nearLimits: null,
  });
  const errors = r.errors.length;
  const text = r.text(path, true);
  if (text === null)
    return unread(r.errors.length > errors ? "failed" : "absent", null);
  let doc: StatusDoc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    r.error(path, error);
    return unread("failed", null);
  }
  // A new major can change what any field means.
  const schema = doc?.schema;
  if (typeof schema !== "string" || !/^1\.\d+$/.test(schema)) {
    r.error(path, `Unknown warden status schema ${String(schema)}`);
    return unread("failed", null);
  }
  const seconds = doc?.time;
  if (typeof seconds !== "number") {
    r.error(path, "The warden status carries no time");
    return unread("failed", null);
  }
  const time = seconds * 1000;
  if (Math.abs(now - time) > staleAfterMs) return unread("stale", time);
  // The warden writes null for the whole object when its tick failed.
  const counts = doc?.leftovers;
  // A status before schema 1.3 has no items, so it gave no warning, and the
  // warden writes null lanes where it could not list them.
  const items = Array.isArray(doc?.items) ? doc.items : [];
  const lanes = Array.isArray(doc?.lanes) ? doc.lanes : [];
  const slice = wardenSlicePath();
  return {
    leftovers: {
      state: "read",
      time,
      testWorlds: count(counts?.testWorlds),
      failedUnits: count(counts?.failedUnits),
      testProcesses: count(counts?.testProcesses),
    },
    // An item's key is `kind:SCOPE` under the 1.3 contract; vsys reads which
    // limits the warning names from the lane, not from the item's text.
    nearLimits: items.flatMap((item: { key?: unknown } | null) => {
      const key = item?.key;
      if (typeof key !== "string" || !key.startsWith(nearLimitKey)) return [];
      const scope = key.slice(nearLimitKey.length);
      const lane = lanes.find(
        (row: { scope?: unknown } | null) => row?.scope === scope,
      );
      const near: unknown[] = Array.isArray(lane?.near) ? lane.near : [];
      return [
        {
          kernelPath: `${slice}/${scope}`,
          near: near.filter((kind): kind is string => typeof kind === "string"),
        },
      ];
    }),
  };
}
