import type { Config } from "../config/config";
import type { CauseId } from "../model/verdict";
import type { TimelineEvent } from "../store/events";
import { age, bytes, gap, percent } from "./format";

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
/** The number that made the cause fire, for the causes that measure one. */
function measurement(e: TimelineEvent, c: Config): string {
  const v = e.values;
  if (e.cause === "desktop-swap")
    return `${bytes(v.swap, c)} swapped against a floor of ${bytes(c.swapFloor, c)}`;
  if (e.cause === "free-space")
    return `${bytes(v.free, c)} free of ${bytes(v.total, c)}`;
  if (e.cause === "disk") return `${percent(v.some)} of the window stalled`;
  if (e.cause === "stalls") return `${percent(v.worst)} at worst`;
  if (e.cause === "scratch") return `${bytes(v.largest, c)} largest`;
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
  if (e.kind === "cgroup-move")
    return parts(
      `${at} Moved cgroup: ${e.subject}`,
      `${n.from || "no slice"} to ${n.to || "no slice"}`,
      e.cause ? causePhrase(e.cause) : "the process changed slice",
    );
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
