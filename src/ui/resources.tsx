import { useEffect, useState } from "react";
import type { Config } from "../config/config";
import { safe } from "../model/export";
import { coveringGroup, dangerousCap, effectiveMax } from "../model/lanes";
import { distinctNames, unitLabel } from "../model/naming";
import type { Group, Snapshot } from "../model/types";
import { type Level, meters } from "../model/verdict";
import { meterTile } from "./attention";
import { screenPad, sideWidth } from "./chrome";
import { type Column, cell, columnGap, columnsWidth } from "./columns";
import {
  amount,
  bytes,
  floorText,
  gap,
  percent,
  share,
  waitText,
} from "./format";
import { useScreenKeys } from "./keys";
import { firstRow, useSelection } from "./selection";
import { levelColor, metric, ui } from "./theme";
import {
  Bar,
  Field,
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
/** What made a group's row red or amber, with the numbers that tripped it. */
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
  if (cause === null) return "nothing over a threshold";
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

/** The machine's meters, then the resource groups as a tree. */
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
  /** The group path a card asked this screen to land on. */
  target: string | null;
  onTargetUsed: () => void;
  onNotice: (text: string, level: Level) => void;
}) {
  const [selection, setSelection] = useState(firstRow);
  const [all, setAll] = useState(false);
  const rows = groupRows(s, all);
  const { selected, choose, move } = useSelection(
    rows.map((g) => g.path),
    selection,
    setSelection,
  );
  // A card that names a group lands on it. An idle group is not in the rows
  // until they are all shown, so the target opens them. The group is found
  // before the request is acknowledged, because a collector refresh between
  // the keypress and this effect can remove it; acknowledging first dropped
  // the request in silence. The request is still consumed either way, so
  // opening the same card twice lands twice.
  useEffect(() => {
    if (target === null) return;
    const at = groupRows(s, all).findIndex((g) => g.path === target);
    const hidden = s.groups.findIndex((g) => g.path === target);
    if (at >= 0) choose(at);
    else if (hidden >= 0) {
      setAll(true);
      setSelection({ index: hidden, id: target });
    } else onNotice(`${target} is no longer in the sample`, "warn");
    onTargetUsed();
  }, [target, onTargetUsed, onNotice, s, all, choose]);
  const hidden = s.groups.length - rows.length;
  useScreenKeys((name) => {
    if (name === c.keys.down || name === "down") {
      move((i) => nextDown(rows.length, i));
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
  const limit = (v: number | null) => (v === null ? "none" : bytes(v, c));
  const { SwapTotal, SwapFree } = s.system.memory;
  const swapUsed =
    SwapTotal === undefined || SwapFree === undefined
      ? null
      : SwapTotal - SwapFree;
  const current = rows[selected];
  const currentCause = current ? groupCause(current, s, c) : null;
  const topCpu = Math.max(100, ...rows.map((g) => g.cpuPercent ?? 0));
  const topMemory = Math.max(1, ...rows.map((g) => g.memory ?? 0));
  const cpuBar: Column = { label: "", width: 8 };
  const cpuColumn: Column = { label: "CPU", width: 7, align: "right" };
  const memoryBar: Column = { label: "", width: 8 };
  const memoryColumn: Column = { label: "Memory", width: 10, align: "right" };
  const tasksColumn: Column = { label: "Tasks", width: 14, align: "right" };
  const fixed: Column[] = [
    cpuBar,
    cpuColumn,
    memoryBar,
    memoryColumn,
    tasksColumn,
  ];
  const side = current ? sideWidth(width) : 0;
  const listWidth = width - side - (side ? sideGap : 0);
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
  const inner = width - 4;
  // The meters that are not builds, and the Swap tile beside them.
  const tileCount = tiles.length + 1;
  const tileRows = Math.ceil(tileCount / tilesPerRow(tileCount, inner));
  // Each tile row is three lines and the rows sit one line apart; then the
  // blank under them, the section with its margin, the table heading, and,
  // where the detail is not beside the list, its five fields and their margin.
  const listHeight = height - (4 * tileRows - 1) - 1 - 2 - 1 - (side ? 0 : 6);
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
                ` · ${z.device} ${bytes(z.original, c)} in ${bytes(z.compressed, c)}`,
            )
            .join("")}`}
        />
      </Tiles>
      {/* The blank under the tiles and the section's own margin, outside the
          pane so the list's heading and the panel's start on one row. */}
      <box height={2} flexShrink={0} />
      <SplitPane
        side={side}
        item={current?.path}
        below
        detail={
          current && (
            <>
              <Field label="Unit" value={current.name} wrap={side > 0} />
              <Field
                label="Status"
                value={causeText(currentCause, c)}
                color={
                  currentCause ? levelColor(currentCause.level) : undefined
                }
                wrap={side > 0}
              />
              <Field
                label="Limits"
                value={`memory high ${current.highRead ? limit(current.high) : gap} · max ${current.maxRead ? limit(current.max) : gap} · swap ${amount(current.swap, c)} of ${current.swapMaxRead ? limit(current.swapMax) : gap} · tasks max ${current.tasksMaxRead ? (current.tasksMax ?? "none") : gap}`}
                wrap={side > 0}
              />
              <Field
                label="CPU"
                value={`weight ${current.weight ?? gap} · quota ${current.cpuMax ?? gap} · page cache ${amount(current.cache, c)} · written ${current.writeRate === null ? gap : `${bytes(current.writeRate, c)}/s`}`}
                wrap={side > 0}
              />
              <Field
                label="Waiting"
                value={Object.entries(current.pressure)
                  .map(([kind, p]) => `${kind} ${percent(p?.some)}`)
                  .join(" · ")}
                wrap={side > 0}
              />
            </>
          )
        }
      >
        <Section
          title="Groups"
          width={listWidth - 4}
          marginTop={0}
          count={`${rows.length}${hidden ? ` shown · ${hidden} idle hidden · ${c.keys.details} shows all` : ""}`}
        />
        <TableHeader columns={groupColumns} />
        <List
          items={rows}
          selected={selected}
          height={listHeight}
          onSelect={choose}
          empty="No resource group could be read."
          render={(g, i, isSelected) => {
            const name = `${prefixes.get(g.path) ?? ""}${labels.get(g.path) ?? unitLabel(g.name)}`;
            return (
              <Row
                key={g.path}
                selected={isSelected}
                color={levelColor(groupLevel(g, s, c))}
                onOpen={() => choose(i)}
              >
                {safe(cell(nameColumn, name))}
                {columnGap}
                <Bar
                  value={g.cpuPercent}
                  max={topCpu}
                  width={cpuBar.width}
                  color={metric.cpu}
                />
                {columnGap}
                <Reading
                  value={g.cpuPercent}
                  text={cell(cpuColumn, share(g.cpuPercent))}
                />
                {columnGap}
                <Bar
                  value={g.memory}
                  max={topMemory}
                  width={memoryBar.width}
                  color={metric.memory}
                />
                {columnGap}
                <Reading
                  value={g.memory}
                  text={cell(memoryColumn, amount(g.memory, c))}
                />
                {columnGap}
                <span attributes={ui.dim}>
                  {cell(tasksColumn, `${g.tasks ?? gap} tasks`)}
                </span>
              </Row>
            );
          }}
        />
      </SplitPane>
    </box>
  );
}
