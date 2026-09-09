import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { Config } from "../config/config";
import { safe } from "../model/export";
import type { Lane, Snapshot } from "../model/types";
import { type Level, meters } from "../model/verdict";
import type { Point } from "../store/point";
import {
  type Attention,
  meterTile,
  sourceFooter,
  verdictItem,
  verdictLine,
} from "./attention";
import { keyLabel } from "./chrome";
import {
  amount,
  bucketPeaks,
  plural,
  share,
  sortLanes,
  sparkline,
} from "./format";
import { useScreenKeys } from "./keys";
import { levelColor, scrollbar, ui } from "./theme";
import {
  Bar,
  Empty,
  Heading,
  Line,
  nextDown,
  Row,
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
    return false;
  });
  const lead = verdictItem(items);
  const level: Level = lead ? (lead.danger ? "danger" : "warn") : "ok";
  const tiles = meters(s, c).map((meter) => meterTile(meter, s, c));
  const charts: (keyof Point)[] = [
    "pressure",
    "memory",
    "ioPressure",
    "builds",
  ];
  const tileWidth = Math.max(8, Math.floor((width - 2 * 3) / 4));
  const footer = sourceFooter(s);
  const agents = rows.filter((r) => r.kind === "agent");
  const topCpu = Math.max(100, ...agents.map((r) => r.lane.cpu ?? 0));
  // Marker, bar, CPU, memory and state take fixed columns; the name has the rest.
  const nameWidth = Math.max(8, Math.min(40, width - 46));
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
          {tiles.map((tile, i) => (
            <Tile
              key={tile.label}
              label={tile.label}
              value={tile.value}
              level={tile.level}
              detail={tile.detail}
              chart={series(
                points,
                charts[i],
                s.time - windowMs,
                s.time,
                tileWidth,
                c.sparkline,
              )}
            />
          ))}
        </Tiles>
        <Heading title="Needs attention" count={items.length || undefined} />
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
                    {`${keyLabel(c.keys.open)} opens ${row.item.laneId ? "the agent" : row.item.view}`}
                  </Line>
                </box>
              )}
            </box>
          ) : null,
        )}
        <Heading title="Busiest agents" />
        {!agents.length && (
          <Empty text="No agent is running in a watched scope." />
        )}
        {rows.map((row, i) =>
          row.kind === "agent" ? (
            <box id={`home-${i}`} key={row.lane.id} flexShrink={0}>
              <Row selected={i === selected} onOpen={() => onOpen(row)}>
                {safe(row.lane.name.padEnd(nameWidth).slice(0, nameWidth))}
                {"  "}
                <Bar value={row.lane.cpu} max={topCpu} width={10} />
                {`  ${share(row.lane.cpu).padStart(7)}  ${amount(row.lane.rss, c).padStart(10)}`}
                <span attributes={ui.dim}>{`  ${row.lane.state}`}</span>
              </Row>
            </box>
          ) : null,
        )}
        {footer !== null && (
          <Line
            flexShrink={0}
            wrapMode="word"
            marginTop={1}
            attributes={ui.dim}
          >
            {footer}
          </Line>
        )}
      </box>
    </scrollbox>
  );
}
