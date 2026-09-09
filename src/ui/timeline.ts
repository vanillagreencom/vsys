import type { Config } from "../config/config";
import type { CauseId } from "../model/verdict";
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
    return `${amount(v.largest, c)} against a quota of ${amount(v.quota, c)}`;
  return "";
}
const parts = (...values: string[]) => values.filter(Boolean).join(" | ");
/** One line per event: when, what changed, and why. */
export function eventLine(e: TimelineEvent, c: Config): string {
  const at = new Date(e.time).toLocaleTimeString();
  const n = e.names;
  const where = `account ${n.account || gap} in ${n.slice || "no slice"}`;
  if (e.kind === "lane-start")
    return parts(
      `${at} Lane started: ${e.subject}`,
      where,
      `${n.tool || "no agent tool"} entered a watched scope`,
    );
  if (e.kind === "lane-stop")
    return parts(
      `${at} Lane stopped: ${e.subject}`,
      where,
      `its processes left after ${age(e.values.age ?? 0)}`,
    );
  if (e.kind === "cgroup-move") {
    // The slice is worth a clause only when the move actually changed it.
    const moved =
      n.fromSlice === n.toSlice
        ? `it stayed in ${n.toSlice || "no slice"}`
        : `it left ${n.fromSlice || "no slice"} for ${n.toSlice || "no slice"}`;
    return parts(
      `${at} Moved cgroup: ${e.subject}`,
      `${n.from || "no cgroup"} to ${n.to || "no cgroup"}`,
      e.cause ? causePhrase(e.cause) : moved,
    );
  }
  if (e.kind === "alert-open")
    return parts(
      `${at} Alert opened: ${causePhrase(e.cause)}`,
      e.subject,
      measurement(e, c),
    );
  if (e.kind === "alert-close")
    return parts(
      `${at} Alert closed: ${causePhrase(e.cause)}`,
      e.subject,
      `open for ${age((e.values.durationMs ?? 0) / 1000)}`,
    );
  return parts(
    `${at} Verdict: ${causePhrase(e.cause)}`,
    e.subject,
    `previously ${causePhrase((n.previous as CauseId | "") ?? "")}`,
  );
}
