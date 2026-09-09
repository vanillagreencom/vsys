import type { CollectionConfig } from "../collect/settings";
import type { Config } from "../config/config";
import { inSlice } from "./lanes";
import type { Alert, Rule, Snapshot } from "./types";

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
        p.tool !== null && !inSlice(p.group, c.agentSlice),
        `${p.tool} PID ${p.pid} runs outside ${c.agentSlice}`,
      );
    }
    for (const l of s.lanes) {
      hit(
        "memory-cap",
        l.id,
        l.dangerous,
        `${l.name} has a memory cap below ${c.memoryFloor} bytes`,
      );
    }
    for (const g of s.groups) {
      hit(
        "memory-high",
        g.path,
        g.memory !== null && g.high !== null && g.memory >= g.high * 0.9,
        `${g.name} is near memory.high`,
      );
      for (const [kind, p] of Object.entries(g.pressure)) {
        const key = `${g.path}/${kind}`;
        if (p && p.some > c.pressureAmber) {
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
    for (const scratch of s.storage.scratch)
      hit(
        "scratch",
        scratch.path,
        scratch.bytes !== null && scratch.bytes > c.scratchQuota,
        `${scratch.path} exceeds ${c.scratchQuota} bytes`,
      );
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

/** Notification argv never passes through a shell. */
export async function notify(alerts: Alert[], c: Config): Promise<void> {
  const failures: Error[] = [];
  for (const a of alerts.filter((a) => c.notifications.includes(a.rule))) {
    const child = Bun.spawn(
      [
        "notify-send",
        "--app-name=vsys-view",
        "--",
        `vsys-view: ${a.rule}`,
        a.message,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const error = await new Response(child.stderr).text();
    const code = await child.exited;
    if (code !== 0)
      failures.push(new Error(`notify-send exited ${code}: ${error.trim()}`));
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `${failures.length} notification(s) failed: ${failures
        .map((e) => e.message)
        .join("; ")}`,
    );
}
