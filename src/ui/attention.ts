import type { Config } from "../config/config";
import { launcherTrail } from "../model/launcher";
import { shellLine } from "../model/shell";
import type { CapabilityId, Snapshot } from "../model/types";
import { type Cause, causes, type Level, type Meter } from "../model/verdict";
import {
  amount,
  bytes,
  count,
  gap,
  plural as p,
  percent,
  share,
} from "./format";
import { capabilityReason } from "./settings";

export interface Attention {
  /** One identifier per cause. Two lanes with one cause share one card. */
  id: string;
  /** The verdict line when this cause tops the ladder. */
  headline: string;
  title: string;
  detail: string;
  /** What the reader should do next, in words. */
  next: string;
  /** Read-only text to copy, built from configured names. */
  command?: string;
  view: "Agents" | "Storage" | "Resources" | "Builds";
  laneId?: string;
  danger: boolean;
  /** Housekeeping cards are never the verdict for the machine. */
  verdictWorthy: boolean;
}
/** The severity word, the sentence, and anything the headline says instead. */
type Copy = Omit<Attention, "id" | "danger" | "headline" | "verdictWorthy"> & {
  word: string;
  headline?: string;
};
const list = (names: string[], limit = 4): string =>
  names.length > limit
    ? `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`
    : names.join(", ");

/** Every word and every formatted number the Overview shows lives here. */
function copy(cause: Cause, s: Snapshot, c: Config, basePath: string[]): Copy {
  const b = (n: number | null | undefined) => bytes(n, c);
  const v = cause.values;
  const n = cause.lanes.length;
  const names = list(cause.lanes.map((l) => l.name));
  const mounts = list(cause.paths);
  const laneId = n === 1 ? cause.lanes[0].id : undefined;
  const paths = cause.paths.length;
  switch (cause.id) {
    case "unconfined": {
      const trails = s.procs
        .filter(
          (x) => x.tool && cause.lanes.some((l) => l.pids.includes(x.pid)),
        )
        .map((x) => launcherTrail(x, s.procs, c, basePath));
      return {
        word: "Danger",
        title: `${n} ${p(n, "lane runs", "lanes run")} outside ${c.agentSlice}: ${names}`,
        detail: trails.length
          ? trails.map((t) => t.summary).join(" ")
          : `${c.agentSlice} limits do not apply to these processes.`,
        next: `Stop each process and start it again through the launcher that places it in ${c.agentSlice}.`,
        command: shellLine([
          "systemd-run",
          "--user",
          `--slice=${c.agentSlice}`,
          "--scope",
          "--",
          cause.lanes[0].tool || "AGENT",
        ]),
        view: "Agents",
        laneId,
      };
    }
    case "read-only":
      return {
        word: "Danger",
        title: `${paths} ${p(paths, "mount is", "mounts are")} read-only: ${mounts}`,
        detail: "Programs cannot save changes on these mounts.",
        next: "Open Storage, then check the kernel log for the error that forced the mount read-only.",
        view: "Storage",
      };
    case "device-errors":
      return {
        word: "Danger",
        title: `New device errors on ${mounts}`,
        detail: `Error counters on ${cause.consumer} increased since the previous sample.`,
        next: "Open Storage and read the per-device counters before writing more data to these devices.",
        view: "Storage",
      };
    case "disk": {
      // The first lane is the writer's own only when the writer resolved to one.
      const writer =
        cause.lanes[0]?.id === cause.groups[0]?.path
          ? cause.lanes[0]
          : undefined;
      return {
        word: cause.level === "danger" ? "Slow" : "Busy",
        title: `Disk I/O ${cause.level === "danger" ? "saturated" : "stalling tasks"}: ${cause.consumer} writing ${b(v.writeRate)}/s`,
        detail: `Tasks stalled on storage ${percent(v.some)} of the recent window, ${percent(v.full)} of it with nothing else to run${v.linkers ? `, with ${count(v.linkers, "linker")} running in that lane` : ""}.${v.stalling ? ` Waiting on storage: ${names}.` : ""}`,
        next: writer
          ? "Lower the build job count for that lane until the stall percentage falls."
          : "Open Resources and find what is writing in that scope, then reduce its work.",
        command: shellLine([
          "cat",
          `${c.cgroupRoot}/${cause.groups[0]?.path}/io.stat`,
        ]),
        view: writer ? "Agents" : "Resources",
        laneId: writer?.id,
      };
    }
    case "desktop-swap":
      return {
        word: "Slow",
        headline: `Slow: desktop swapped out, agents hold ${b(v.cache)} of page cache`,
        title: `Desktop swapped out: ${b(v.swap)} in ${c.desktopSlice}`,
        detail: `${cause.consumer ? `${cause.consumer} holds ${b(v.holder)}. ` : ""}Agents hold ${b(v.cache)} of page cache, which the desktop cannot use.`,
        next: "Reduce concurrent build work, or cap the agent slice memory so the desktop keeps its pages.",
        command: shellLine([
          "cat",
          `${c.cgroupRoot}/${c.agentSlice}/memory.stat`,
        ]),
        view: "Resources",
      };
    case "free-space":
      return {
        word: "Danger",
        title: `${cause.consumer} has ${b(v.free)} free of ${b(v.total)}`,
        detail: `Free space is below the configured floor of ${b(c.freeFloor)}.`,
        next: "Open Storage and remove build output or scratch data from that filesystem.",
        view: "Storage",
      };
    case "memory-cap":
      return {
        word: "Danger",
        title: `${n} ${p(n, "lane has", "lanes have")} a memory limit below ${b(v.floor)}: ${names}`,
        detail: "The limit can stop work before it finishes.",
        next: "Open the lane and check its effective memory.max against the parent slices.",
        command: shellLine([
          "systemctl",
          "--user",
          "show",
          c.agentSlice,
          "-p",
          "MemoryMax",
        ]),
        view: "Agents",
        laneId,
      };
    case "stalls":
      return {
        word: cause.level === "danger" ? "Slow" : "Busy",
        title: `${n} ${p(n, "lane is", "lanes are")} stalling on a resource: ${names}`,
        detail: `Highest stall share ${percent(v.worst)} of the recent window.`,
        next: "Open Agents and compare the CPU, memory and I/O pressure columns to find which resource is short.",
        view: "Agents",
        laneId,
      };
    case "system-memory":
      return {
        word: "Slow",
        title: `Memory reclaim stalls tasks ${percent(v.some)} of the recent window`,
        detail: `${cause.consumer ? `${cause.consumer} holds the most swap.` : "No scope holds swap yet, so reclaim is dropping page cache."}${n ? ` Waiting on memory: ${names}.` : ""}`,
        next: "Open Resources and reduce the work in the group with the largest memory use.",
        view: "Resources",
      };
    case "system-cpu":
      return {
        word: "Slow",
        title: `Tasks wait for CPU ${percent(v.some)} of the recent window${cause.consumer ? `, busiest lane ${cause.consumer}` : ""}`,
        detail: `${cause.consumer ? `${cause.consumer} is the busiest lane.` : "No lane is running, so the load is outside the watched slices."}${n ? ` Waiting on CPU: ${names}.` : ""}`,
        next: "Open Agents and sort by CPU to find the lane to pause.",
        view: "Agents",
      };
    case "memory-high": {
      const groups = cause.groups.length;
      return {
        word: "Busy",
        title: `${groups} ${p(groups, "group is", "groups are")} near the memory threshold: ${list(cause.groups.map((g) => g.name))}`,
        detail: "Memory reclaim can slow every task in these groups.",
        next: "Open Resources and raise memory.high, or reduce the work running there.",
        view: "Resources",
      };
    }
    case "scrub":
      return {
        word: "Danger",
        title: `${paths} filesystem ${p(paths, "scrub reports a problem", "scrubs report problems")}`,
        detail: mounts,
        next: "Open Storage and read the scrub report.",
        view: "Storage",
      };
    case "scratch":
      return {
        word: "Busy",
        title: `${paths} scratch ${p(paths, "directory exceeds", "directories exceed")} the quota: ${mounts}`,
        detail: `Largest ${b(v.largest)} against a quota of ${b(v.quota)}.`,
        next: "Open Storage and remove the scratch directories that finished work no longer needs.",
        view: "Storage",
      };
  }
}
/**
 * Cards are grouped by cause, never by lane. Nine lanes stalling on one
 * saturated disk produce one card that names all nine.
 */
export function attention(
  s: Snapshot,
  c: Config,
  basePath: string[] = (process.env.PATH ?? "").split(":"),
): Attention[] {
  return causes(s, c).map((cause) => {
    const { word, headline, ...rest } = copy(cause, s, c, basePath);
    return {
      id: cause.id,
      danger: cause.level === "danger",
      verdictWorthy: cause.verdictWorthy,
      headline: headline ?? `${word}: ${rest.title}`,
      ...rest,
    };
  });
}
/** The worst cause that speaks for the machine. Housekeeping never does. */
export function verdictItem(items: Attention[]): Attention | undefined {
  return items.find((item) => item.verdictWorthy);
}
/** The verdict is the worst such cause, or a statement that nothing is wrong. */
export function verdictLine(items: Attention[], s: Snapshot): string {
  const lead = verdictItem(items);
  if (lead) return lead.headline;
  return ["cpu", "memory", "io"].some((kind) => s.system.pressure[kind])
    ? "Healthy"
    : "Health unknown: no pressure data on this kernel";
}
/**
 * A source vsys cannot read is a vsys problem, not a system problem. It belongs
 * in a footer, counted once per source rather than once per failed read.
 */
export function sourceFooter(s: Snapshot): string | null {
  const sources = new Set(s.errors.map((e) => e.source));
  return sources.size
    ? `vsys cannot read ${sources.size} ${p(sources.size, "source", "sources")}; open Settings`
    : null;
}
/**
 * A quantity vsys could not read names the interface that would have supplied
 * it, so a meter on a kernel without that interface is never merely blank.
 */
export function unread(s: Snapshot, id?: CapabilityId): string {
  const missing = s.capabilities.find((cap) => cap.id === id && !cap.available);
  const reason = missing ? capabilityReason(missing) : "";
  return reason ? `${gap}: ${reason}` : gap;
}
/** A meter as a tile: one headline number, one line of context, and the facts behind it. */
export interface TileCopy {
  label: string;
  value: string;
  detail: string;
  level: Level;
  /** Everything the meter knows, for the screen that drills into it. */
  facts: [string, string][];
}
export function meterTile(meter: Meter, s: Snapshot, c: Config): TileCopy {
  // The shared wrappers format; a capability that would have supplied a
  // missing quantity replaces their bare wording with its reason.
  const b = (n: number | null, id?: CapabilityId) =>
    n === null ? unread(s, id) : amount(n, c);
  const pc = (n: number | null, id?: CapabilityId) =>
    n === null ? unread(s, id) : share(n);
  const who = (value: string, id?: CapabilityId) =>
    meter.consumer ? `${meter.consumer} ${value}`.trimEnd() : unread(s, id);
  const v = meter.values;
  const level = meter.level;
  if (meter.id === "cpu")
    return {
      label: "CPU wait",
      value: pc(v.system, "psi"),
      detail: `agents ${pc(v.agents, "delegation")} · desktop ${pc(v.desktop, "delegation")}`,
      level,
      facts: [
        ["Tasks waiting", pc(v.system, "psi")],
        ["Agents", pc(v.agents, "delegation")],
        ["Desktop", pc(v.desktop, "delegation")],
        ["Busiest agent", who(pc(v.top, "delegation"), "delegation")],
      ],
    };
  if (meter.id === "memory")
    return {
      label: "Memory",
      value: b(v.used),
      detail: `of ${b(v.total)} · swap ${b(v.swap, "delegation")}`,
      level,
      facts: [
        ["Used", `${b(v.used)} of ${b(v.total)}`],
        ["Agent page cache", b(v.cache, "delegation")],
        ["Desktop swap", b(v.swap, "delegation")],
        ["Largest", who(b(v.largest, "delegation"), "delegation")],
        ...(meter.holder === undefined
          ? []
          : [
              [
                "Most swapped",
                `${meter.holder || gap} ${b(v.holderSwap, "delegation")}`,
              ] as [string, string],
            ]),
      ],
    };
  if (meter.id === "disk") {
    const space =
      s.storage.mountsAvailable === false
        ? "mount information unavailable"
        : s.storage.volumes.length
          ? `${b(v.free)} free`
          : "no watched filesystems";
    return {
      label: "Disk wait",
      value: pc(v.some, "psi"),
      detail: space,
      level,
      facts: [
        [
          "Tasks waiting",
          `${pc(v.some, "psi")} · nothing runnable ${pc(v.full, "psi")}`,
        ],
        ["Least free", space],
        ["Top writer", who(`${b(v.writeRate, "io-stat")}/s`, "io-stat")],
      ],
    };
  }
  return {
    label: "Builds",
    value: `${v.builds ?? 0} of ${v.cores ?? 0} cores`,
    detail: `${count(v.linkers, "linker")} · ${count(v.lanes, "lane")}`,
    level,
    facts: [
      ["Compile and link", `${v.builds ?? 0} of ${v.cores ?? 0} cores`],
      ["Linkers", String(v.linkers ?? 0)],
      ["Lanes building", String(v.lanes ?? 0)],
      ["Busiest agent", who("")],
    ],
  };
}
