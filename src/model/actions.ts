import { join } from "node:path";
import type { Config } from "../config/config";
import { shellLine, shellWord } from "./shell";
import type { Lane, Snapshot } from "./types";

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

/**
 * What a reader asks for and confirms: one action against the lane they were
 * looking at, and the line the confirmation showed them. It carries no effect,
 * so nothing a screen holds can be run. A dialog can stand open across any
 * number of samples, and the effect exists only on a `LaneCommand`, which only
 * `resolveIntent` returns and only from the snapshot of the moment.
 */
export interface LaneIntent {
  action: LaneAction;
  /** The lane the reader saw. Re-resolution finds it again by this. */
  laneId: string;
  /**
   * The process leading that lane. A scope name embeds the process id that
   * opened it, so a later process can hold the same name; the lane is the same
   * lane only while this process still leads it.
   */
  mainPid: number;
  /** The systemd scope the confirmation names before anything runs. */
  scope: string;
  /** The same work as a line a reader can paste into a shell. */
  text: string;
}
/** An intent resolved against a snapshot, with the effect it may run. */
export interface LaneCommand extends LaneIntent {
  effect: LaneEffect;
}
/** A lane, and the cgroup directory and systemd scope an action addresses. */
export interface LaneTarget {
  laneId: string;
  mainPid: number;
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
  return {
    laneId: lane.id,
    mainPid: lane.mainPid,
    scope,
    directory: join(c.cgroupRoot, ...parts),
  };
}
/**
 * The exact command an action would run, so a caller can show it, copy it or
 * run it without a second spelling of any of the three. It takes a resolved
 * target rather than a lane, so a lane with no addressable scope cannot reach
 * a command at all.
 */
export function laneCommand(
  action: LaneAction,
  { laneId, mainPid, scope, directory }: LaneTarget,
): LaneCommand {
  const of = { action, laneId, mainPid, scope };
  if (action === "Stop") {
    const argv = ["systemctl", "--user", "kill", "--signal=TERM", scope];
    return { ...of, text: shellLine(argv), effect: { kind: "run", argv } };
  }
  const path = join(directory, "cgroup.freeze");
  const value = action === "Freeze" ? "1" : "0";
  return {
    ...of,
    text: `${shellLine(["echo", value])} > ${shellWord(path)}`,
    effect: { kind: "cgroup", path, value },
  };
}
/**
 * The same action as the reader's half alone. A screen builds its rows through
 * this, so no effect is kept anywhere a later keypress could reach one.
 */
export function laneIntent(action: LaneAction, target: LaneTarget): LaneIntent {
  const { effect, ...intent } = laneCommand(action, target);
  return intent;
}
/**
 * What an intent names in the snapshot handed to it. The reader confirmed one
 * line against one running process, and a confirmation can stand open across
 * samples, so every way that stops being true is its own answer rather than a
 * silent substitution.
 */
export type LaneResolution =
  | { state: "ready"; command: LaneCommand }
  | { state: "ended" | "replaced" | "unaddressable" | "changed" };
/**
 * The command an intent names right now. It is the only way to reach an
 * effect: what the reader confirmed is re-derived from the current snapshot
 * and run only when it is the same line, so a lane that ended, one whose scope
 * a later process took, and one that moved to another cgroup each refuse
 * instead of sending the confirmed work somewhere else.
 */
export function resolveIntent(
  intent: LaneIntent,
  s: Snapshot,
  c: Config,
): LaneResolution {
  const lane = s.lanes.find((l) => l.id === intent.laneId);
  if (lane === undefined) return { state: "ended" };
  if (lane.mainPid !== intent.mainPid) return { state: "replaced" };
  const target = laneTarget(lane, c);
  if (target === null) return { state: "unaddressable" };
  const command = laneCommand(intent.action, target);
  return command.text === intent.text
    ? { state: "ready", command }
    : { state: "changed" };
}
