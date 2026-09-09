import type { Config } from "../config/config";
import { safe } from "../model/export";
import { lanePressure } from "../model/lanes";
import type { Snapshot } from "../model/types";
import { point } from "../store/point";
import { bytes, percent } from "./format";
import { themePalette } from "./theme";

export interface Attention {
  id: string;
  title: string;
  detail: string;
  view: "Fleet" | "Storage" | "Alerts" | "Slices";
  laneId?: string;
  danger: boolean;
}
/** Current observations drive attention; historical rule hits can already be resolved. */
export function attention(s: Snapshot, c: Config): Attention[] {
  const items: Attention[] = [];
  for (const v of s.storage.volumes) {
    if (v.readOnly)
      items.push({
        id: `ro:${v.mount}`,
        title: `${v.mount} is read-only`,
        detail: "Programs cannot save changes on this mount.",
        view: "Storage",
        danger: true,
      });
    if (Object.values(v.delta).some((n) => n > 0))
      items.push({
        id: `errors:${v.mount}`,
        title: `${v.mount}: new device errors`,
        detail: "Device error counters increased since the previous sample.",
        view: "Storage",
        danger: true,
      });
  }
  for (const l of s.lanes) {
    const problems = [
      l.dangerous && "low memory limit",
      l.unconfined && "outside agent slice",
      (lanePressure(l) ?? 0) > c.pressureAmber && "resource stalls",
    ].filter(Boolean);
    if (problems.length)
      items.push({
        id: l.id,
        title: `${l.name}: ${problems.join(", ")}`,
        detail: l.dangerous
          ? "The memory limit can stop work. Open the lane to inspect its limits."
          : l.unconfined
            ? "Agent slice limits do not apply here. Inspect how this process was launched."
            : "Tasks are waiting for CPU, memory or storage. Inspect lane pressure.",
        view: "Fleet",
        laneId: l.id,
        danger:
          l.dangerous || l.unconfined || (lanePressure(l) ?? 0) > c.pressureRed,
      });
  }
  for (const g of s.groups) {
    if (g.memory !== null && g.high !== null && g.memory >= g.high * 0.9)
      items.push({
        id: `high:${g.path}`,
        title: `${g.name}: near memory threshold`,
        detail: "Memory reclaim can slow tasks in this group.",
        view: "Slices",
        danger: false,
      });
  }
  for (const scrub of s.storage.scrubs)
    if (scrub.problem)
      items.push({
        id: scrub.path,
        title: "Filesystem scrub needs attention",
        detail: scrub.path,
        view: "Storage",
        danger: true,
      });
  for (const scratch of s.storage.scratch)
    if (scratch.bytes !== null && scratch.bytes > c.scratchQuota)
      items.push({
        id: scratch.path,
        title: "Scratch storage exceeds its quota",
        detail: `${scratch.path}: ${bytes(scratch.bytes, c)}`,
        view: "Storage",
        danger: false,
      });
  if (s.errors.length)
    items.push({
      id: "sources",
      title: `${s.errors.length} source reads unavailable`,
      detail:
        "Some measurements are missing. Open Alerts to inspect the source errors.",
      view: "Alerts",
      danger: false,
    });
  return items.sort((a, b) => Number(b.danger) - Number(a.danger));
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
  const p = point(s, c);
  const builds = s.procs.filter((proc) => proc.build);
  const leastFree = s.storage.volumes
    .filter((v) => v.free !== null)
    .sort((a, b) => (a.free ?? 0) - (b.free ?? 0))[0];
  const row = (text: string) => (
    <text flexShrink={0} fg={palette.fg} wrapMode="word">
      {safe(text)}
    </text>
  );
  return (
    <box flexDirection="column" flexShrink={0} gap={1}>
      <box flexDirection="column" flexShrink={0}>
        {row("Overview: current system state")}
        {row(
          `${s.lanes.length} lanes | ${s.procs.filter((proc) => proc.tool).length} agent processes | ${builds.length} build processes`,
        )}
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
            {row(`  Open ${item.laneId ? "lane" : item.view.toLowerCase()} >`)}
          </box>
        ))}
      </box>
      <box
        flexDirection="column"
        flexShrink={0}
        border
        borderColor={palette.fg}
        title="Resource use"
        paddingX={1}
      >
        {row(
          `CPU: agents ${percent(p.agents)} | desktop ${percent(p.desktop)}`,
        )}
        {row(
          `Memory: ${bytes(p.memory, c)} used / ${bytes(s.system.memory.MemTotal, c)} total`,
        )}
        {row(
          `Build work: ${builds.reduce((n, proc) => n + proc.threads, 0)} threads / ${s.system.cores} CPU cores`,
        )}
        {row("CPU 100% = one busy core. Threads can be idle.")}
        {row(
          s.storage.mountsAvailable === false
            ? "Storage: mount information unavailable"
            : leastFree
              ? `Least free storage: ${bytes(leastFree.free, c)} at ${leastFree.mount}`
              : s.storage.volumes.length
                ? "Storage: free space unavailable"
                : "No watched Btrfs filesystems on this host.",
        )}
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
      </box>
    </box>
  );
}
