import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { Config } from "../config/config";
import { safe } from "../model/export";
import type { Lane, Snapshot } from "../model/types";
import { type Level, type Meter, meters } from "../model/verdict";
import type { Point } from "../store/point";
import {
  type Attention,
  meterTile,
  verdictItem,
  verdictLine,
} from "./attention";
import { keyLabel } from "./chrome";
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
} from "./widgets";

/** The Home list mixes concerns and agents; Enter opens whichever is selected. */
export type HomeItem =
  | { kind: "concern"; item: Attention }
  | { kind: "agent"; lane: Lane };
export function homeItems(
  items: Attention[],
  s: Snapshot,
  busiest = 5,
): HomeItem[] {
  return [
    ...items.map((item) => ({ kind: "concern", item }) as const),
    ...sortLanes(s.lanes, "cpu", true)
      .slice(0, busiest)
      .map((lane) => ({ kind: "agent", lane }) as const),
  ];
}
/** The history field each meter's tile charts, so the two cannot drift apart. */
const meterSeries: Record<Meter["id"], keyof Point> = {
  cpu: "pressure",
  memory: "memory",
  disk: "ioPressure",
  builds: "builds",
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
  points,
  windowMs,
  selected,
  width,
  onSelect,
  onOpen,
  onCopy,
}: {
  snapshot: Snapshot;
  config: Config;
  items: Attention[];
  points: Point[];
  windowMs: number;
  selected: number;
  width: number;
  onSelect: (index: number) => void;
  onOpen: (item: HomeItem) => void;
  /** Undefined when the selected row carries no command, which the shell says. */
  onCopy: (command: string | undefined) => void;
}) {
  const rows = homeItems(items, s);
  const scroller = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    scroller.current?.scrollChildIntoView(`home-${selected}`);
  }, [selected]);
  useScreenKeys((name) => {
    if (name === c.keys.down || name === "down") {
      onSelect(nextDown(rows.length, selected));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      onSelect(Math.max(0, selected - 1));
      return true;
    }
    if (name === c.keys.open && rows[selected]) {
      onOpen(rows[selected]);
      return true;
    }
    if (name === c.keys.copy) {
      const row = rows[selected];
      onCopy(row?.kind === "concern" ? row.item.command : undefined);
      return true;
    }
    return false;
  });
  const lead = verdictItem(items);
  const level: Level = lead ? (lead.danger ? "danger" : "warn") : "ok";
  const gauges = meters(s, c);
  const tileWidth = Math.max(8, Math.floor((width - 2 * 3) / 4));
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
      width: Math.max(8, Math.min(40, width - 5 - columnsWidth(fixed))),
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
        <Tiles>
          {gauges.map((gauge) => {
            const tile = meterTile(gauge, s, c);
            return (
              <Tile
                key={tile.label}
                label={tile.label}
                value={tile.value}
                level={tile.level}
                detail={tile.detail}
                chart={series(
                  points,
                  meterSeries[gauge.id],
                  s.time - windowMs,
                  s.time,
                  tileWidth,
                  c.sparkline,
                )}
                chartColor={metric[gauge.id]}
              />
            );
          })}
        </Tiles>
        <Section
          title="Needs attention"
          count={items.length || undefined}
          width={width}
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
                selected={i === selected}
                color={row.item.danger ? ui.danger : ui.warn}
                onOpen={() => onOpen(row)}
              >
                {safe(row.item.title)}
              </Row>
              {i === selected && (
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
                  <Line height={1} flexShrink={0} truncate attributes={ui.dim}>
                    {`${keyLabel(c.keys.open)} opens ${row.item.laneId ? "the agent" : row.item.view}${row.item.command === undefined ? "" : ` · ${keyLabel(c.keys.copy)} copies the command`}`}
                  </Line>
                </box>
              )}
            </box>
          ) : null,
        )}
        <Section title="Busiest agents" width={width} />
        {!agents.length && (
          <Empty text="No agent is running in a watched scope." />
        )}
        {agents.length > 0 && <TableHeader columns={agentColumns} />}
        {rows.map((row, i) =>
          row.kind === "agent" ? (
            <box id={`home-${i}`} key={row.lane.id} flexShrink={0}>
              <Row selected={i === selected} onOpen={() => onOpen(row)}>
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
    </scrollbox>
  );
}
