import type { Config } from "../config/config";
import { escaped, lanePressure } from "../model/lanes";
import type { Snapshot } from "../model/types";
import {
  type Cause,
  type CauseId,
  causeRank,
  causes,
  consumerName,
  type Level,
} from "../model/verdict";

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
  /** Its stable identity, since two lanes can carry one display name. */
  subjectId: string;
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
/** A cause on one subject, waiting to open, open, or waiting to close. */
interface Watch {
  cause: CauseId;
  subject: string;
  subjectId: string;
  /** The systemd unit the subject name decoded from, empty when it is not one. */
  unit: string;
  level: Level;
  verdictWorthy: boolean;
  values: Record<string, number | null>;
  firstSeen: number;
  lastSeen: number;
  opened: boolean;
}
/** Severity leads the verdict, exactly as it leads the ladder. */
const severity: Record<Level, number> = { danger: 2, warn: 1, ok: 0 };
/**
 * The numbers this one subject contributed. A cause reports its worst or its
 * largest across every subject it groups, which is not what one alert about
 * one subject may claim.
 */
function subjectValues(
  cause: Cause,
  id: string,
  s: Snapshot,
  c: Config,
): Record<string, number | null> {
  if (cause.id === "desktop-swap")
    return { ...cause.values, floor: c.swapFloor };
  if (cause.id === "scratch")
    return {
      ...cause.values,
      bytes: s.storage.scratch.find((x) => x.path === id)?.bytes ?? null,
    };
  if (cause.id === "stalls") {
    const lane = cause.lanes.find((l) => l.id === id);
    return { ...cause.values, worst: lane ? lanePressure(lane) : null };
  }
  return { ...cause.values };
}
/**
 * A cause groups every subject it affects. Each of them is its own alert with
 * its own duration, so two escaped lanes are two alerts rather than one.
 */
export function subjects(
  cause: Cause,
  s: Snapshot,
): { id: string; name: string; unit?: string }[] {
  const named = [
    ...cause.lanes.map((lane) => ({ id: lane.id, name: lane.name })),
    // A cgroup's own name is systemd's, not a reader's. `consumerName` is the
    // one place that turns one into a name, so an event says what a card says.
    ...cause.groups.map((group) => ({
      id: group.path,
      name: consumerName(group, s),
      unit: group.name,
    })),
    ...cause.paths.map((path) => ({ id: path, name: path })),
  ];
  return named.length ? named : [{ id: cause.consumer, name: cause.consumer }];
}
/**
 * Events come from successive snapshots and from the one cause ladder. An
 * alert is a cause on that ladder, so desktop swap crossing its floor is the
 * desktop-swap cause opening and closing, never a second detection path.
 *
 * A cause must hold for pressureHoldSeconds before it opens, and must stay
 * away that long before it closes, so a value flapping across a threshold
 * records one alert rather than one per sample. The recorded duration is the
 * time the cause was observed, which excludes the wait before the close.
 */
export class EventLog {
  private previous: Snapshot | null = null;
  private watching = new Map<string, Watch>();
  private verdict: CauseId | "" = "";
  private verdictLevel: Level = "ok";
  /** The first sample records the state it observes and reports no change. */
  advance(s: Snapshot, c: Config): TimelineEvent[] {
    const out: TimelineEvent[] = [];
    const previous = this.previous;
    // The first sample has nothing to compare against, so it records nothing.
    const add = (
      kind: EventKind,
      subject: string,
      rest: Partial<TimelineEvent> = {},
    ): boolean => {
      if (!previous) return false;
      out.push({
        time: s.time,
        kind,
        subject,
        subjectId: subject,
        cause: "",
        names: {},
        values: {},
        ...rest,
      });
      return true;
    };
    for (const lane of s.lanes)
      if (previous && !previous.lanes.some((old) => old.id === lane.id))
        add("lane-start", lane.name, {
          subjectId: lane.id,
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
          subjectId: lane.id,
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
        subjectId: `${p.pid}:${p.start}`,
        names: {
          from: was.group,
          to: p.group,
          fromSlice: sliceOf(was.group),
          toSlice: sliceOf(p.group),
          tool: p.tool ?? "",
        },
        // Confinement changed only when the move left the agent slice.
        cause: escaped(p, c) && !escaped(was, c) ? "unconfined" : "",
        values: { pid: p.pid },
      });
    }
    const hold = c.pressureHoldSeconds * 1000;
    const ladder = causes(s, c);
    const live = new Set<string>();
    for (const cause of ladder) {
      for (const subject of subjects(cause, s)) {
        const key = `${cause.id}\u0000${subject.id}`;
        live.add(key);
        const watch: Watch = this.watching.get(key) ?? {
          cause: cause.id,
          subject: subject.name,
          subjectId: subject.id,
          unit: subject.unit ?? "",
          level: cause.level,
          verdictWorthy: cause.verdictWorthy,
          values: {},
          firstSeen: s.time,
          lastSeen: s.time,
          opened: false,
        };
        watch.lastSeen = s.time;
        watch.level = cause.level;
        // The thresholds and the subject's own numbers belong to the event,
        // not to the settings the reader happens to hold when it is drawn.
        watch.values = subjectValues(cause, subject.id, s, c);
        this.watching.set(key, watch);
        // An alert that was never recorded as open cannot be recorded as closed.
        if (watch.opened || s.time - watch.firstSeen < hold) continue;
        watch.opened = add("alert-open", subject.name, {
          subjectId: subject.id,
          cause: cause.id,
          // The unit name the subject decoded from, for the drill-down; a
          // reader who needs the raw name can still reach it.
          names: { level: cause.level, unit: watch.unit },
          values: { ...watch.values },
        });
      }
    }
    for (const [key, watch] of this.watching) {
      if (live.has(key)) continue;
      // A cause must hold without a gap to open, so a pending watch ends the
      // moment it is absent. Only an alert already recorded waits out a gap.
      if (!watch.opened) {
        this.watching.delete(key);
        continue;
      }
      if (s.time - watch.lastSeen < hold) continue;
      this.watching.delete(key);
      add("alert-close", watch.subject, {
        subjectId: watch.subjectId,
        cause: watch.cause,
        names: { level: watch.level, unit: watch.unit },
        values: { durationMs: watch.lastSeen - watch.firstSeen },
      });
    }
    // The verdict names the worst alert that opened, an alert waiting out its
    // close included, so a cause that steps away for a sample cannot flip it.
    // Severity decides first, then the cause order table. A live ladder
    // position cannot rank an alert the ladder is no longer reporting.
    const lead = [...this.watching.values()]
      .filter((watch) => watch.opened && watch.verdictWorthy)
      .sort(
        (a, b) =>
          severity[b.level] - severity[a.level] ||
          causeRank(a.cause) - causeRank(b.cause) ||
          a.firstSeen - b.firstSeen,
      )[0];
    const verdict = lead?.cause ?? "";
    const level = lead?.level ?? "ok";
    // A cause that escalates from a warning to danger is a new verdict.
    if (verdict !== this.verdict || level !== this.verdictLevel)
      add("verdict", lead?.subject ?? "", {
        subjectId: lead?.subjectId ?? "",
        cause: verdict,
        names: {
          previous: this.verdict,
          previousLevel: this.verdictLevel,
          level,
        },
        values: lead ? { ...lead.values } : {},
      });
    this.verdict = verdict;
    this.verdictLevel = level;
    this.previous = s;
    return out;
  }
}
