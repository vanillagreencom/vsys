import type { Config } from "../config/config";
import { inSlice } from "../model/lanes";
import type { Snapshot } from "../model/types";
import { type CauseId, causes } from "../model/verdict";

export type EventKind =
  | "lane-start"
  | "lane-stop"
  | "cgroup-move"
  | "alert-open"
  | "alert-close"
  | "verdict";
/** One change between two samples. Every word and every unit belongs to the UI. */
export interface TimelineEvent {
  time: number;
  kind: EventKind;
  /** The lane, process or consumer the change is about. */
  subject: string;
  /** The cause behind the change, empty when the ladder holds none. */
  cause: CauseId | "";
  /** Identifiers the line needs: account, slice, tool, from, to, level. */
  names: Record<string, string>;
  /** The numbers behind the change, unformatted. */
  values: Record<string, number | null>;
}
/** The slice a cgroup path sits in, which is what a lane event must name. */
export function sliceOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const above = parts.slice(0, -1);
  return (
    above.findLast((part) => part.endsWith(".slice")) ?? above.at(-1) ?? ""
  );
}
/**
 * Events come from successive snapshots and from the one cause ladder. An
 * alert is a cause on that ladder, so desktop swap crossing its floor is the
 * desktop-swap cause opening and closing, never a second detection path.
 */
export class EventLog {
  private previous: Snapshot | null = null;
  private open = new Map<CauseId, { time: number; consumer: string }>();
  private verdict: CauseId | "" = "";
  /** The first sample records the state it observes and reports no change. */
  advance(s: Snapshot, c: Config): TimelineEvent[] {
    const out: TimelineEvent[] = [];
    const previous = this.previous;
    const add = (
      kind: EventKind,
      subject: string,
      rest: Partial<TimelineEvent> = {},
    ) => {
      if (previous)
        out.push({
          time: s.time,
          kind,
          subject,
          cause: "",
          names: {},
          values: {},
          ...rest,
        });
    };
    for (const lane of s.lanes)
      if (previous && !previous.lanes.some((old) => old.id === lane.id))
        add("lane-start", lane.name, {
          // An unreadable account stays empty; the UI says it is unavailable.
          names: {
            account: lane.account ?? "",
            slice: sliceOf(lane.cgroup),
            tool: lane.tool,
          },
          values: { pid: lane.mainPid },
        });
    for (const lane of previous?.lanes ?? [])
      if (!s.lanes.some((live) => live.id === lane.id))
        add("lane-stop", lane.name, {
          names: { account: lane.account ?? "", slice: sliceOf(lane.cgroup) },
          values: { age: lane.age },
        });
    // Process identity is the PID with its start time, so a reused PID is a
    // different process rather than a move.
    const before = new Map(
      (previous?.procs ?? []).map((p) => [`${p.pid}:${p.start}`, p]),
    );
    for (const p of s.procs) {
      const was = before.get(`${p.pid}:${p.start}`);
      if (!was || was.group === p.group) continue;
      add("cgroup-move", `${p.comm} PID ${p.pid}`, {
        names: {
          from: sliceOf(was.group),
          to: sliceOf(p.group),
          tool: p.tool ?? "",
        },
        cause: p.tool && !inSlice(p.group, c.agentSlice) ? "unconfined" : "",
        values: { pid: p.pid },
      });
    }
    const ladder = causes(s, c);
    const live = new Set(ladder.map((cause) => cause.id));
    for (const cause of ladder) {
      if (this.open.has(cause.id)) continue;
      this.open.set(cause.id, { time: s.time, consumer: cause.consumer });
      add("alert-open", cause.consumer, {
        cause: cause.id,
        names: { level: cause.level },
        values: { ...cause.values },
      });
    }
    for (const [id, opened] of this.open) {
      if (live.has(id)) continue;
      this.open.delete(id);
      add("alert-close", opened.consumer, {
        cause: id,
        values: { durationMs: s.time - opened.time },
      });
    }
    const lead = ladder.find((cause) => cause.verdictWorthy);
    const verdict = lead?.id ?? "";
    if (verdict !== this.verdict)
      add("verdict", lead?.consumer ?? "", {
        cause: verdict,
        names: { previous: this.verdict, level: lead?.level ?? "ok" },
        values: lead ? { ...lead.values } : {},
      });
    this.verdict = verdict;
    this.previous = s;
    return out;
  }
}
