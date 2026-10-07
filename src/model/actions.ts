import { join } from "node:path";
import type { Config } from "../config/config";
import { shellLine, shellWord } from "./shell";
import type { Lane, Proc, Snapshot } from "./types";

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
 * number of samples, and `resolveIntent` is the only function this module
 * exports that returns a `LaneCommand`, always from the snapshot it is handed.
 */
export interface LaneIntent {
  action: LaneAction;
  /** The lane the reader saw. Re-resolution finds it again by this. */
  laneId: string;
  /**
   * The process leading that lane. A later process can hold the same scope
   * name and reuse the process ID, so its start time identifies the instance.
   */
  mainPid: number;
  mainStart: number;
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
  mainStart: number;
  scope: string;
  directory: string;
  /** The actions this lane offers, in menu order. */
  actions: readonly LaneAction[];
}
/**
 * The scope an action would address, or null when the lane has no readable
 * leading process or addressable scope. `systemctl --user`
 * names units, so only a `.scope` leaf can be signalled, and a cgroup traced
 * through /proc alone is an absolute kernel path that does not resolve
 * against the configured root, so joining it would name a different group
 * than the lane. A lane failing either gets no actions rather than a
 * command aimed at the wrong cgroup.
 *
 * Stop names the scope to the user manager by its bare name, which is only
 * this lane's unit when systemd created the scope: every directory between the
 * root and the scope is a slice. Any other directory on the way, such as a
 * container's `libpod-<id>.scope` or a nested `user@0.service`, belongs to a
 * unit whose subtree a different systemd manages, and there the bare name can
 * name a different unit. Such a scope keeps Freeze and Thaw, which address its
 * directory, and gets no Stop.
 */
export function laneTarget(
  lane: Lane,
  c: Config,
  procs: readonly Proc[],
): LaneTarget | null {
  const parts = lane.cgroup.split("/").filter(Boolean);
  const scope = parts.at(-1);
  if (lane.cgroup.startsWith("/") || parts.includes("..")) return null;
  if (scope === undefined || !scope.endsWith(".scope")) return null;
  const main = procs.find((p) => p.pid === lane.mainPid);
  if (main === undefined) return null;
  const unit = parts.slice(0, -1).every((part) => part.endsWith(".slice"));
  return {
    laneId: lane.id,
    mainPid: lane.mainPid,
    mainStart: main.start,
    scope,
    directory: join(c.cgroupRoot, ...parts),
    actions: laneActions.filter((action) => unit || action !== "Stop"),
  };
}
/**
 * The exact command an action would run: the one spelling behind the line a
 * screen shows, the text a reader copies and the effect that reaches the
 * system. It takes a resolved target rather than a lane, so a lane with no
 * addressable scope cannot reach a command at all, and it stays inside this
 * module, so no caller can build an effect without a snapshot to justify it.
 */
function laneCommand(
  action: LaneAction,
  { laneId, mainPid, mainStart, scope, directory }: LaneTarget,
): LaneCommand {
  const of = { action, laneId, mainPid, mainStart, scope };
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
  const target = laneTarget(lane, c, s.procs);
  if (target === null || !target.actions.includes(intent.action))
    return { state: "unaddressable" };
  if (target.mainStart !== intent.mainStart) return { state: "replaced" };
  const command = laneCommand(intent.action, target);
  return command.text === intent.text
    ? { state: "ready", command }
    : { state: "changed" };
}
