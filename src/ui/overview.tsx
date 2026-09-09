import type { Config } from "../config/config";
import { safe } from "../model/export";
import { lanePressure } from "../model/lanes";
import { launcherTrail } from "../model/launcher";
import type { Lane, Snapshot } from "../model/types";
import {
  desktopSwap,
  type Level,
  laneLinkers,
  meters,
  sliceGroup,
  topSwapHolder,
  topWriter,
  unconfinedLanes,
  verdict,
} from "../model/verdict";
import { bytes, percent } from "./format";
import { themePalette } from "./theme";

export interface Attention {
  /** One identifier per cause. Two lanes with one cause share one card. */
  id: string;
  title: string;
  detail: string;
  /** What the reader should do next, in words. */
  next: string;
  /** Read-only text to copy, built from configured names. */
  command?: string;
  view: "Fleet" | "Storage" | "Alerts" | "Slices" | "Builds";
  laneId?: string;
  danger: boolean;
}
const list = (names: string[], limit = 4): string =>
  names.length > limit
    ? `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`
    : names.join(", ");

/**
 * Cards are grouped by cause, never by lane. Nine lanes stalling on one
 * saturated disk produce one card that names all nine.
 */
export function attention(
  s: Snapshot,
  c: Config,
  basePath: string[] = (process.env.PATH ?? "").split(":"),
): Attention[] {
  const items: Attention[] = [];
  const only = (lanes: Lane[]) =>
    lanes.length === 1 ? lanes[0].id : undefined;
  const escaped = unconfinedLanes(s);
  if (escaped.length) {
    const trails = s.procs
      .filter((p) => p.tool && escaped.some((l) => l.pids.includes(p.pid)))
      .map((p) => launcherTrail(p, s.procs, c, basePath));
    items.push({
      id: "unconfined",
      title: `${escaped.length} ${
        escaped.length === 1 ? "lane runs" : "lanes run"
      } outside ${c.agentSlice}: ${list(escaped.map((l) => l.name))}`,
      detail: trails.length
        ? trails.map((t) => t.summary).join(" ")
        : `${c.agentSlice} limits do not apply to these processes.`,
      next: `Stop each process and start it again through the launcher that places it in ${c.agentSlice}.`,
      command: `systemd-run --user --slice=${c.agentSlice} --scope -- ${
        escaped[0].tool || "AGENT"
      }`,
      view: "Fleet",
      laneId: only(escaped),
      danger: true,
    });
  }
  const io = s.system.pressure.io?.some ?? null;
  const writer = topWriter(s.groups);
  if (io !== null && io > c.pressureAmber && writer) {
    const lane = s.lanes.find((l) => l.id === writer.path);
    const linkers = lane ? laneLinkers(s, lane, c) : 0;
    items.push({
      id: "disk",
      title: `Disk saturated: ${lane?.name ?? writer.name} writing ${bytes(
        writer.writeRate,
        c,
      )}/s`,
      detail: `Tasks stalled on storage ${percent(io)} of the recent window${
        linkers ? `, with ${linkers} linkers running in that lane` : ""
      }.`,
      next: "Lower the build job count for that lane until the stall percentage falls.",
      command: `cat ${c.cgroupRoot}/${writer.path}/io.stat`,
      view: lane ? "Fleet" : "Slices",
      laneId: lane?.id,
      danger: io > c.pressureRed,
    });
  }
  const swap = desktopSwap(s.groups, c);
  if (swap !== null && swap > c.swapFloor) {
    const holder = topSwapHolder(s.groups, c);
    const cache = sliceGroup(s.groups, c.agentSlice)?.cache ?? null;
    items.push({
      id: "desktop-swap",
      title: `Desktop swapped out: ${bytes(swap, c)} in ${c.desktopSlice}`,
      detail: `${
        holder ? `${holder.name} holds ${bytes(holder.swap, c)}. ` : ""
      }Agents hold ${bytes(cache, c)} of page cache, which the desktop cannot use.`,
      next: "Reduce concurrent build work, or cap the agent slice memory so the desktop keeps its pages.",
      command: `cat ${c.cgroupRoot}/${c.agentSlice}/memory.stat`,
      view: "Slices",
      danger: true,
    });
  }
  const capped = s.lanes.filter((l) => l.dangerous);
  if (capped.length)
    items.push({
      id: "memory-cap",
      title: `${capped.length} ${
        capped.length === 1 ? "lane has" : "lanes have"
      } a memory limit below ${bytes(c.memoryFloor, c)}: ${list(
        capped.map((l) => l.name),
      )}`,
      detail: "The limit can stop work before it finishes.",
      next: "Open the lane and check its effective memory.max against the parent slices.",
      command: `systemctl --user show ${c.agentSlice} -p MemoryMax`,
      view: "Fleet",
      laneId: only(capped),
      danger: true,
    });
  const stalling = s.lanes.filter(
    (l) => (lanePressure(l) ?? 0) > c.pressureAmber,
  );
  if (stalling.length)
    items.push({
      id: "stalls",
      title: `${stalling.length} ${
        stalling.length === 1 ? "lane is" : "lanes are"
      } stalling on a resource: ${list(stalling.map((l) => l.name))}`,
      detail: `Highest stall share ${percent(
        Math.max(...stalling.map((l) => lanePressure(l) ?? 0)),
      )} of the recent window.`,
      next: "Open Fleet and compare the CPU, memory and I/O pressure columns to find which resource is short.",
      view: "Fleet",
      laneId: only(stalling),
      danger: stalling.some((l) => (lanePressure(l) ?? 0) > c.pressureRed),
    });
  const near = s.groups.filter(
    (g) => g.memory !== null && g.high !== null && g.memory >= g.high * 0.9,
  );
  if (near.length)
    items.push({
      id: "memory-high",
      title: `${near.length} ${
        near.length === 1 ? "group is" : "groups are"
      } near the memory threshold: ${list(near.map((g) => g.name))}`,
      detail: "Memory reclaim can slow every task in these groups.",
      next: "Open Slices and raise memory.high, or reduce the work running there.",
      view: "Slices",
      danger: false,
    });
  const readOnly = s.storage.volumes.filter((v) => v.readOnly);
  if (readOnly.length)
    items.push({
      id: "read-only",
      title: `${readOnly.length} ${
        readOnly.length === 1 ? "mount is" : "mounts are"
      } read-only: ${list(readOnly.map((v) => v.mount))}`,
      detail: "Programs cannot save changes on these mounts.",
      next: "Open Storage, then check the kernel log for the error that forced the mount read-only.",
      view: "Storage",
      danger: true,
    });
  const failing = s.storage.volumes.filter((v) =>
    Object.values(v.delta).some((n) => n > 0),
  );
  if (failing.length)
    items.push({
      id: "device-errors",
      title: `New device errors on ${list(failing.map((v) => v.mount))}`,
      detail: "Device error counters increased since the previous sample.",
      next: "Open Storage and read the per-device counters before writing more data to these devices.",
      view: "Storage",
      danger: true,
    });
  const scrubs = s.storage.scrubs.filter((scrub) => scrub.problem);
  if (scrubs.length)
    items.push({
      id: "scrub",
      title: `${scrubs.length} filesystem ${
        scrubs.length === 1
          ? "scrub reports a problem"
          : "scrubs report problems"
      }`,
      detail: list(scrubs.map((scrub) => scrub.path)),
      next: "Open Storage and read the scrub report.",
      view: "Storage",
      danger: true,
    });
  const large = s.storage.scratch.filter(
    (scratch) => scratch.bytes !== null && scratch.bytes > c.scratchQuota,
  );
  if (large.length)
    items.push({
      id: "scratch",
      title: `${large.length} scratch ${
        large.length === 1 ? "directory exceeds" : "directories exceed"
      } the quota: ${list(large.map((scratch) => scratch.path))}`,
      detail: `Largest ${bytes(
        Math.max(...large.map((scratch) => scratch.bytes ?? 0)),
        c,
      )} against a quota of ${bytes(c.scratchQuota, c)}.`,
      next: "Open Storage and remove the scratch directories that finished work no longer needs.",
      view: "Storage",
      danger: false,
    });
  return items.sort((a, b) => Number(b.danger) - Number(a.danger));
}
/**
 * A source vsys cannot read is a vsys problem, not a system problem. It belongs
 * in a footer, counted once per source rather than once per failed read.
 */
export function sourceFooter(s: Snapshot): string | null {
  const sources = new Set(s.errors.map((e) => e.source));
  return sources.size
    ? `vsys cannot read ${sources.size} ${
        sources.size === 1 ? "source" : "sources"
      }; open Settings`
    : null;
}

export function Overview({
  snapshot: s,
  config: c,
  items,
  selected,
  onOpen,
}: {
  snapshot: Snapshot;
  config: Config;
  items: Attention[];
  selected: number;
  onOpen: (item: Attention) => void;
}) {
  const palette = themePalette(c.theme);
  const colour = (level: Level) =>
    level === "danger"
      ? palette.danger
      : level === "warn"
        ? palette.warning
        : palette.fg;
  const state = verdict(s, c);
  const gauges = meters(s, c, {
    bytes: (n) => bytes(n, c),
    percent,
  });
  const footer = sourceFooter(s);
  const row = (text: string) => (
    <text flexShrink={0} fg={palette.fg} wrapMode="word">
      {safe(text)}
    </text>
  );
  return (
    <box flexDirection="column" flexShrink={0} gap={1}>
      <box flexDirection="column" flexShrink={0}>
        <text
          flexShrink={0}
          wrapMode="word"
          fg={colour(state.level)}
          attributes={palette.selection}
        >
          {safe(state.headline)}
        </text>
        {row(state.detail)}
        {row("Overview: current system state")}
      </box>
      <box
        flexDirection="column"
        flexShrink={0}
        border
        borderColor={palette.fg}
        title="Resource use"
        paddingX={1}
      >
        {gauges.map((meter) => (
          <text
            key={meter.id}
            flexShrink={0}
            wrapMode="word"
            fg={colour(meter.level)}
          >
            {safe(`${meter.label}: ${meter.value} | ${meter.who}`)}
          </text>
        ))}
        {row("CPU 100% = one busy core. Threads can be idle.")}
      </box>
      <box flexDirection="column" flexShrink={0}>
        {row(`Needs attention now${items.length ? ` (${items.length})` : ""}`)}
        {!items.length &&
          row("No current problems detected in available data.")}
        {items.map((item, i) => (
          <box
            id={`attention-${i}`}
            key={item.id}
            flexDirection="column"
            flexShrink={0}
            marginBottom={1}
            onMouseDown={() => onOpen(item)}
          >
            <text
              flexShrink={0}
              wrapMode="word"
              fg={item.danger ? palette.danger : palette.warning}
              bg={i === selected ? palette.selected : undefined}
              attributes={i === selected ? palette.selection : undefined}
            >
              {safe(`${i === selected ? ">" : " "} ${item.title}`)}
            </text>
            {row(`  ${item.detail}`)}
            {row(`  Next: ${item.next}`)}
            {item.command !== undefined && row(`  Copy: ${item.command}`)}
            {row(`  Open ${item.laneId ? "lane" : item.view.toLowerCase()} >`)}
          </box>
        ))}
      </box>
      <box flexDirection="column" flexShrink={0}>
        {row("Find an answer")}
        {row(
          `${c.keys.fleet} Fleet: who is using resources?  ${c.keys.builds} Builds: what is compiling?`,
        )}
        {row(
          `${c.keys.storage} Storage: can programs save files?  ${c.keys.timeline} Timeline: what changed?`,
        )}
        {row(
          `${c.keys.alerts} Alerts: recorded events and missing data.  ${c.keys.settings} Settings: paths and preferences.`,
        )}
        {s.storage.scratchPending &&
          row(
            "Scratch measurement is in progress; other data continues to refresh.",
          )}
        {footer !== null && row(footer)}
      </box>
    </box>
  );
}
