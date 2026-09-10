import { join } from "node:path";
import type { Config } from "../config/config";
import type { Lane } from "./types";

/** What a reader can ask vsys to do to one lane, in menu order. */
export const laneActions = ["Freeze", "Thaw", "Stop"] as const;
export type LaneAction = (typeof laneActions)[number];

/**
 * What an action does to the system. A freeze sets a cgroup attribute, so the
 * lane's tasks stop without losing their state; a stop asks systemd to signal
 * the scope, so the unit's own teardown still runs.
 */
export type LaneEffect =
  | { kind: "cgroup"; path: string; value: string }
  | { kind: "run"; argv: string[] };

/** One action resolved against one lane. */
export interface LaneCommand {
  action: LaneAction;
  /** The systemd scope the confirmation names before anything runs. */
  scope: string;
  /** The same work as a line a reader can paste into a shell. */
  text: string;
  effect: LaneEffect;
}
/** A lane's own cgroup directory and the systemd scope that owns it. */
export interface LaneTarget {
  scope: string;
  directory: string;
}
/**
 * The scope an action would address, or null when the lane has none. Two
 * conditions have to hold, and neither is a formality: `systemctl --user`
 * names units, so only a `.scope` leaf can be signalled, and a cgroup traced
 * through /proc alone is an absolute kernel path that does not resolve
 * against the configured root, so joining it would name a different group
 * than the lane. A lane failing either gets no actions rather than a
 * command aimed at the wrong cgroup.
 */
export function laneTarget(lane: Lane, c: Config): LaneTarget | null {
  const parts = lane.cgroup.split("/").filter(Boolean);
  const scope = parts.at(-1);
  if (lane.cgroup.startsWith("/") || parts.includes("..")) return null;
  if (scope === undefined || !scope.endsWith(".scope")) return null;
  return { scope, directory: join(c.cgroupRoot, ...parts) };
}
/**
 * The exact command an action would run, so a caller can show it, copy it or
 * run it without a second spelling of any of the three. It takes a resolved
 * target rather than a lane, so a lane with no addressable scope cannot reach
 * a command at all.
 */
export function laneCommand(
  action: LaneAction,
  { scope, directory }: LaneTarget,
): LaneCommand {
  if (action === "Stop") {
    const argv = ["systemctl", "--user", "kill", "--signal=TERM", scope];
    return {
      action,
      scope,
      text: argv.join(" "),
      effect: { kind: "run", argv },
    };
  }
  const path = join(directory, "cgroup.freeze");
  const value = action === "Freeze" ? "1" : "0";
  return {
    action,
    scope,
    text: `echo ${value} > ${path}`,
    effect: { kind: "cgroup", path, value },
  };
}
