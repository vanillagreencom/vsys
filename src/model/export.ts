import type { Config } from "../config/config";
import type { Snapshot, SourceError } from "./types";
import {
  type CauseId,
  causes,
  type Level,
  type Meter,
  meters,
} from "./verdict";

export const summarySchema = "vsys.summary.v1";

export interface SummaryCause {
  cause: CauseId;
  level: Level | null;
  subject: string | null;
}
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

/** Escape terminal control characters before showing process-supplied strings. */
export function safe(value: unknown): string {
  // Kernel process strings can contain terminal escape and control bytes.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove terminal controls
  return String(value ?? "?").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function subject(cause: ReturnType<typeof causes>[number]): string | null {
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

function summaryMeter(meter: ReturnType<typeof meters>[number]): SummaryMeter {
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

/** Cheap machine verdict for external consumers. */
export function summarySnapshot(
  s: Snapshot,
  c: Config,
  options: SummaryOptions = {},
): Summary {
  const verdict: SummaryCause[] = causes(s, c).map((cause) => ({
    cause: cause.id,
    level: cause.level,
    subject: subject(cause),
  }));
  if (options.scratchMeasured === false)
    verdict.push({ cause: "scratch", level: null, subject: null });
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
  s: Snapshot,
  format: "json" | "markdown",
): string {
  if (format === "json") return `${JSON.stringify(s, null, 2)}\n`;
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
        d.age,
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
