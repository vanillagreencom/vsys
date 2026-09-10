import type { Config } from "../config/config";
import type { CauseId, Level } from "../model/verdict";
import type { TimelineEvent } from "../store/events";
import { age, amount, gap, share } from "./format";

/** One short clause per cause, so an event states why without a second line. */
const phrases: Record<CauseId, string> = {
  unconfined: "an agent ran outside the agent slice",
  "read-only": "a mount turned read-only",
  "device-errors": "device error counters grew",
  disk: "storage stalled tasks",
  "desktop-swap": "the desktop swapped out",
  "free-space": "a filesystem passed its free space floor",
  "memory-cap": "a memory limit sits below the floor",
  stalls: "lanes stalled on a resource",
  "system-memory": "memory reclaim stalled tasks",
  "system-cpu": "tasks waited for CPU",
  "memory-high": "a group neared its memory threshold",
  scrub: "a scrub reported a problem",
  scratch: "scratch data passed its quota",
};
export function causePhrase(cause: CauseId | ""): string {
  return cause ? phrases[cause] : "nothing needs attention";
}
/**
 * The number that made the cause fire, for the causes that measure one. Every
 * threshold comes from the event, so a later settings change cannot restate
 * what an older line crossed.
 */
function measurement(e: TimelineEvent, c: Config): string {
  const v = e.values;
  if (e.cause === "desktop-swap")
    return `${amount(v.swap, c)} swapped against a floor of ${amount(v.floor, c)}`;
  if (e.cause === "free-space")
    return `${amount(v.free, c)} free of ${amount(v.total, c)}`;
  if (e.cause === "disk") return `${share(v.some)} of the window stalled`;
  if (e.cause === "stalls") return `${share(v.worst)} at worst`;
  if (e.cause === "scratch")
    return `${amount(v.bytes, c)} against a quota of ${amount(v.quota, c)}`;
  return "";
}
const parts = (...values: string[]) => values.filter(Boolean).join(" | ");
/** How bad a level is, in words a reader does not have to decode. */
function levelWord(level: string | undefined): string {
  return level === "danger"
    ? "serious"
    : level === "warn"
      ? "a warning"
      : "clear";
}
/** An event in parts, so a row can colour the kind and dim the time. */
export interface EventParts {
  time: string;
  /** What happened, in two or three words. */
  kind: string;
  /** The subject and the reason, joined for one row. */
  text: string;
  level: Level;
}
/**
 * What tells one change from another. Two alerts can open for one subject in
 * one sample under different causes, so the cause is part of the identity:
 * without it React sees two siblings with one key and is free to reuse or drop
 * the wrong row. Both screens that list changes read this, so their keys
 * cannot drift apart.
 */
export const eventKey = (e: TimelineEvent): string =>
  `${e.time}-${e.kind}-${e.cause}-${e.subjectId}`;
export function eventParts(e: TimelineEvent, c: Config): EventParts {
  const time = new Date(e.time).toLocaleTimeString();
  const n = e.names;
  const where = `account ${n.account || gap} in ${n.slice || "no slice"}`;
  if (e.kind === "lane-start")
    return {
      time,
      kind: "Lane started",
      text: parts(
        e.subject,
        where,
        `${n.tool || "no agent tool"} entered a watched scope`,
      ),
      level: "ok",
    };
  if (e.kind === "lane-stop")
    return {
      time,
      kind: "Lane stopped",
      text: parts(
        e.subject,
        where,
        `its processes left after ${age(e.values.age ?? 0)}`,
      ),
      level: "ok",
    };
  if (e.kind === "cgroup-move") {
    // The slice is worth a clause only when the move actually changed it.
    const moved =
      n.fromSlice === n.toSlice
        ? `it stayed in ${n.toSlice || "no slice"}`
        : `it left ${n.fromSlice || "no slice"} for ${n.toSlice || "no slice"}`;
    return {
      time,
      kind: "Moved cgroup",
      text: parts(
        e.subject,
        `${n.from || "no cgroup"} to ${n.to || "no cgroup"}`,
        e.cause ? causePhrase(e.cause) : moved,
      ),
      level: e.cause ? "warn" : "ok",
    };
  }
  if (e.kind === "alert-open")
    return {
      time,
      kind: "Alert opened",
      text: parts(causePhrase(e.cause), e.subject, measurement(e, c)),
      level: n.level === "danger" ? "danger" : "warn",
    };
  if (e.kind === "alert-close")
    return {
      time,
      kind: "Alert closed",
      text: parts(
        causePhrase(e.cause),
        e.subject,
        `open for ${age((e.values.durationMs ?? 0) / 1000)}`,
      ),
      level: "ok",
    };
  // One cause can lead twice: a warning that turns serious is a new verdict.
  const previous = (n.previous as CauseId | "") ?? "";
  return {
    time,
    kind: "Verdict",
    text: parts(
      causePhrase(e.cause),
      e.subject,
      e.cause && previous === e.cause
        ? `now ${levelWord(n.level)}, was ${levelWord(n.previousLevel)}`
        : `previously ${causePhrase(previous)}`,
    ),
    level: n.level === "danger" ? "danger" : n.level === "warn" ? "warn" : "ok",
  };
}
/** One line per event: when, what changed, and why. */
export function eventLine(e: TimelineEvent, c: Config): string {
  const { time, kind, text } = eventParts(e, c);
  return `${time} ${kind}: ${text}`;
}
