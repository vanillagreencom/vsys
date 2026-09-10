import { useState } from "react";
import type { Config } from "../config/config";
import { safe } from "../model/export";
import { dangerousCap } from "../model/lanes";
import { distinctNames, unitLabel } from "../model/naming";
import type { Group, Snapshot } from "../model/types";
import { type Level, meters } from "../model/verdict";
import { meterTile } from "./attention";
import { type Column, cell, columnGap, columnsWidth } from "./columns";
import { amount, bytes, gap, percent, share } from "./format";
import { useScreenKeys } from "./keys";
import { levelColor, metric, ui } from "./theme";
import {
  Bar,
  Field,
  List,
  nextDown,
  Reading,
  Row,
  Section,
  TableHeader,
  Tile,
  Tiles,
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
  return new Map(groups.map((g, i) => [g.path, names[i]]));
}
/**
 * The glyphs that draw one row's depth. A row knows whether it is the last
 * child of its parent, and every ancestor whose own subtree has ended leaves
 * blank rather than a trunk, so the lines join what is actually nested.
 */
export function treePrefixes(groups: Group[]): Map<string, string> {
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
    if (!prefixes.has(g.path) && g.parent === g.path) prefixes.set(g.path, "");
  for (const g of groups) if (g.parent === g.path) walk(g.path, "");
  // A row whose parent was filtered out of this list still needs a prefix.
  for (const g of groups) if (!prefixes.has(g.path)) prefixes.set(g.path, "");
  return prefixes;
}
export function groupLevel(g: Group, s: Snapshot, c: Config): Level {
  if (
    dangerousCap(g, s.groups, c.memoryFloor) ||
    s.lanes.some((l) => l.id === g.path && l.unconfined)
  )
    return "danger";
  const worst = Math.max(...Object.values(g.pressure).map((p) => p?.some ?? 0));
  if (worst > c.pressureRed) return "danger";
  if (worst > c.pressureAmber) return "warn";
  if (g.memory !== null && g.high !== null && g.memory >= g.high * 0.9)
    return "warn";
  return "ok";
}

/** The machine's meters, then the resource groups as a tree. */
export function Resources({
  snapshot: s,
  config: c,
  height,
  width,
}: {
  snapshot: Snapshot;
  config: Config;
  height: number;
  width: number;
}) {
  const [selected, setSelected] = useState(0);
  const [all, setAll] = useState(false);
  const rows = groupRows(s, all);
  const hidden = s.groups.length - rows.length;
  useScreenKeys((name) => {
    if (name === c.keys.down || name === "down") {
      setSelected((i) => nextDown(rows.length, i));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      setSelected((i) => Math.max(0, i - 1));
      return true;
    }
    if (name === c.keys.details) {
      setAll((v) => !v);
      setSelected(0);
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
  const current = rows[Math.min(selected, rows.length - 1)];
  const topCpu = Math.max(100, ...rows.map((g) => g.cpuPercent ?? 0));
  const topMemory = Math.max(1, ...rows.map((g) => g.memory ?? 0));
  const fixed: Column[] = [
    { label: "", width: 8 },
    { label: "CPU", width: 7, align: "right" as const },
    { label: "", width: 8 },
    { label: "Memory", width: 10, align: "right" as const },
    { label: "Tasks", width: 14, align: "right" as const },
  ];
  const groupColumns: Column[] = [
    {
      label: "Group",
      width: Math.max(12, Math.min(44, width - 5 - columnsWidth(fixed))),
    },
    ...fixed,
  ];
  const [nameColumn, cpuBar, cpuColumn, memoryBar, memoryColumn, tasksColumn] =
    groupColumns;
  // The tile row and its blank, the section, the table heading, and the
  // detail block under the list.
  const listHeight = height - 5 - 3 - 4;
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingX={2}>
      <Tiles>
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
      <box height={1} flexShrink={0} />
      <Section
        title="Groups"
        width={width - 4}
        count={`${rows.length}${hidden ? ` shown · ${hidden} idle hidden · ${c.keys.details} shows all` : ""}`}
      />
      <TableHeader columns={groupColumns} />
      <List
        items={rows}
        selected={selected}
        height={listHeight}
        empty="No resource group could be read."
        render={(g, i, isSelected) => {
          const name = `${prefixes.get(g.path) ?? ""}${labels.get(g.path) ?? unitLabel(g.name)}`;
          return (
            <Row
              key={g.path}
              selected={isSelected}
              color={levelColor(groupLevel(g, s, c))}
              onOpen={() => setSelected(i)}
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
      {current && (
        <box flexDirection="column" flexShrink={0} marginTop={1}>
          <Field label="Unit" value={current.name} />
          <Field
            label="Limits"
            value={`memory high ${limit(current.high)} · max ${current.maxRead ? limit(current.max) : gap} · swap ${amount(current.swap, c)} of ${limit(current.swapMax)} · tasks max ${current.tasksMax ?? "none"}`}
          />
          <Field
            label="CPU"
            value={`weight ${current.weight ?? gap} · quota ${current.cpuMax ?? gap} · page cache ${amount(current.cache, c)} · written ${current.writeRate === null ? gap : `${bytes(current.writeRate, c)}/s`}`}
          />
          <Field
            label="Waiting"
            value={Object.entries(current.pressure)
              .map(([kind, p]) => `${kind} ${percent(p?.some)}`)
              .join(" · ")}
          />
        </box>
      )}
    </box>
  );
}
