import { spawnText } from "../collect/io";
import type { CollectionConfig } from "../collect/settings";
import type { Config } from "../config/config";
import { escaped } from "./lanes";
import { laneText } from "./naming";
import type { Alert, Rule, Snapshot } from "./types";
import { memoryHighJudgments, processesUnread } from "./verdict";

/** Rules emit transitions, with sustained pressure measured in wall time. */
export class AlertEngine {
  private active = new Set<string>();
  private pressureSince = new Map<string, number>();
  evaluate(s: Snapshot, c: CollectionConfig): Alert[] {
    const next = new Set<string>();
    const pressureKeys = new Set<string>();
    const alerts: Alert[] = [];
    const hit = (
      rule: Rule,
      subject: string,
      condition: boolean,
      message: string,
      repeat = false,
    ) => {
      if (!condition) return;
      const key = `${rule}:${subject}`;
      next.add(key);
      if (repeat || !this.active.has(key))
        alerts.push({ time: s.time, rule, subject, message });
    };
    for (const p of s.procs) {
      hit(
        "unconfined",
        `${p.pid}:${p.start}:${p.tool}`,
        escaped(p, c, s.capabilities),
        `${p.tool} PID ${p.pid} runs outside ${c.agentSlice}`,
      );
    }
    // An unread reading keeps an open alert open, as memory-high does below.
    const keep = (key: string, unread: boolean) => {
      if (unread && this.active.has(key)) next.add(key);
    };
    for (const l of s.lanes) {
      keep(`memory-cap:${l.id}`, !l.memoryMaxKnown);
      hit(
        "memory-cap",
        l.id,
        l.dangerous,
        `${laneText(l)} has a memory cap below ${c.memoryFloor} bytes`,
      );
    }
    for (const { subject: g, judged } of memoryHighJudgments(s.groups)) {
      keep(`memory-high:${g.path}`, judged === "unjudged");
      hit(
        "memory-high",
        g.path,
        judged === "fired",
        `${g.name} is near memory.high`,
      );
      for (const [kind, p] of Object.entries(g.pressure)) {
        const key = `${g.path}/${kind}`;
        if (p === null) {
          keep(`pressure:${key}`, true);
          if (this.pressureSince.has(key)) pressureKeys.add(key);
        } else if (p.some > c.pressureAmber) {
          pressureKeys.add(key);
          const since = this.pressureSince.get(key) ?? s.time;
          this.pressureSince.set(key, since);
          hit(
            "pressure",
            key,
            s.time - since >= c.pressureHoldSeconds * 1000,
            `${g.name} ${kind} pressure is ${p.some}%`,
          );
        }
      }
    }
    for (const v of s.storage.volumes) {
      hit("btrfs-ro", v.mount, v.readOnly, `${v.mount} is read-only`);
      for (const [kind, delta] of Object.entries(v.delta))
        hit(
          "btrfs-errors",
          `${v.fsid}/${kind}`,
          delta > 0,
          `${v.device} ${kind} grew by ${delta}`,
          true,
        );
    }
    for (const scrub of s.storage.scrubs)
      hit("scrub", scrub.path, scrub.problem, `Scrub problem: ${scrub.path}`);
    for (const scratch of s.storage.scratch) {
      keep(`scratch:${scratch.path}`, scratch.bytes === null);
      hit(
        "scratch",
        scratch.path,
        scratch.bytes !== null && scratch.bytes > c.scratchQuota,
        `${scratch.path} exceeds ${c.scratchQuota} bytes`,
      );
    }
    // A sample that read no process cannot say an escaped agent was confined
    // or a process-named lane ended, so neither notification clears.
    if (processesUnread(s)) {
      const lanes = new Set(s.lanes.map((l) => `memory-cap:${l.id}`));
      for (const key of this.active)
        if (
          key.startsWith("unconfined:") ||
          (key.startsWith("memory-cap:") && !lanes.has(key))
        )
          next.add(key);
    }
    for (const key of this.pressureSince.keys())
      if (!pressureKeys.has(key)) this.pressureSince.delete(key);
    this.active = next;
    return alerts.filter(
      (a, i) =>
        alerts.findIndex(
          (b) => b.rule === a.rule && b.subject === a.subject,
        ) === i,
    );
  }
}

/** How long one notify-send call may run before it is killed as a failure. */
export const notifyTimeoutMs = 5000;

/** The alerts whose rule the reader chose to receive as desktop notifications. */
export function notifiable(alerts: Alert[], c: Config): Alert[] {
  return alerts.filter((a) => c.notifications.includes(a.rule));
}

/**
 * Sends each alert it is given; `notifiable()` chooses them. Notification
 * argv never passes through a shell.
 */
export async function notify(
  alerts: Alert[],
  timeoutMs = notifyTimeoutMs,
): Promise<void> {
  const failures: Error[] = [];
  for (const a of alerts) {
    const { error, status, timedOut } = await spawnText(
      ["notify-send", "--app-name=vsys", "--", `vsys: ${a.rule}`, a.message],
      timeoutMs,
    );
    if (timedOut)
      failures.push(new Error(`notify-send timed out after ${timeoutMs} ms`));
    else if (status !== 0)
      failures.push(new Error(`notify-send exited ${status}: ${error.trim()}`));
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `${failures.length} notification(s) failed: ${failures
        .map((e) => e.message)
        .join("; ")}`,
    );
}
