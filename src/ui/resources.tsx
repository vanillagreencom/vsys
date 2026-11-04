import { ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useState } from "react";
import type { Config } from "../config/config";
import { safe } from "../model/export";
import { coveringGroup, dangerousCap, effectiveMax } from "../model/lanes";
import { distinctNames, unitLabel } from "../model/naming";
import type { Group, Service, Snapshot } from "../model/types";
import { causes, type Level, meters } from "../model/verdict";
import { meterTile, type Target } from "./attention";
import { screenPad, sideWidth } from "./chrome";
import { type Column, cell, columnGap, columnsWidth } from "./columns";
import {
  age,
  amount,
  bytes,
  count,
  floorText,
  gap,
  percent,
  share,
  waitText,
} from "./format";
import { useScreenKeys } from "./keys";
import { firstRow, useSelection } from "./selection";
import {
  levelStatus,
  metric,
  type StatusWord,
  scrollbar,
  statusColor,
  ui,
} from "./theme";
import {
  Bar,
  Field,
  Ink,
  List,
  nextDown,
  Reading,
  Row,
  Section,
  SplitPane,
  sideGap,
  TableHeader,
  Tile,
  Tiles,
  tilesPerRow,
} from "./widgets";

/** A group with nothing running and little memory is noise until asked for. */
export function idle(g: Group): boolean {
  return (
    !g.name.endsWith(".slice") &&
    g.path !== "." &&
    (g.cpuPercent ?? 0) < 0.5 &&
    (g.memory ?? 0) < 64 * 1024 * 1024
  );
}
/** The rows Resources lists, in tree order, with idle leaves hidden unless asked. */
export function groupRows(s: Snapshot, all: boolean): Group[] {
  return s.groups.filter((g) => all || !idle(g));
}
/**
 * One selectable row: a group of the user manager's tree, or a system service
 * listed below it. A service sits under `cgroupTop` and a group under
 * `cgroupRoot`, so a path alone does not say which table holds it.
 */
export type ResourceRow =
  | { kind: "group"; path: string; group: Group }
  | { kind: "service"; path: string; service: Service };
/** The identity a row is selected and targeted by. */
const rowKey = (row: { kind: string; path: string }): string =>
  `${row.kind}:${row.path}`;
/** The displayed CPU reading, never a substitute for the hour-only cause. */
function serviceCpu(service: Service): number | null {
  if (!service.read) return null;
  return (
    service.cpuHourPercent ??
    (service.cpuSoFarMs !== null ? service.cpuSoFarPercent : null)
  );
}
/** Every selectable row in the order drawn: the groups, then the services busiest first. */
export function resourceRows(s: Snapshot, all: boolean): ResourceRow[] {
  const services = [...(s.services ?? [])].sort(
    (a, b) => (serviceCpu(b) ?? -1) - (serviceCpu(a) ?? -1),
  );
  return [
    ...groupRows(s, all).map(
      (group) => ({ kind: "group", path: group.path, group }) as const,
    ),
    ...services.map(
      (service) => ({ kind: "service", path: service.path, service }) as const,
    ),
  ];
}
/** What a system service's row says about its measured CPU window. */
export type ServiceState =
  | { kind: "unread"; level: "warn" }
  /** Read, with fewer than two checkpoints in this cgroup. */
  | { kind: "measuring"; level: "ok" }
  | { kind: "warming"; level: "ok"; average: number; spanMs: number }
  | { kind: "busy"; level: "warn"; hour: number; threshold: number }
  | { kind: "clear"; level: "ok"; hour: number };
/**
 * A service's state. `busy` is the units the service CPU cause raised, so the
 * row and the card are graded by one judgment.
 */
export function serviceState(
  service: Service,
  busy: ReadonlySet<string>,
  c: Config,
): ServiceState {
  if (!service.read) return { kind: "unread", level: "warn" };
  const hour = service.cpuHourPercent;
  if (hour === null) {
    const average = serviceCpu(service);
    return average !== null && service.cpuSoFarMs !== null
      ? {
          kind: "warming",
          level: "ok",
          average,
          spanMs: service.cpuSoFarMs,
        }
      : { kind: "measuring", level: "ok" };
  }
  return busy.has(service.path)
    ? { kind: "busy", level: "warn", hour, threshold: c.serviceCpuPercent }
    : { kind: "clear", level: "ok", hour };
}
const serviceWords: Record<ServiceState["kind"], StatusWord> = {
  unread: "unread",
  measuring: "measuring",
  warming: "warming",
  busy: "Warning",
  clear: "OK",
};
/** Mixed windows name their span so a warm-up reading cannot look like an hour. */
function serviceCpuText(state: ServiceState, allHours: boolean): string {
  switch (state.kind) {
    case "unread":
      return "unread";
    case "measuring":
      return "measuring";
    case "warming":
      return `${percent(state.average)} · ${age(state.spanMs / 1000)}`;
    case "busy":
    case "clear":
      return `${percent(state.hour)}${allHours ? "" : " · 1h"}`;
    default:
      return state satisfies never;
  }
}
function serviceStatusText(state: ServiceState): string {
  switch (state.kind) {
    case "unread":
      return `CPU use ${gap}: cpu.stat could not be read`;
    case "measuring":
      return "vsys needs two checkpoints to measure CPU use for this unit";
    case "warming": {
      const minutes = Math.floor(state.spanMs / 60_000);
      const remaining = Math.ceil((3_600_000 - state.spanMs) / 60_000);
      const hour =
        remaining > 0
          ? `the hour average needs ${remaining} more ${remaining === 1 ? "minute" : "minutes"}`
          : "the hour average needs a checkpoint 60 to 75 minutes old";
      return `averaged ${percent(state.average)} of one core over the last ${count(minutes, "minute")}; ${hour}`;
    }
    case "busy":
      return `averaged ${percent(state.hour)} of one core over the last hour, at or above ${percent(state.threshold)}`;
    case "clear":
      return `averaged ${percent(state.hour)} of one core over the last hour`;
    default:
      return state satisfies never;
  }
}
/**
 * The name each group shows, distinct across the whole tree. Three scopes of
 * one program decode to one word, so the parent separates them where it
 * differs and the first process id always does. Hiding idle rows never
 * renames a row, because the names are settled over every group.
 */
export function groupLabels(groups: Group[]): Map<string, string> {
  const byPath = new Map(groups.map((g) => [g.path, g]));
  const parent = (g: Group) => {
    const above = byPath.get(g.parent);
    return above && above !== g ? unitLabel(above.name) : "";
  };
  const names = distinctNames(groups, (g) => unitLabel(g.name), [
    (g) => (parent(g) ? `in ${parent(g)}` : ""),
    (g) => (g.pids[0] ? `PID ${g.pids[0]}` : ""),
    (g) => g.path,
  ]);
  return new Map(
    groups.map((g, i) => {
      const name = names[i];
      if (name === undefined)
        throw new Error(`distinctNames returned no name for group ${g.path}`);
      return [g.path, name];
    }),
  );
}
/**
 * How deep a path sits. A group's parent is its own path with the last segment
 * removed, so the segments count the ancestors: `.` is the root and `a/b` sits
 * two below it. This is the only measure of depth left when the parent's own
 * row is missing, because the chain of `parent` links stops there.
 */
const depth = (path: string): number =>
  path === "." ? 0 : path.split("/").length;
/**
 * The glyphs that draw one row's depth. A row knows whether it is the last
 * child of its parent, and every ancestor whose own subtree has ended leaves
 * blank rather than a trunk, so the lines join what is actually nested.
 */
export function treePrefixes(groups: Group[]): Map<string, string> {
  const present = new Set(groups.map((g) => g.path));
  const children = new Map<string, Group[]>();
  for (const g of groups) {
    if (g.parent === g.path) continue;
    const list = children.get(g.parent);
    if (list) list.push(g);
    else children.set(g.parent, [g]);
  }
  const prefixes = new Map<string, string>();
  const walk = (path: string, trunk: string) => {
    const kids = children.get(path) ?? [];
    kids.forEach((child, i) => {
      const last = i === kids.length - 1;
      prefixes.set(child.path, `${trunk}${last ? "└─ " : "├─ "}`);
      walk(child.path, `${trunk}${last ? "   " : "│  "}`);
    });
  };
  for (const g of groups)
    if (g.parent === g.path) {
      prefixes.set(g.path, "");
      walk(g.path, "");
    }
  // A parent can have no row here: its own cgroup read failed, or it was
  // filtered out as idle while a child was not. Its children are still listed,
  // and giving them the root's empty prefix would draw a nesting the machine
  // does not have — every disconnected subtree flattened onto one level. Each
  // missing parent starts its own subtree instead, indented to the depth its
  // path states, and its descendants walk from there as any others do.
  for (const [parent, kids] of children)
    if (!present.has(parent) && kids.length)
      walk(parent, "   ".repeat(depth(parent)));
  return prefixes;
}
/** What gives a group its warning or error status, with the numbers that tripped it. */
export type GroupCause =
  | { kind: "unconfined"; level: "danger" }
  | { kind: "cap"; level: "danger"; cap: number; floor: number }
  | {
      kind: "pressure";
      level: "danger" | "warn";
      resource: string;
      some: number;
      threshold: number;
    }
  | { kind: "high"; level: "warn"; memory: number; high: number }
  | { kind: "unread"; level: "warn" };
/**
 * Whether a group is a lane or holds one. A group-less lane carries its
 * process's absolute kernel path, which resolves to its covering group first,
 * as it does when the model decides the lane's own cap.
 */
function holdsLane(g: Group, s: Snapshot): boolean {
  return s.lanes.some((l) => {
    const path = l.cgroup.startsWith("/")
      ? coveringGroup(s.groups, l.cgroup)?.path
      : l.cgroup;
    return (
      path !== undefined &&
      (g.path === "." || path === g.path || path.startsWith(`${g.path}/`))
    );
  });
}
/**
 * The worst thing about a group. A cap under the floor is dangerous only to an
 * agent lane, which it kills mid-build; a service capped on purpose is not one.
 */
export function groupCause(
  g: Group,
  s: Snapshot,
  c: Config,
): GroupCause | null {
  if (s.lanes.some((l) => l.id === g.path && l.unconfined))
    return { kind: "unconfined", level: "danger" };
  const cap = effectiveMax(s.groups, g.path).max;
  if (
    cap !== null &&
    dangerousCap(g, s.groups, c.memoryFloor) &&
    holdsLane(g, s)
  )
    return { kind: "cap", level: "danger", cap, floor: c.memoryFloor };
  let worst: { resource: string; some: number } | null = null;
  for (const [resource, p] of Object.entries(g.pressure))
    if (p && (worst === null || p.some > worst.some))
      worst = { resource, some: p.some };
  if (worst && worst.some > c.pressureRed)
    return {
      kind: "pressure",
      level: "danger",
      ...worst,
      threshold: c.pressureRed,
    };
  if (worst && worst.some > c.pressureAmber)
    return {
      kind: "pressure",
      level: "warn",
      ...worst,
      threshold: c.pressureAmber,
    };
  if (g.memory !== null && g.high !== null && g.memory >= g.high * 0.9)
    return { kind: "high", level: "warn", memory: g.memory, high: g.high };
  if (
    Object.values(g.pressure).some((p) => p === null) ||
    (g.memory === null && g.high !== null)
  )
    return { kind: "unread", level: "warn" };
  return null;
}
export function groupLevel(g: Group, s: Snapshot, c: Config): Level {
  return groupCause(g, s, c)?.level ?? "ok";
}
function causeText(cause: GroupCause | null, c: Config): string {
  if (cause === null) return "OK";
  switch (cause.kind) {
    case "unconfined":
      return "agent outside the agent slice";
    case "cap":
      return floorText(cause.cap, cause.floor, c);
    case "pressure":
      return waitText(cause.resource, cause.some, cause.threshold);
    case "high":
      return `memory ${bytes(cause.memory, c)} past 90% of memory high ${bytes(cause.high, c)}`;
    case "unread":
      return `a threshold reading is ${gap}`;
    default:
      return cause satisfies never;
  }
}

function quotaText(raw: string | null): string {
  if (raw === null) return gap;
  const [quota, period] = raw.trim().split(/\s+/);
  if (quota === "max") return "no limit";
  const q = Number(quota),
    p = Number(period);
  return quota === undefined ||
    period === undefined ||
    !Number.isFinite(q) ||
    !Number.isFinite(p) ||
    p <= 0
    ? gap
    : `${share((q / p) * 100)} of one core`;
}

/**
 * The machine's meters, then the resource groups as a tree, then the system
 * services with their hour average, or their average so far while it fills.
 */
export function Resources({
  snapshot: s,
  config: c,
  height,
  width,
  target,
  onTargetUsed,
  onNotice,
}: {
  snapshot: Snapshot;
  config: Config;
  height: number;
  width: number;
  /** The group or service a card asked this screen to land on. */
  target: Extract<Target, { kind: "group" | "service" }> | null;
  onTargetUsed: () => void;
  onNotice: (text: string, level: Level) => void;
}) {
  const [selection, setSelection] = useState(firstRow);
  const [all, setAll] = useState(false);
  const renderer = useRenderer();
  const items = resourceRows(s, all);
  const rows = groupRows(s, all);
  const services = items.filter((row) => row.kind === "service");
  const { selected, choose, move } = useSelection(
    items.map(rowKey),
    selection,
    setSelection,
  );
  // Find a card’s target before acknowledging it: a refresh can remove the row,
  // and the reader must hear that refusal. Consume the request either way so it
  // cannot fire on a later sample.
  useEffect(() => {
    if (target === null) return;
    const key = rowKey(target);
    const at = resourceRows(s, all).findIndex((row) => rowKey(row) === key);
    // Only a group can be hidden, and the groups come first, so its index
    // among every group is its row once they are all shown.
    const hidden =
      target.kind === "group"
        ? s.groups.findIndex((g) => g.path === target.path)
        : -1;
    if (at >= 0) choose(at);
    else if (hidden >= 0) {
      setAll(true);
      setSelection({ index: hidden, id: key });
    } else onNotice(`${target.path} is no longer in the sample`, "warn");
    onTargetUsed();
  }, [target, onTargetUsed, onNotice, s, all, choose]);
  const hidden = s.groups.length - rows.length;
  useScreenKeys((name, key) => {
    if (name === "pageup" || name === "pagedown") {
      const fields =
        renderer.root.findDescendantById("resource-fields") ??
        renderer.root.findDescendantById("split-detail");
      if (fields instanceof ScrollBoxRenderable) {
        key.preventDefault();
        fields.scrollBy(name === "pagedown" ? 1 : -1, "viewport");
        return true;
      }
    }
    if (name === c.keys.down || name === "down") {
      move((i) => nextDown(items.length, i));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      move((i) => Math.max(0, i - 1));
      return true;
    }
    if (name === c.keys.details) {
      setAll((v) => !v);
      setSelection(firstRow);
      return true;
    }
    return false;
  });
  const tiles = meters(s, c)
    .filter((m) => m.id !== "builds")
    .map((m) => meterTile(m, s, c));
  const labels = groupLabels(s.groups);
  const prefixes = treePrefixes(rows);
  const limit = (v: number | null) => (v === null ? "no limit" : bytes(v, c));
  const { SwapTotal, SwapFree } = s.system.memory;
  const swapUsed =
    SwapTotal === undefined || SwapFree === undefined
      ? null
      : SwapTotal - SwapFree;
  const current = items[selected];
  const currentGroup = current?.kind === "group" ? current.group : undefined;
  const currentCause = currentGroup ? groupCause(currentGroup, s, c) : null;
  const busy = new Set(
    causes(s, c)
      .find((cause) => cause.id === "service-cpu")
      ?.groups.map((unit) => unit.path),
  );
  const currentState =
    current?.kind === "service"
      ? serviceState(current.service, busy, c)
      : undefined;
  const topCpu = Math.max(100, ...rows.map((g) => g.cpuPercent ?? 0));
  const topMemory = Math.max(1, ...rows.map((g) => g.memory ?? 0));
  const cpuBar: Column = { label: "", width: 8 };
  const cpuColumn: Column = { label: "CPU %/core", width: 10, align: "right" };
  const memoryBar: Column = { label: "", width: 8 };
  const memoryColumn: Column = { label: "Memory", width: 10, align: "right" };
  const side = current ? sideWidth(width) : 0;
  const listWidth = width - side - (side ? sideGap : 0);
  const bars = listWidth >= 100;
  const tasksColumn: Column = {
    label: "Tasks",
    width: bars ? 14 : 7,
    align: "right",
  };
  const statusColumn: Column = { label: "State", width: 9 };
  const fixed: Column[] = [
    ...(bars ? [cpuBar] : []),
    cpuColumn,
    ...(bars ? [memoryBar] : []),
    memoryColumn,
    tasksColumn,
    statusColumn,
  ];
  // The screen padding and the marker take five columns, and the name is
  // joined to the fixed columns by one more gap.
  const nameColumn: Column = {
    label: "Group",
    width: Math.max(
      12,
      Math.min(44, listWidth - 5 - columnsWidth(fixed) - columnGap.length),
    ),
  };
  const groupColumns: Column[] = [nameColumn, ...fixed];
  const allHours = services.every((row) => row.service.cpuHourPercent !== null);
  const serviceCpuColumn: Column = {
    label: allHours ? "Hour avg %/core" : "CPU %/core",
    width: 16,
    align: "right",
  };
  const serviceColumn: Column = { ...nameColumn, label: "Service" };
  const serviceColumns: Column[] = [
    serviceColumn,
    cpuBar,
    serviceCpuColumn,
    statusColumn,
  ];
  const topServiceCpu = Math.max(
    100,
    ...services.map((row) => serviceCpu(row.service) ?? 0),
  );
  const inner = width - 4;
  // The meters that are not builds, and the Swap tile beside them.
  const tileCount = tiles.length + 1;
  const tileRows = Math.ceil(tileCount / tilesPerRow(tileCount, inner));
  // Each tile row is three lines and the rows sit one line apart; then the
  // blank under them, the section with its margin, the table heading, and,
  // where the detail is stacked, the scrollable fields and their margin.
  const detailHeight = Math.min(
    currentGroup ? 14 : 5,
    Math.max(4, height - (4 * tileRows - 1) - s.system.zram.length - 12),
  );
  const listHeight =
    height -
    (4 * tileRows - 1) -
    (s.system.zram.length ? s.system.zram.length : 0) -
    1 -
    2 -
    1 -
    (side ? 0 : detailHeight + 1);
  // The services table's heading, its margin and its column heading take
  // three rows. It takes the rows its list needs while the groups' list needs
  // fewer than the rest, and never under a third. A list draws one row, and
  // its counter when it holds more, whatever height it is given, so each
  // keeps that much. Where both cannot, only the table holding the selection
  // is drawn, so the lists never push the detail off the screen.
  const shared = listHeight - 3;
  const least = (n: number) => Math.min(Math.max(n, 1), 2);
  const both = shared >= least(rows.length) + least(services.length);
  const servicesHeight = Math.max(
    least(services.length),
    Math.min(
      shared - least(rows.length),
      services.length + 1,
      Math.max(Math.floor(shared / 3), shared - (rows.length + 1)),
    ),
  );
  const showGroups = both || current?.kind !== "service";
  const showServices = both || current?.kind === "service";
  // A table drawn alone names the other in its heading, so the reader knows
  // the arrows walk on into it.
  const servicesBelow =
    !showServices && services.length
      ? ` · ${count(services.length, "system service")} below`
      : "";
  const groupsAbove =
    !showGroups && rows.length ? ` · ${count(rows.length, "group")} above` : "";
  const selectedDetail =
    current?.kind === "service" && currentState ? (
      <>
        <Field label="Unit" value={current.service.name} wrap={side > 0} />
        <Field
          label="Status"
          value={serviceWords[currentState.kind]}
          color={statusColor(serviceWords[currentState.kind])}
          wrap={side > 0}
        />
        <Field
          label="CPU use"
          value={serviceStatusText(currentState)}
          wrap={side > 0}
        />
        <Field
          label="Cgroup"
          value={`${c.cgroupTop}/${current.path}`}
          wrap={side > 0}
        />
      </>
    ) : (
      currentGroup && (
        <>
          <Field label="Unit" value={currentGroup.name} wrap={side > 0} />
          <Field
            label="Status"
            value={levelStatus(currentCause?.level ?? "ok")}
            color={statusColor(levelStatus(currentCause?.level ?? "ok"))}
            wrap={side > 0}
          />
          {currentCause && (
            <Field
              label="Reason"
              value={causeText(currentCause, c)}
              wrap={side > 0}
            />
          )}
          {[
            [
              "Memory high",
              currentGroup.highRead ? limit(currentGroup.high) : gap,
            ],
            [
              "Memory max",
              currentGroup.maxRead ? limit(currentGroup.max) : gap,
            ],
            [
              "Swap",
              `${amount(currentGroup.swap, c)} used; ${currentGroup.swapMaxRead ? (currentGroup.swapMax === null ? "no limit" : `limit ${bytes(currentGroup.swapMax, c)}`) : gap}`,
            ],
            [
              "Tasks max",
              currentGroup.tasksMaxRead
                ? String(currentGroup.tasksMax ?? "no limit")
                : gap,
            ],
            ["CPU weight", String(currentGroup.weight ?? gap)],
            ["CPU quota", quotaText(currentGroup.cpuMax)],
            ["Page cache", amount(currentGroup.cache, c)],
            [
              "Written",
              currentGroup.writeRate === null
                ? gap
                : `${bytes(currentGroup.writeRate, c)}/s`,
            ],
            ["CPU wait", percent(currentGroup.pressure.cpu?.some)],
            ["Memory wait", percent(currentGroup.pressure.memory?.some)],
            ["Disk wait", percent(currentGroup.pressure.io?.some)],
          ].map(([label, value]) => (
            <Field
              key={label}
              label={label ?? ""}
              value={value ?? gap}
              wrap={side > 0}
            />
          ))}
        </>
      )
    );
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingX={screenPad}>
      <Tiles width={inner}>
        {tiles.map((tile) => (
          <Tile
            key={tile.label}
            label={tile.label}
            value={tile.value}
            level={tile.level}
            detail={tile.detail}
          />
        ))}
        <Tile
          key="Swap"
          label="Swap"
          value={amount(swapUsed, c)}
          detail={`of ${amount(s.system.memory.SwapTotal ?? null, c)}${s.system.zram
            .map(
              (z) =>
                `\n${z.device}: ${bytes(z.original, c)} compressed to ${bytes(z.compressed, c)}`,
            )
            .join("")}`}
        />
      </Tiles>
      {/* The blank under the tiles and the section's own margin, outside the
          pane so the list's heading and the panel's start on one row. */}
      <box height={2} flexShrink={0} />
      <SplitPane
        side={side}
        item={current && rowKey(current)}
        below
        detail={
          side ? (
            selectedDetail
          ) : (
            <scrollbox
              id="resource-fields"
              key={current && rowKey(current)}
              height={detailHeight}
              scrollY
              scrollbarOptions={scrollbar}
              contentOptions={{ flexShrink: 0 }}
            >
              {selectedDetail}
            </scrollbox>
          )
        }
      >
        {showGroups && (
          <>
            <Section
              title="Groups"
              width={listWidth - 4}
              marginTop={0}
              focused={current?.kind === "group"}
              count={`${rows.length}${hidden ? ` shown · ${hidden} idle hidden · ${c.keys.details} shows all` : ""}${servicesBelow}`}
            />
            <TableHeader columns={groupColumns} />
            <List
              items={rows}
              selected={current?.kind === "group" ? selected : -1}
              height={both ? shared - servicesHeight : listHeight}
              onSelect={choose}
              empty="No resource group could be read."
              render={(g, i, isSelected) => {
                const name = `${prefixes.get(g.path) ?? ""}${labels.get(g.path) ?? unitLabel(g.name)}`;
                return (
                  <Row
                    key={g.path}
                    selected={isSelected}
                    onOpen={() => choose(i)}
                  >
                    {safe(cell(nameColumn, name))}
                    {bars && (
                      <>
                        {columnGap}
                        <Bar
                          value={g.cpuPercent}
                          max={topCpu}
                          width={cpuBar.width}
                          color={metric.cpu}
                        />
                      </>
                    )}
                    {columnGap}
                    <Reading
                      value={g.cpuPercent}
                      text={cell(cpuColumn, share(g.cpuPercent))}
                    />
                    {bars && (
                      <>
                        {columnGap}
                        <Bar
                          value={g.memory}
                          max={topMemory}
                          width={memoryBar.width}
                          color={metric.memory}
                        />
                      </>
                    )}
                    {columnGap}
                    <Reading
                      value={g.memory}
                      text={cell(memoryColumn, amount(g.memory, c))}
                    />
                    {columnGap}
                    <span attributes={ui.dim}>
                      {cell(tasksColumn, String(g.tasks ?? gap))}
                    </span>
                    {columnGap}
                    <Ink color={statusColor(levelStatus(groupLevel(g, s, c)))}>
                      {cell(statusColumn, levelStatus(groupLevel(g, s, c)))}
                    </Ink>
                  </Row>
                );
              }}
            />
          </>
        )}
        {showServices && (
          <>
            <Section
              title="System services"
              marginTop={both ? 1 : 0}
              width={listWidth - 4}
              focused={current?.kind === "service"}
              count={
                s.services === null
                  ? undefined
                  : `${services.length}${groupsAbove}`
              }
            />
            <TableHeader columns={serviceColumns} />
            <List
              items={services}
              selected={
                current?.kind === "service" ? selected - rows.length : -1
              }
              height={both ? servicesHeight : listHeight}
              onSelect={(i) => choose(rows.length + i)}
              empty={
                s.services === null
                  ? `${c.cgroupTop}/system.slice could not be listed.`
                  : "No system service has been read yet."
              }
              render={({ service }, i, isSelected) => {
                const state = serviceState(service, busy, c);
                const cpu = serviceCpu(service);
                return (
                  <Row
                    key={rowKey({ kind: "service", path: service.path })}
                    selected={isSelected}
                    onOpen={() => choose(rows.length + i)}
                  >
                    {safe(cell(serviceColumn, unitLabel(service.name)))}
                    {columnGap}
                    <Bar
                      value={cpu}
                      max={topServiceCpu}
                      width={cpuBar.width}
                      color={metric.cpu}
                    />
                    {columnGap}
                    <Reading
                      value={cpu}
                      text={cell(
                        serviceCpuColumn,
                        serviceCpuText(state, allHours),
                      )}
                    />
                    {columnGap}
                    <Ink color={statusColor(serviceWords[state.kind])}>
                      {cell(statusColumn, serviceWords[state.kind])}
                    </Ink>
                  </Row>
                );
              }}
            />
          </>
        )}
      </SplitPane>
    </box>
  );
}
