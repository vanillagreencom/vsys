import type { Config } from "../config/config";
import { exportedSnapshot, exportJson, safe } from "../model/export";
import { programName } from "../model/naming";
import type { Snapshot, SourceError } from "../model/types";
import {
  type Cause,
  type CauseId,
  causes,
  type Level,
  type Meter,
  meters,
} from "../model/verdict";
import { attention } from "./attention";

/** The name the bar widget's reader (VGS-2321) checks exactly. */
export const summarySchema = "vsys.summary.v2";

export interface SummaryProcess {
  pid: number;
  name: string;
}
/**
 * A cause the ladder raised carries its Home card's title, so the summary and
 * the card say the same words, with each lane the cause names written by name
 * alone, and the processes the cause names. A cause that could not be
 * measured has no card and no level.
 */
export type SummaryCause =
  | {
      cause: CauseId;
      level: Level;
      subject: string | null;
      title: string;
      processes: SummaryProcess[];
      /** vsys arguments that open vsys at this cause; empty when none exists. */
      open: string[];
    }
  | { cause: CauseId; level: null; subject: null };
export interface SummaryMeter {
  id: Meter["id"];
  value: number | null;
  max: number | null;
  level: Level;
}
export interface Summary {
  schema: typeof summarySchema;
  time: number;
  verdict: SummaryCause[];
  meters: SummaryMeter[];
  errors: SourceError[];
}
export interface SummaryOptions {
  errors?: SourceError[];
  scratchMeasured?: boolean;
}

function subject(cause: Cause): string | null {
  if (cause.lanes[0]) return cause.lanes[0].id;
  if (cause.groups[0]) return cause.groups[0].path;
  if (cause.paths[0]) return cause.paths[0];
  return null;
}

/** A reading `meters()` sets on every meter of this id; an unread one is null. */
function reading(meter: Meter, name: string): number | null {
  const value = meter.values[name];
  if (value === undefined)
    throw new Error(`Meter ${meter.id} carries no ${name} reading`);
  return value;
}

function summaryMeter(meter: Meter): SummaryMeter {
  switch (meter.id) {
    case "cpu":
      return {
        id: meter.id,
        value: reading(meter, "system"),
        max: 100,
        level: meter.level,
      };
    case "memory":
      return {
        id: meter.id,
        value: reading(meter, "used"),
        max: reading(meter, "total"),
        level: meter.level,
      };
    case "disk":
      return {
        id: meter.id,
        value: reading(meter, "some"),
        max: 100,
        level: meter.level,
      };
    case "builds":
      return {
        id: meter.id,
        value: reading(meter, "builds"),
        max: reading(meter, "cores"),
        level: meter.level,
      };
    default:
      throw new Error(`Unknown meter id: ${meter.id}`);
  }
}

/**
 * Cheap machine verdict for external consumers, among them the bar widget's
 * flyout. Its words are the Home cards' own, so the two never disagree.
 */
export function summarySnapshot(
  s: Snapshot,
  c: Config,
  options: SummaryOptions = {},
): Summary {
  // One card per cause, keyed by the cause it was written for. The widget
  // draws no process id, so a lane is its name; the ids are in `processes`.
  const cards = attention(s, c, { laneName: (lane) => lane.name });
  const titles = new Map(cards.map((card) => [card.id, card.title]));
  const verdict: SummaryCause[] = causes(s, c).map((cause) => {
    const title = titles.get(cause.id);
    if (title === undefined)
      throw new Error(`Cause ${cause.id} has no attention card`);
    return {
      cause: cause.id,
      level: cause.level,
      subject: subject(cause),
      title,
      processes: cause.procs.map((proc) => ({
        pid: proc.pid,
        name: programName(proc),
      })),
      // No vsys argument opens vsys at a cause yet.
      open: [],
    };
  });
  if (options.scratchMeasured === false)
    verdict.push({ cause: "scratch", level: null, subject: null });
  // Until a unit has an hour average, as in a `--once` run, the cause is
  // unmeasured, not clear.
  const units = s.services;
  if (
    units === null ||
    (units.length > 0 && units.every((u) => u.cpuHourPercent === null))
  )
    verdict.push({ cause: "service-cpu", level: null, subject: null });
  return {
    schema: summarySchema,
    time: s.time,
    verdict,
    meters: meters(s, c).map(summaryMeter),
    errors: options.errors ?? s.errors,
  };
}

export function exportSummary(
  s: Snapshot,
  c: Config,
  errors: SourceError[] = s.errors,
  options: Omit<SummaryOptions, "errors"> = {},
): string {
  return `${JSON.stringify(
    summarySnapshot(s, c, { ...options, errors }),
    null,
    2,
  )}\n`;
}

/** Reports retain resource limits and launch evidence alongside each rule hit. */
export function exportSnapshot(
  snapshot: Snapshot,
  format: "json" | "markdown",
): string {
  if (format === "json") return exportJson(snapshot);
  const s = exportedSnapshot(snapshot);
  const cell = (value: unknown) =>
    safe(value)
      .replaceAll("&", "&amp;")
      .replace(/[\\`*_{}[\]()#+.!<>|]/g, "\\$&");
  const table = (headers: string[], rows: unknown[][]): string[] => [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
  return [
    "# vsys snapshot",
    "",
    `Time: ${new Date(s.time).toISOString()}`,
    `Host: ${cell(s.system.host)}`,
    "",
    "## System",
    "",
    `Load: ${s.system.load.join(", ")}`,
    `Logical cores: ${s.system.cores}`,
    "",
    ...table(["Memory counter", "Bytes"], Object.entries(s.system.memory)),
    "",
    ...table(
      ["Resource", "Some pressure %", "Full pressure %"],
      Object.entries(s.system.pressure).map(([key, p]) => [
        key,
        p?.some,
        p?.full,
      ]),
    ),
    "",
    ...table(
      ["Zram device", "Original bytes", "Compressed bytes", "Used bytes"],
      s.system.zram.map((z) => [z.device, z.original, z.compressed, z.used]),
    ),
    "",
    "## Agents",
    "",
    ...table(
      [
        "Lane",
        "Account",
        "Worktree",
        "Branch",
        "Tool",
        "PID",
        "CPU %",
        "CPU pressure %",
        "RSS bytes",
        "Swap bytes",
        "Tasks",
        "Rustc",
        "Cargo",
        "Tests",
        "Age seconds",
        "State",
        "Unconfined",
        "Dangerous cap",
      ],
      s.lanes.map((l) => [
        l.name,
        l.account,
        l.cwd,
        l.branch,
        l.tool,
        l.mainPid,
        l.cpu,
        l.pressure,
        l.rss,
        l.swap,
        l.tasks,
        l.rustc,
        l.cargo,
        l.tests,
        l.age,
        l.state,
        l.unconfined,
        l.dangerous,
      ]),
    ),
    "",
    "## Resource limits",
    "",
    ...table(
      [
        "Cgroup",
        "CPU weight",
        "CPU quota / period",
        "Memory bytes",
        "Memory high",
        "Memory max",
        "Swap bytes",
        "Swap max",
        "Tasks",
        "Tasks max",
        "Pressure",
      ],
      s.groups.map((g) => [
        g.kernelPath ?? g.path,
        g.weight,
        g.cpuMax,
        g.memory,
        g.high ?? "max / unavailable",
        g.max ?? "max / unavailable",
        g.swap,
        g.swapMax ?? "max / unavailable",
        g.tasks,
        g.tasksMax ?? "max / unavailable",
        JSON.stringify(g.pressure),
      ]),
    ),
    "",
    "## Processes",
    "",
    ...table(
      [
        "PID",
        "Parent PID",
        "Cgroup",
        "Command",
        "Executable",
        "CPU %",
        "Threads",
        "RSS bytes",
        "Worktree",
        "Environment",
      ],
      s.procs.map((p) => [
        p.pid,
        p.ppid,
        p.group,
        JSON.stringify(p.command),
        p.executable,
        p.cpuPercent,
        p.threads,
        p.rss,
        p.cwd,
        JSON.stringify(p.env),
      ]),
    ),
    "",
    "## Storage",
    "",
    ...table(
      [
        "Mount",
        "Device",
        "Read only",
        "Options",
        "Free bytes",
        "Total bytes",
        "Error counters",
        "Sample delta",
        "Startup delta",
      ],
      s.storage.volumes.map((v) => [
        v.mount,
        v.device,
        v.readOnly,
        v.options.join(", "),
        v.free,
        v.total,
        JSON.stringify(v.errors),
        JSON.stringify(v.delta),
        JSON.stringify(v.sinceStart),
      ]),
    ),
    "",
    ...s.storage.scrubs.map(
      (scrub) => `- ${cell(scrub.path)}: ${cell(scrub.text)}`,
    ),
    "",
    "## Scratch",
    "",
    `Scan time: ${s.storage.scratchTime == null ? "unavailable" : new Date(s.storage.scratchTime).toISOString()}`,
    `Scan pending: ${s.storage.scratchPending ?? false}`,
    "",
    ...table(
      ["Directory", "Bytes", "Age at scan, seconds", "Error"],
      [...s.storage.scratch, ...s.storage.sessions].map((d) => [
        d.path,
        d.bytes,
        d.age ?? "unavailable",
        d.error ?? "",
      ]),
    ),
    "",
    "## Alerts",
    "",
    ...s.alerts.map(
      (a) =>
        `- ${new Date(a.time).toISOString()} ${cell(a.rule)}: ${cell(a.message)}`,
    ),
    "",
    "## Source errors",
    "",
    ...s.errors.map((e) => `- ${cell(e.source)}: ${cell(e.message)}`),
    "",
  ].join("\n");
}
