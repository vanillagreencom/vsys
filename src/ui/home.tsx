import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import type { Config } from "../config/config";
import { safe } from "../model/export";
import type { Lane, Snapshot } from "../model/types";
import { type Level, type Meter, meters } from "../model/verdict";
import type { TimelineEvent } from "../store/events";
import type { Point } from "../store/point";
import {
  type Attention,
  meterTile,
  type Target,
  verdictItem,
  verdictLine,
} from "./attention";
import { keyLabel, type View, wideWidth } from "./chrome";
import { type Column, cell, columnGap, columnsWidth } from "./columns";
import {
  amount,
  bucketPeaks,
  plural,
  share,
  sortLanes,
  sparkline,
} from "./format";
import { useScreenKeys } from "./keys";
import { levelColor, metric, scrollbar, ui } from "./theme";
import { eventParts } from "./timeline";
import {
  Bar,
  Empty,
  Line,
  nextDown,
  Reading,
  Row,
  Section,
  TableHeader,
  Tile,
  Tiles,
  tilesPerRow,
} from "./widgets";

/** The Home list mixes concerns, changes and agents; Enter opens the selected one. */
export type HomeItem =
  | { kind: "concern"; item: Attention }
  | { kind: "change"; event: TimelineEvent }
  | { kind: "agent"; lane: Lane };
/** How many recent changes Home lists, newest first. */
export const recentChanges = 3;
export function homeItems(
  items: Attention[],
  s: Snapshot,
  busiest = 5,
  changes: TimelineEvent[] = [],
): HomeItem[] {
  return [
    ...items.map((item) => ({ kind: "concern", item }) as const),
    ...changes
      .slice(0, recentChanges)
      .map((event) => ({ kind: "change", event }) as const),
    ...sortLanes(s.lanes, "cpu", true)
      .slice(0, busiest)
      .map((lane) => ({ kind: "agent", lane }) as const),
  ];
}
/** The row a Home item opens: an agent, a card's own row, or a moment. */
export function homeTarget(row: HomeItem): Target | undefined {
  if (row.kind === "agent") return { kind: "lane", id: row.lane.id };
  if (row.kind === "change") return { kind: "time", at: row.event.time };
  return row.item.target;
}
/** The history field each meter's tile charts, so the two cannot drift apart. */
const meterSeries: Record<Meter["id"], keyof Point> = {
  cpu: "pressure",
  memory: "memory",
  disk: "ioPressure",
  builds: "builds",
};
/** The screen behind each tile: the one that breaks its number down. */
export const meterView: Record<Meter["id"], View> = {
  cpu: "Resources",
  memory: "Resources",
  disk: "Storage",
  builds: "Builds",
};
/** The one-row chart under a tile: the peak of each history bucket, placed by time. */
function series(
  points: Point[],
  key: keyof Point,
  start: number,
  end: number,
  width: number,
  style: Config["sparkline"],
): string {
  if (!points.length) return "";
  return sparkline(
    bucketPeaks(points, start, end, width, (p) => {
      const v = p[key];
      return typeof v === "number" ? v : null;
    }),
    width,
    style,
  );
}

export function Home({
  snapshot: s,
  config: c,
  items,
  changes,
  alertsOpened,
  points,
  windowMs,
  selected,
  width,
  height,
  onSelect,
  onOpen,
  onOpenView,
  onCopy,
}: {
  snapshot: Snapshot;
  config: Config;
  items: Attention[];
  /** The window's changes, newest first, as the Timeline lists them. */
  changes: TimelineEvent[];
  /** Alerts opened since the dashboard started. */
  alertsOpened: number;
  points: Point[];
  windowMs: number;
  selected: number;
  width: number;
  height: number;
  onSelect: (index: number) => void;
  onOpen: (item: HomeItem) => void;
  /** Opens the screen behind a tile, which breaks that meter down. */
  onOpenView: (view: View) => void;
  /** Undefined when the selected row carries no command, which the shell says. */
  onCopy: (command: string | undefined) => void;
}) {
  // The verdict, the tiles and the two section headings come before the rows;
  // side by side the agents have the column to themselves, stacked they share
  // it with the concerns.
  const columns = width >= wideWidth;
  const busiest = Math.max(
    3,
    columns
      ? height - 10 - recentChanges - 2
      : height - 10 - items.length * 2 - recentChanges - 2,
  );
  const gauges = meters(s, c);
  const rows = homeItems(items, s, busiest, changes);
  const recent = rows.filter((r) => r.kind === "change");
  // Null while the rows hold the selection. Left or right moves onto the
  // tiles, up or down moves back off them, so one Enter is never ambiguous.
  const [tile, setTile] = useState<number | null>(null);
  /**
   * Whether the rows hold the focus rather than the tiles. The highlight, the
   * selected concern's detail and the row-only actions all read this one
   * value, so the screen cannot mark one item while a key acts on another.
   * A focus model for every region of every screen is #38's work; this is the
   * one screen that already has two places a selection can sit.
   */
  const rowsFocused = tile === null;
  const scroller = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    scroller.current?.scrollChildIntoView(`home-${selected}`);
  }, [selected]);
  useScreenKeys((name) => {
    if (name === c.keys.down || name === "down") {
      setTile(null);
      onSelect(nextDown(rows.length, selected));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      setTile(null);
      onSelect(Math.max(0, selected - 1));
      return true;
    }
    if (name === c.keys.left || name === "left") {
      setTile((at) => Math.max(0, (at ?? 0) - 1));
      return true;
    }
    if (name === c.keys.right || name === "right") {
      setTile((at) => (at === null ? 0 : Math.min(gauges.length - 1, at + 1)));
      return true;
    }
    if (name === c.keys.open && tile !== null && gauges[tile]) {
      onOpenView(meterView[gauges[tile].id]);
      return true;
    }
    if (name === c.keys.open && rows[selected]) {
      onOpen(rows[selected]);
      return true;
    }
    if (name === c.keys.copy) {
      // A tile is a reading, not a command, so while one holds the focus
      // there is no row for copy to act on. Copying whatever row the tiles
      // happen to sit above would act on an item the screen is not marking.
      const row = rowsFocused ? rows[selected] : undefined;
      onCopy(row?.kind === "concern" ? row.item.command : undefined);
      return true;
    }
    return false;
  });
  const lead = verdictItem(items);
  const level: Level = lead ? (lead.danger ? "danger" : "warn") : "ok";
  const panel = columns ? Math.floor((width - 3) / 2) : width;
  // A tile row shares its width between the tiles on it, two columns apart,
  // so the chart is as wide as the tile that carries it however many that is.
  const perRow = tilesPerRow(gauges.length, width);
  const chartWidth = Math.max(
    8,
    Math.floor((width - 2 * (perRow - 1)) / perRow),
  );
  const agents = rows.filter((r) => r.kind === "agent");
  const topCpu = Math.max(100, ...agents.map((r) => r.lane.cpu ?? 0));
  // The marker, the bar and the readings take fixed columns; the name has the
  // rest, and the heading reads the same spec the rows do.
  const fixed: Column[] = [
    { label: "", width: 10 },
    { label: "CPU", width: 7, align: "right" },
    { label: "Memory", width: 10, align: "right" },
    { label: "State", width: 9 },
  ];
  const agentColumns: Column[] = [
    {
      label: "Agent",
      width: Math.max(8, Math.min(40, panel - 5 - columnsWidth(fixed))),
    },
    ...fixed,
  ];
  const [nameColumn, barColumn, cpuColumn, memoryColumn, stateColumn] =
    agentColumns;
  return (
    <scrollbox
      ref={scroller}
      flexGrow={1}
      minHeight={0}
      scrollY
      verticalScrollbarOptions={scrollbar}
      contentOptions={{ flexShrink: 0 }}
    >
      <box flexDirection="column" flexShrink={0} paddingX={2}>
        <Line flexShrink={0} wrapMode="word">
          <span fg={levelColor(level)} attributes={ui.bold}>
            {safe(verdictLine(items, s))}
          </span>
        </Line>
        <Line height={1} flexShrink={0} truncate attributes={ui.dim}>
          {`${s.lanes.length} ${plural(s.lanes.length, "agent", "agents")} · ${s.system.cores} cores · ${items.length ? `${items.length} ${plural(items.length, "concern", "concerns")}` : "nothing needs attention"}`}
        </Line>
        <box height={1} flexShrink={0} />
        <Tiles width={width}>
          {gauges.map((gauge, at) => {
            const card = meterTile(gauge, s, c);
            return (
              <Tile
                key={card.label}
                label={card.label}
                value={card.value}
                level={card.level}
                detail={card.detail}
                selected={tile === at}
                chart={series(
                  points,
                  meterSeries[gauge.id],
                  s.time - windowMs,
                  s.time,
                  chartWidth,
                  c.sparkline,
                )}
                chartColor={metric[gauge.id]}
              />
            );
          })}
        </Tiles>
        <box
          flexDirection={columns ? "row" : "column"}
          flexShrink={0}
          gap={columns ? 3 : 0}
        >
          <box
            flexDirection="column"
            flexShrink={0}
            flexGrow={columns ? 1 : 0}
            flexBasis={columns ? 0 : undefined}
            minWidth={0}
          >
            <Section
              title="Needs attention"
              count={items.length || undefined}
              width={panel}
            />
            {!items.length && (
              <Empty text="No current problems in the data vsys can read." />
            )}
            {rows.map((row, i) =>
              row.kind === "concern" ? (
                <box
                  id={`home-${i}`}
                  key={row.item.id}
                  flexDirection="column"
                  flexShrink={0}
                >
                  <Row
                    selected={rowsFocused && i === selected}
                    color={row.item.danger ? ui.danger : ui.warn}
                    onOpen={() => onOpen(row)}
                  >
                    {safe(row.item.title)}
                  </Row>
                  {rowsFocused && i === selected && (
                    <box flexDirection="column" flexShrink={0} paddingLeft={2}>
                      <Line flexShrink={0} wrapMode="word" attributes={ui.dim}>
                        {safe(row.item.detail)}
                      </Line>
                      <Line flexShrink={0} wrapMode="word">
                        <span attributes={ui.dim}>Next </span>
                        {safe(row.item.next)}
                      </Line>
                      {row.item.command !== undefined && (
                        <Line flexShrink={0} wrapMode="word">
                          <span attributes={ui.dim}>Copy </span>
                          <span fg={ui.accent}>{safe(row.item.command)}</span>
                        </Line>
                      )}
                      <Line
                        height={1}
                        flexShrink={0}
                        truncate
                        attributes={ui.dim}
                      >
                        {`${keyLabel(c.keys.open)} opens ${row.item.target?.kind === "lane" ? "the agent" : row.item.view}${row.item.command === undefined ? "" : ` · ${keyLabel(c.keys.copy)} copies the command`}`}
                      </Line>
                    </box>
                  )}
                </box>
              ) : null,
            )}
          </box>
          <box
            flexDirection="column"
            flexShrink={0}
            flexGrow={columns ? 1 : 0}
            flexBasis={columns ? 0 : undefined}
            minWidth={0}
          >
            <Section
              title="Recent changes"
              width={panel}
              count={
                alertsOpened
                  ? `${alertsOpened} ${plural(alertsOpened, "alert", "alerts")} opened since vsys started`
                  : undefined
              }
            />
            {!recent.length && (
              <Empty text="Nothing has changed since vsys started." />
            )}
            {rows.map((row, i) =>
              row.kind === "change" ? (
                <box
                  id={`home-${i}`}
                  key={`${row.event.time}-${row.event.subjectId}-${row.event.kind}`}
                  flexShrink={0}
                >
                  <Row selected={i === selected} onOpen={() => onOpen(row)}>
                    {(() => {
                      const e = eventParts(row.event, c);
                      return (
                        <>
                          <span
                            attributes={ui.dim}
                          >{`${e.time.padStart(11)}  `}</span>
                          <span
                            fg={levelColor(e.level)}
                            attributes={e.level === "ok" ? ui.none : ui.bold}
                          >
                            {cell({ label: "", width: 13 }, e.kind)}
                          </span>
                          {safe(e.text)}
                        </>
                      );
                    })()}
                  </Row>
                </box>
              ) : null,
            )}
            <Section title="Busiest agents" width={panel} />
            {!agents.length && (
              <Empty text="No agent is running in a watched scope." />
            )}
            {agents.length > 0 && <TableHeader columns={agentColumns} />}
            {rows.map((row, i) =>
              row.kind === "agent" ? (
                <box id={`home-${i}`} key={row.lane.id} flexShrink={0}>
                  <Row
                    selected={rowsFocused && i === selected}
                    onOpen={() => onOpen(row)}
                  >
                    {safe(cell(nameColumn, row.lane.name))}
                    {columnGap}
                    <Bar
                      value={row.lane.cpu}
                      max={topCpu}
                      width={barColumn.width}
                      color={metric.cpu}
                    />
                    {columnGap}
                    <Reading
                      value={row.lane.cpu}
                      text={cell(cpuColumn, share(row.lane.cpu))}
                    />
                    {columnGap}
                    <Reading
                      value={row.lane.rss}
                      text={cell(memoryColumn, amount(row.lane.rss, c))}
                    />
                    {columnGap}
                    <span attributes={ui.dim}>
                      {cell(stateColumn, row.lane.state)}
                    </span>
                  </Row>
                </box>
              ) : null,
            )}
          </box>
        </box>
      </box>
    </scrollbox>
  );
}
