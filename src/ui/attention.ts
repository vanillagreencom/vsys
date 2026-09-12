import type { Config } from "../config/config";
import { launcherCopy, launcherTally } from "../model/launcher";
import { laneText, unitLabel } from "../model/naming";
import { shellLine } from "../model/shell";
import type { CapabilityId, Snapshot } from "../model/types";
import { type Cause, causes, type Level, type Meter } from "../model/verdict";
import { capLines, fit, wrapLines } from "./columns";
import {
  age,
  amount,
  bytes,
  count,
  gap,
  plural as p,
  percent,
  share,
} from "./format";
import { capabilityReason } from "./settings";

/**
 * The row the card's screen should land on. A card names one thing; opening it
 * and leaving the reader to find that thing again on the next screen wastes
 * the naming.
 */
export type Target =
  | { kind: "lane"; id: string }
  | { kind: "group"; path: string }
  | { kind: "path"; path: string }
  /**
   * A moment, and which change at it. Every change found in one sample shares
   * that sample's time, so the time alone names the first of them and not the
   * one the reader chose. The cursor is set from `at`; the row is found by
   * `id`.
   */
  | { kind: "time"; at: number; id: string };
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
  /** Absent when the card names no single row, such as a machine-wide stall. */
  target?: Target;
  danger: boolean;
  /** Housekeeping cards are never the verdict for the machine. */
  verdictWorthy: boolean;
}
/** The severity word, the sentence, and anything the headline says instead. */
type Copy = Omit<
  Attention,
  "id" | "danger" | "headline" | "verdictWorthy" | "detail"
> & {
  word: string;
  headline?: string;
  /** The ways this card offers of writing its detail, best first. */
  detail: string[];
  /** The sentence the detail ends with and gives up last: the lane names a
   * cut title needs under it. Absent on a card that names no lane. */
  keep?: string;
};
/** The names a title lists before it stops counting and says how many remain. */
const listLimit = 4;
const list = (names: string[], limit = listLimit): string =>
  names.length > limit
    ? `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`
    : names.join(", ");
/**
 * The rows a card's detail draws. A card the reader opens to learn what to do
 * must leave `Next` and the command on the screen with it, and a detail that
 * grows with the machine pushes both off a terminal of ordinary height.
 */
const detailLines = 6;
/** The rows of that budget the list of affected lanes may take. */
const laneLines = 2;
/** The width card copy is measured at when the caller is not a screen. */
const defaultDetailWidth = 80;
/** The sentences of a detail, joined in the order they are written. */
const join = (parts: string[]): string =>
  parts.filter((part) => part !== "").join(" ");
/**
 * The detail a card draws: the first of the leads it offers that holds the
 * budget beside `keep`, which is written after it. A caller lists its leads
 * best first, so the order a card gives ground in reads where the copy is
 * written. When none is short enough the shortest is cut to what `keep`
 * leaves, and `keep` itself is cut last, so the budget holds at every width.
 */
function fitDetail(leads: string[], keep: string, width: number): string {
  const rows = (text: string) => wrapLines(text, width).length;
  const fits = leads.find((lead) => rows(join([lead, keep])) <= detailLines);
  if (fits !== undefined) return join([fits, keep]);
  const last = leads[leads.length - 1] ?? "";
  if (keep === "") return capLines(last, width, detailLines);
  const kept = capLines(keep, width, detailLines - 1);
  return join([capLines(last, width, detailLines - rows(kept)), kept]);
}
/**
 * Every affected lane, behind the head its card writes, for a detail that
 * opens under a title a narrow row cut. What it cannot fit it counts.
 */
function laneSentence(names: string[], width: number, head: string): string {
  const whole = `${head}${names.join(", ")}.`;
  if (wrapLines(whole, width).length <= laneLines) return whole;
  // One name is the whole sentence, and there is no second name to count, so
  // it is cut with the mark rather than followed by a count of nothing.
  if (names.length === 1) return capLines(whole, width, laneLines);
  const shortened = (keep: number) =>
    `${head}${names.slice(0, keep).join(", ")} and ${names.length - keep} more.`;
  for (let keep = names.length - 1; keep >= 1; keep--)
    if (wrapLines(shortened(keep), width).length <= laneLines)
      return shortened(keep);
  // Not even one name fits beside the count of the rest. The name gives way
  // and the count stays: the names are on the screen Enter opens, the count
  // of how many there are is only here.
  const rest = ` and ${names.length - 1} more.`;
  const named = (room: number) => `${fit(`${head}${names[0]}`, room)}${rest}`;
  let room = laneLines * width - [...rest].length;
  while (room > 1 && wrapLines(named(room), width).length > laneLines) room--;
  return named(room);
}

/** Every word and every formatted number the Overview shows lives here. */
function copy(
  cause: Cause,
  s: Snapshot,
  c: Config,
  basePath: string[],
  width: number,
): Copy {
  const b = (n: number | null | undefined) => bytes(n, c);
  const v = cause.values;
  const n = cause.lanes.length;
  const laneNames = cause.lanes.map(laneText);
  const names = list(laneNames);
  const every = laneSentence(laneNames, width, `${p(n, "Lane", "Lanes")}: `);
  const mounts = list(cause.paths);
  const lane: Target | undefined =
    n === 1 ? { kind: "lane", id: cause.lanes[0].id } : undefined;
  // Where a card whose row is a group lands. A cause states `at` when the row
  // to open is not one of the things it affects; otherwise the first affected
  // group is that row.
  const group: Target | undefined =
    cause.at ??
    (cause.groups[0]
      ? { kind: "group", path: cause.groups[0].path }
      : undefined);
  const first: Target | undefined = cause.paths[0]
    ? { kind: "path", path: cause.paths[0] }
    : undefined;
  const paths = cause.paths.length;
  switch (cause.id) {
    case "unconfined": {
      const escaped = s.procs.filter(
        (x) => x.tool && cause.lanes.some((l) => l.pids.includes(x.pid)),
      );
      const groups = launcherCopy(escaped, s.procs, c, basePath);
      const said = groups.map((g) => g.conclusion);
      const processHead = `${escaped.length} processes in ${n} ${p(n, "lane", "lanes")}: `;
      // What a narrow panel gives up, in order: the ancestor chains, then a
      // conclusion at a time from the last. The first conclusion and the lane
      // sentence are what the card exists to say. Every conclusion given up is
      // counted, including one whose cgroup another conclusion still names.
      const rungs = [
        join(groups.map((g) => `${g.conclusion}${g.started}`)),
        join(said),
      ];
      for (let kept = said.length - 1; kept >= 1; kept--) {
        const gone = said.length - kept;
        rungs.push(
          join([
            ...said.slice(0, kept),
            `And ${gone} more ${p(gone, "group", "groups")} of processes not written here.`,
          ]),
        );
      }
      // At the floor a panel can be, one whole conclusion and the count of
      // what went do not fit in the rows left beside the lane sentence. The
      // last rung states every conclusion as a count instead, so what the
      // card shows there is whole rather than a sentence the cut ended.
      rungs.push(launcherTally(groups));
      return {
        word: "Danger",
        title: `${n} ${p(n, "lane runs", "lanes run")} outside ${c.agentSlice}: ${names}`,
        detail: groups.length
          ? rungs
          : [`${c.agentSlice} limits do not apply to these processes.`],
        // The title counts lanes and the sentences above count processes, so
        // the sentence naming the lanes states both counts rather than leave
        // a reader to doubt either.
        keep:
          escaped.length > n
            ? laneSentence(laneNames, width, processHead)
            : every,
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
        target: lane,
      };
    }
    case "read-only":
      return {
        word: "Danger",
        title: `${paths} ${p(paths, "mount is", "mounts are")} read-only: ${mounts}`,
        detail: ["Programs cannot save changes on these mounts."],
        next: "Open Storage, then check the kernel log for the error that forced the mount read-only.",
        view: "Storage",
        target: first,
      };
    case "damaged-files": {
      const files = v.files ?? 0;
      const other = v.other ?? 0;
      const build = v.build ?? 0;
      // A block count vsys did not read is left out rather than shown as zero.
      const repaired =
        v.blocks === null || v.blocks === undefined
          ? ""
          : `The last check could not repair ${count(v.blocks, "block")}. `;
      return {
        word: "Danger",
        title: files
          ? `Damaged files on ${mounts}: ${count(files, "file")}${other ? "" : ", all build output"}`
          : `Damaged data on ${mounts}`,
        detail: [
          files
            ? `${repaired}${count(build, "address")} hold build output a rebuild replaces${other ? `, and ${count(other, "address")} hold data only a backup or a snapshot restores` : ""}.`
            : `${repaired}The report named no file, so the damage is in free space or in a file already deleted.`,
        ],
        // The step never says to delete everything listed: an address holding
        // data a rebuild cannot replace is restored, not removed, and a card
        // that blurs the two invites the reader to delete their own files.
        next: !files
          ? "Open Storage and check the filesystem again; an address with no file clears on the next check."
          : other || v.changed
            ? "Open Storage and open the filesystem. Delete only the addresses it marks as build output, and leave the rest to a backup or a snapshot."
            : "Open Storage, open the filesystem, and delete every path listed under each damaged address before rebuilding.",
        view: "Storage",
        target: cause.at ?? first,
      };
    }
    case "new-errors":
      return {
        word: "Danger",
        title: `New errors on ${mounts} since the last check`,
        // The numbers belong to one filesystem. Naming several gives the
        // sentence without them rather than one filesystem's as the whole.
        detail: [
          paths === 1
            ? `The counter grew${v.since == null ? "" : ` ${age(v.since)} ago`}${v.size == null ? "" : ` by ${count(v.size, "failed read")}`}, and the last full check ran ${v.checked == null ? "longer ago than that" : `${age(v.checked)} ago`}. Nothing has read the filesystem end to end since, so no check has said what the damage cost.`
            : "Each of these counters grew after the last check that read its filesystem end to end, so no check has said what the damage cost. Open each one for its own times.",
        ],
        next: "Open Storage and run a check on that filesystem, then read the damaged files it names.",
        view: "Storage",
        target: cause.at ?? first,
        headline: `Danger: new errors on ${mounts}, unchecked since`,
      };
    case "integrity-unknown":
      return {
        word: "Unknown",
        title: `${paths} ${p(paths, "filesystem cannot", "filesystems cannot")} report whether ${p(paths, "its", "their")} data is sound: ${mounts}`,
        detail: [
          "A check report, or a counter the state depends on, could not be read. The filesystem is not reported healthy on a reading vsys does not have.",
        ],
        next: "Open Storage and read the report under that filesystem, then check the report directory and the error memory file.",
        view: "Storage",
        target: cause.at ?? first,
      };
    case "unchecked": {
      const never = v.never ?? 0;
      return {
        word: "Unknown",
        // One card can name filesystems in both states. Where it does, the
        // title counts them apart rather than calling every one of them never
        // checked, which would misstate the ones a timer did check.
        title:
          never === paths
            ? `${count(never, "filesystem")} never checked for damage: ${mounts}`
            : never === 0
              ? `${paths} ${p(paths, "filesystem has", "filesystems have")} not been checked in ${age(v.oldest ?? 0)}: ${mounts}`
              : `${count(paths, "filesystem")} unchecked for damage, ${never} of them never: ${mounts}`,
        detail: [
          `The error counter counts failed reads, not damaged files, so it stays flat while nothing reads the damage. Only a full check reads every block. The limit is ${count(v.limit, "day")}.`,
        ],
        next: "Run a check on each filesystem, or install the timer that writes a report into the report directory.",
        view: "Storage",
        target: cause.at ?? first,
      };
    }
    case "device-errors":
      return {
        word: "Danger",
        title: `New device errors on ${mounts}`,
        detail: [
          `Error counters on ${cause.consumer} increased since the previous sample.`,
        ],
        next: "Open Storage and read the per-device counters before writing more data to these devices.",
        view: "Storage",
        target: first,
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
        detail: [
          `Tasks stalled on storage ${percent(v.some)} of the recent window, ${percent(v.full)} of it with nothing else to run${v.linkers ? `, with ${count(v.linkers, "linker")} running in that lane` : ""}.${v.stalling ? ` Waiting on storage: ${names}.` : ""}`,
        ],
        next: writer
          ? "Lower the build job count for that lane until the stall percentage falls."
          : "Open Resources and find what is writing in that scope, then reduce its work.",
        // No resolved group is no path, and a command naming an unresolved
        // path is one a reader would copy and run against nothing.
        command: cause.groups[0]
          ? shellLine([
              "cat",
              `${c.cgroupRoot}/${cause.groups[0].path}/io.stat`,
            ])
          : undefined,
        view: writer ? "Agents" : "Resources",
        target: writer ? { kind: "lane", id: writer.id } : group,
      };
    }
    case "desktop-swap":
      return {
        word: "Slow",
        headline: `Slow: desktop swapped out, agents hold ${b(v.cache)} of page cache`,
        title: `Desktop swapped out: ${b(v.swap)} in ${c.desktopSlice}`,
        detail: [
          `${cause.consumer ? `${cause.consumer} holds ${b(v.holder)}. ` : ""}Agents hold ${b(v.cache)} of page cache, which the desktop cannot use.`,
        ],
        next: "Reduce concurrent build work, or cap the agent slice memory so the desktop keeps its pages.",
        command: shellLine([
          "cat",
          `${c.cgroupRoot}/${c.agentSlice}/memory.stat`,
        ]),
        view: "Resources",
        target: group,
      };
    case "free-space":
      return {
        word: "Danger",
        title: `${cause.consumer} has ${b(v.free)} free of ${b(v.total)}`,
        detail: [
          `Free space is below the configured floor of ${b(c.freeFloor)}.`,
        ],
        next: "Open Storage and remove build output or scratch data from that filesystem.",
        view: "Storage",
        target: cause.consumer
          ? { kind: "path", path: cause.consumer }
          : undefined,
      };
    case "memory-cap":
      return {
        word: "Danger",
        title: `${n} ${p(n, "lane has", "lanes have")} a memory limit below ${b(v.floor)}: ${names}`,
        detail: ["The limit can stop work before it finishes."],
        keep: every,
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
        target: lane,
      };
    case "stalls":
      return {
        word: cause.level === "danger" ? "Slow" : "Busy",
        title: `${n} ${p(n, "lane is", "lanes are")} stalling on a resource: ${names}`,
        detail: [
          `Highest stall share ${percent(v.worst)} of the recent window.`,
        ],
        keep: every,
        next: "Open Agents and compare the CPU, memory and I/O pressure columns to find which resource is short.",
        view: "Agents",
        target: lane,
      };
    case "system-memory":
      return {
        word: "Slow",
        title: `Memory reclaim stalls tasks ${percent(v.some)} of the recent window`,
        detail: [
          `${cause.consumer ? `${cause.consumer} holds the most swap.` : "No scope holds swap yet, so reclaim is dropping page cache."}${n ? ` Waiting on memory: ${names}.` : ""}`,
        ],
        next: "Open Resources and reduce the work in the group with the largest memory use.",
        view: "Resources",
        target: group,
      };
    case "system-cpu":
      return {
        word: "Slow",
        title: `Tasks wait for CPU ${percent(v.some)} of the recent window${cause.consumer ? `, busiest lane ${cause.consumer}` : ""}`,
        detail: [
          `${cause.consumer ? `${cause.consumer} is the busiest lane.` : "No lane is running, so the load is outside the watched slices."}${n ? ` Waiting on CPU: ${names}.` : ""}`,
        ],
        next: "Open Agents and sort by CPU to find the lane to pause.",
        view: "Agents",
      };
    case "memory-high": {
      const groups = cause.groups.length;
      return {
        word: "Busy",
        title: `${groups} ${p(groups, "group is", "groups are")} near the memory threshold: ${list(cause.groups.map((g) => unitLabel(g.name)))}`,
        detail: ["Memory reclaim can slow every task in these groups."],
        next: "Open Resources and raise memory.high, or reduce the work running there.",
        view: "Resources",
        target: group,
      };
    }
    case "scrub":
      return {
        word: "Danger",
        title: `${paths} filesystem ${p(paths, "scrub reports a problem", "scrubs report problems")}`,
        detail: [mounts],
        next: "Open Storage and read the scrub report.",
        view: "Storage",
        target: first,
      };
    case "scratch":
      return {
        word: "Busy",
        title: `${paths} scratch ${p(paths, "directory exceeds", "directories exceed")} the quota: ${mounts}`,
        detail: [`Largest ${b(v.largest)} against a quota of ${b(v.quota)}.`],
        next: "Open Storage and remove the scratch directories that finished work no longer needs.",
        view: "Storage",
        target: first,
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
  o: { basePath?: string[]; width?: number } = {},
): Attention[] {
  const basePath = o.basePath ?? (process.env.PATH ?? "").split(":");
  const width = o.width ?? defaultDetailWidth;
  return causes(s, c).map((cause) => {
    const { word, headline, keep, ...rest } = copy(
      cause,
      s,
      c,
      basePath,
      width,
    );
    return {
      id: cause.id,
      danger: cause.level === "danger",
      verdictWorthy: cause.verdictWorthy,
      headline: headline ?? `${word}: ${rest.title}`,
      ...rest,
      detail: fitDetail(rest.detail, keep ?? "", width),
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
  // The headline is time lost to waiting; the detail is how much of the
  // machine is in use. Two percentages of different things sit one line apart,
  // so each says which it is.
  if (meter.id === "cpu")
    return {
      label: "CPU wait",
      value: pc(v.system, "psi"),
      detail: `in use: agents ${pc(v.agents, "delegation")} · desktop ${pc(v.desktop, "delegation")}`,
      level,
      facts: [
        ["Time tasks waited", pc(v.system, "psi")],
        ["Cores agents use", pc(v.agents, "delegation")],
        ["Cores desktop uses", pc(v.desktop, "delegation")],
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
