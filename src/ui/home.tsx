import type { RGBA, ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import type { Config } from "../config/config";
import { safe } from "../model/export";
import type { Lane, Snapshot } from "../model/types";
import { type Level, type Meter, meters } from "../model/verdict";
import type { TimelineEvent } from "../store/events";
import type { Point } from "../store/point";
import {
  type Attention,
  cardDetail,
  meterTile,
  type Target,
  verdictItem,
  verdictLine,
} from "./attention";
import {
  detailRows,
  headingRows,
  keyLabel,
  listRows,
  panelWidth,
  screenPad,
  type View,
  wideWidth,
} from "./chrome";
import {
  type Column,
  cell,
  columnGap,
  columnsWidth,
  fit,
  pidCell,
  pidColumn,
  wrapLines,
} from "./columns";
import {
  amount,
  bucketPeaks,
  plural,
  share,
  sortLanes,
  sparkline,
} from "./format";
import { heldCount, heldOrder, useHeldOrder } from "./hold";
import { useScreenKeys } from "./keys";
import {
  homeRegions,
  regionOf,
  regionRanges,
  stepRegion,
  stepToRegion,
  stepWithin,
} from "./regions";
import { levelColor, metric, scrollbar, ui } from "./theme";
import { eventKey, eventParts } from "./timeline";
import {
  Bar,
  Detail,
  Disclosure,
  Empty,
  Ink,
  Line,
  Reading,
  Row,
  Section,
  TableHeader,
  Tile,
  Tiles,
  tileLines,
  tilesHeight,
  tilesPerRow,
  useKeepInView,
} from "./widgets";

/** What an open card writes before the step to take, and before the command. */
const nextLabel = "Next ";
const copyLabel = "Copy ";
/** The one line under those naming the keys that reach them. */
const keysRows = 1;
/** The Home list mixes concerns, changes and agents; Enter opens the selected one. */
export type HomeItem =
  | { kind: "concern"; item: Attention }
  | { kind: "change"; event: TimelineEvent }
  | { kind: "agent"; lane: Lane };
/**
 * The columns `Busiest agents` sorts by, in the order the sort key cycles
 * through them, each with the lane field it reads. Home sorts its own four
 * headings rather than the whole Agents column set, and the key skips any of
 * them the table does not draw: a heading a screen does not draw cannot show a
 * reader which way it is sorted.
 */
export const busiestSorts: [string, string][] = [
  ["CPU", "cpu"],
  ["Memory", "rss"],
  ["Agent", "name"],
  ["State", "state"],
];
/** How many recent changes Home lists, newest first. */
export const recentChanges = 3;
export function homeItems(
  items: Attention[],
  s: Snapshot,
  busiest = 5,
  changes: TimelineEvent[] = [],
  /**
   * The Busiest agents order a reader holds, as lane ids, which `heldOrder`
   * keeps. Busiest agents is a top list, so a lane that was not among the held
   * rows stays out: one that has climbed does not push a held one down.
   */
  held?: string[],
  /** Which of `busiestSorts` the rows are ordered by, and which way. */
  sort: { key: string; descending: boolean } = {
    key: "cpu",
    descending: true,
  },
): HomeItem[] {
  const ranked = sortLanes(s.lanes, sort.key, sort.descending).slice(
    0,
    busiest,
  );
  const lanes = heldOrder(
    ranked,
    held,
    (lane) => lane.id,
    "leave out",
    s.lanes,
  );
  return [
    ...items.map((item) => ({ kind: "concern", item }) as const),
    ...changes
      .slice(0, recentChanges)
      .map((event) => ({ kind: "change", event }) as const),
    ...lanes.map((lane) => ({ kind: "agent", lane }) as const),
  ];
}
/**
 * What tells one Home row from another, whichever kind it is. Home mixes three
 * kinds and its rows prepend, so a row number names a different item one sample
 * later. One function for all three, because a rule written per kind reaches
 * the kinds someone remembered.
 */
export function homeKey(row: HomeItem): string {
  if (row.kind === "concern") return `concern:${row.item.id}`;
  if (row.kind === "change") return `change:${eventKey(row.event)}`;
  return `agent:${row.lane.id}`;
}
/** The row a Home item opens: an agent, a card's own row, or a moment. */
export function homeTarget(row: HomeItem): Target | undefined {
  if (row.kind === "agent") return { kind: "lane", id: row.lane.id };
  if (row.kind === "change")
    return { kind: "time", at: row.event.time, id: eventKey(row.event) };
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

/** The tile row's name, so a screen that has scrolled away can come back. */
const tileRowId = "home-tiles";
export function Home({
  snapshot: s,
  config: c,
  items,
  changes,
  alertsOpened,
  points,
  windowMs,
  selection,
  width,
  cardWidth,
  height,
  onSelect,
  onOpen,
  onOpenView,
  onCopy,
}: {
  snapshot: Snapshot;
  config: Config;
  items: Attention[];
  /** Every retained change, newest first, as the Timeline lists them. */
  changes: TimelineEvent[];
  /** Alerts opened since the dashboard started. */
  alertsOpened: number;
  points: Point[];
  windowMs: number;
  /** The row the reader chose, and the item that row named. */
  selection: { index: number; id: string | null };
  width: number;
  /** The columns an open card's copy is written and drawn at: `detailWidth`. */
  cardWidth: number;
  height: number;
  onSelect: (selection: { index: number; id: string | null }) => void;
  onOpen: (item: HomeItem) => void;
  /** Opens the screen behind a tile, which breaks that meter down. */
  onOpenView: (view: View) => void;
  /** Undefined when the selected row carries no command, which the shell says. */
  onCopy: (command: string | undefined) => void;
}) {
  const columns = width >= wideWidth;
  const gauges = meters(s, c);
  // What this screen draws above its lists, measured rather than guessed: the
  // verdict at the rows it wraps to here, and the tile row at the rows a tile
  // takes. `listRows` and `detailRows` take it from there, so the rows a list
  // has and the rows an open card has come from one place.
  const verdict = verdictLine(items, s);
  const above = wrapLines(verdict, width).length;
  const tiles = tilesHeight(gauges.length, width, tileLines);
  const room = { screen: height, verdict: above, tiles };
  // The agents list has what its own heading leaves; side by side it has the
  // column to itself, stacked it shares one with the concerns and the changes.
  const busiest = Math.max(
    3,
    listRows(room) -
      recentChanges -
      headingRows -
      (columns ? 0 : items.length * 2),
  );
  // Every line a card draws is wrapped here and drawn one row per row, so what
  // a line costs has one owner: the rows this counts and the rows the screen
  // draws are the same rows. Nothing under the card's title is left to the
  // renderer's own wrapping, which charges a row of its own for a line that
  // ends on the last column.
  const lines = (label: string, text: string) =>
    wrapLines(`${label}${text}`, cardWidth);
  /**
   * One of those lines, drawn a wrapped row at a time under the word that
   * leads it. The word is dim on the first row and the rest of the line takes
   * the colour its kind is drawn in.
   */
  const action = (
    label: string,
    text: string,
    colour: RGBA | undefined,
    top = 0,
  ) =>
    lines(label, text).map((line, at) => (
      <Line
        // biome-ignore lint/suspicious/noArrayIndexKey: a row is its place
        key={at}
        height={1}
        flexShrink={0}
        truncate
        marginTop={at === 0 ? top : 0}
      >
        {at === 0 && <span attributes={ui.dim}>{label}</span>}
        <span fg={colour}>
          {safe(at === 0 ? line.slice(label.length) : line)}
        </span>
      </Line>
    ));
  // The lines under the description: what to do next, the command it offers,
  // and the one line naming the keys that reach them.
  const actions = (item: Attention) =>
    lines(nextLabel, item.next).length +
    (item.command === undefined ? 0 : lines(copyLabel, item.command).length) +
    keysRows;
  const described = (item: Attention) =>
    cardDetail(
      item,
      cardWidth,
      detailRows({ ...room, actions: actions(item) }),
    );
  // Busiest agents is the one Home list its readings order.
  const hold = useHeldOrder();
  // Home's own sort, not the one Agents stores: the two screens draw different
  // headings, and a marker has to sit on a heading the reader can see.
  const [sort, setSort] = useState({ key: "cpu", descending: true });
  const rows = homeItems(
    items,
    s,
    busiest,
    changes,
    hold.kept("busiest"),
    sort,
  );
  hold.drew(
    "busiest",
    rows.flatMap((row) => (row.kind === "agent" ? [row.lane.id] : [])),
  );
  const recent = rows.filter((r) => r.kind === "change");
  // The tile the reader moved to, null while they have chosen none.
  const [chosenTile, setTile] = useState<number | null>(null);
  /**
   * The row to draw, resolved against the rows this render has. Following the
   * chosen item keeps the reader on it when a change arrives above it, and
   * where that item has gone the nearest row that exists takes over. Same rule
   * as the Agents list and the Timeline list.
   */
  const found = rows.findIndex((row) => homeKey(row) === selection.id);
  const selected =
    found >= 0
      ? found
      : Math.min(selection.index, Math.max(0, rows.length - 1));
  // Home holds four regions and the tile row is one of them. The three lists
  // are ranges over the one flat selection the render draws; the tiles keep
  // their own index, which is why they are region zero rather than rows inside
  // it. Up and down move along the list in focus and stop at its ends. Left
  // and right step between regions as the region key does, except on the tile
  // row, where they step between tiles first: right from the last tile enters
  // the first list with a row, and left from the first list enters the last
  // tile, so there each arrow undoes the other.
  const counts = [
    rows.filter((row) => row.kind === "concern").length,
    rows.filter((row) => row.kind === "change").length,
    rows.filter((row) => row.kind === "agent").length,
  ];
  const ranges = regionRanges(counts);
  // With no row in any list there is nothing else to stand on, so the tiles
  // hold the focus until a row arrives or the reader picks a tile.
  const tile =
    chosenTile ?? (regionOf(counts, selected) < 0 && gauges.length ? 0 : null);
  /**
   * Whether the rows hold the focus rather than the tiles. The highlight, the
   * selected concern's detail and the row-only actions all read this one
   * value, so the screen cannot mark one item while a key acts on another.
   */
  const rowsFocused = tile === null;
  /** Move the selection, recording the row and the item it names together. */
  const choose = (index: number) =>
    onSelect({ index, id: rows[index] ? homeKey(rows[index]) : null });
  // The first row is a choice too. Home cannot seed it at construction, since
  // its parent holds the selection and only this screen knows the rows, so it
  // is recorded on the first render that has any.
  useEffect(() => {
    if (selection.id === null && rows.length) choose(selection.index);
  });
  /**
   * Whether the row at `i` carries the selection marker. All three row types
   * ask here rather than repeating the rule at each render site.
   */
  const marked = (i: number) => rowsFocused && i === selected;
  const scroller = useRef<ScrollBoxRenderable | null>(null);
  // The tile row is a place the reader stands as much as any list row is, so
  // it is what has to be in view while it holds the focus, however far down a
  // list the reader was before.
  useKeepInView(scroller, tile === null ? `home-${selected}` : tileRowId);
  const region = tile === null ? 1 + regionOf(counts, selected) : 0;
  /** A region's heading: its title, the key that jumps to it, and its focus. */
  const heading = (at: number) => ({
    title: homeRegions[at].title,
    hotkey: c.keys[homeRegions[at].action],
    focused: region === at,
  });
  const toList = (at: number) => {
    if (at < 0 || !ranges[at] || counts[at] === 0) return;
    setTile(null);
    choose(ranges[at][0]);
  };
  /**
   * Moves the focus to the next region with a row, `way`. A list is entered at
   * its first row. The tile row is entered at `entry`: the first tile for the
   * region key, which lands on a region's start, and the last for the left
   * arrow, which arrives at the row's right-hand end.
   */
  const focus = (way: -1 | 1, entry = 0) => {
    if (tile !== null) {
      // Region zero: there is nothing to its left, and its right is the first
      // list that has a row in it.
      if (way > 0) toList(stepRegion(counts, -1, 1));
      return;
    }
    const next = stepToRegion(counts, selected, way);
    // No list that way: to the left of the first one are the tiles.
    if (next === selected) {
      if (way < 0 && gauges.length) setTile(entry);
      return;
    }
    choose(next);
  };
  useScreenKeys((name) => {
    if (name === c.keys.next) {
      focus(1);
      return true;
    }
    if (name === c.keys.previous) {
      focus(-1);
      return true;
    }
    if (name === c.keys.down || name === "down") {
      if (tile === null) choose(stepWithin(counts, selected, 1));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      if (tile === null) choose(stepWithin(counts, selected, -1));
      return true;
    }
    if (name === c.keys.left || name === "left") {
      if (tile === null) focus(-1, gauges.length - 1);
      else setTile(Math.max(0, tile - 1));
      return true;
    }
    if (name === c.keys.right || name === "right") {
      if (tile !== null && tile < gauges.length - 1) setTile(tile + 1);
      else focus(1);
      return true;
    }
    // A region's own key lands on its first place. A list with no row has no
    // place to land on, so its key leaves the focus where it is.
    const jump = homeRegions.findIndex(({ action }) => name === c.keys[action]);
    if (jump === 0) {
      if (gauges.length) setTile(0);
      return true;
    }
    if (jump > 0) {
      toList(jump - 1);
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
    // A key that asks for a different order releases the held one. While an
    // order is held the heading marks none, so it never names an order the
    // rows do not follow.
    if (name === c.keys.sort) {
      const at = drawnSorts.findIndex(([, key]) => key === sort.key);
      hold.release();
      setSort({
        key: drawnSorts[(at + 1) % drawnSorts.length][1],
        descending: sort.descending,
      });
      return true;
    }
    if (name === c.keys.reverse) {
      hold.release();
      setSort({ key: sort.key, descending: !sort.descending });
      return true;
    }
    if (name === c.keys.hold) {
      hold.toggle();
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
  const panel = panelWidth(width);
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
  // The id is here for the same reason it is on the Agents list: rows that
  // share a name are told apart by nothing else. This table shares its width
  // with the column beside it, so when the name cannot keep its floor the
  // state goes first — a blocked or running lane already shows in its numbers,
  // while a name that identifies nothing shows in nothing.
  const homeNameFloor = 24;
  const fixedWith = (state: boolean): Column[] => [
    pidColumn,
    { label: "", width: 10 },
    { label: "CPU", width: 7, align: "right" },
    { label: "Memory", width: 10, align: "right" },
    ...(state ? [{ label: "State", width: 9 } as Column] : []),
  ];
  const nameRoom = (state: boolean) =>
    panel - 5 - columnsWidth(fixedWith(state));
  const withState = nameRoom(true) >= homeNameFloor;
  const fixed = fixedWith(withState);
  // The time, the kind and the subject each take a column, so the rows scan
  // as rows. The subject takes what the time and the kind leave and is cut
  // through the same helper every other cell uses, which ends a cut with its
  // mark instead of stopping mid-word.
  const changeColumns: Column[] = [
    { label: "", width: 11, align: "right" },
    { label: "", width: 13 },
    { label: "", width: Math.max(8, panel - 5 - 11 - 13 - 4) },
  ];
  const agentColumns: Column[] = [
    {
      label: "Agent",
      width: Math.max(8, Math.min(40, nameRoom(withState))),
    },
    ...fixed,
  ];
  const [nameColumn, , barColumn, cpuColumn, memoryColumn] = agentColumns;
  const stateColumn = withState ? agentColumns[5] : undefined;
  // The sorts whose heading this table draws, which the sort key cycles
  // through. A sort left on a column the width has since shed moves to the
  // first of them on the next press.
  const drawnSorts = busiestSorts.filter(([label]) =>
    agentColumns.some((column) => column.label === label),
  );
  return (
    <scrollbox
      ref={scroller}
      flexGrow={1}
      minHeight={0}
      scrollY
      scrollbarOptions={scrollbar}
      contentOptions={{ flexShrink: 0 }}
    >
      <box flexDirection="column" flexShrink={0} paddingX={screenPad}>
        <Line flexShrink={0} wrapMode="word">
          <span fg={levelColor(level)} attributes={ui.bold}>
            {safe(verdict)}
          </span>
        </Line>
        <Line height={1} flexShrink={0} truncate attributes={ui.dim}>
          {`${s.lanes.length} ${plural(s.lanes.length, "agent", "agents")} · ${s.system.cores} cores · ${items.length ? `${items.length} ${plural(items.length, "concern", "concerns")}` : "nothing needs attention"}`}
        </Line>
        <box height={1} flexShrink={0} />
        <Tiles width={width} id={tileRowId}>
          {gauges.map((gauge, at) => {
            const card = meterTile(gauge, s, c);
            return (
              <Tile
                key={card.label}
                // The tile row draws no heading, so the key that jumps to it
                // leads the label of the tile it lands on.
                label={
                  at === 0 ? `${heading(0).hotkey} ${card.label}` : card.label
                }
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
                onOpen={() => onOpenView(meterView[gauge.id])}
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
              {...heading(1)}
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
                    selected={marked(i)}
                    color={row.item.danger ? ui.danger : ui.warn}
                    onOpen={() => onOpen(row)}
                  >
                    {/* The same question the detail below is drawn under, so
                        the marker says open only while the detail is drawn.
                        The title is cut to the row with its mark, and the
                        detail repeats what a cut can lose. */}
                    <Disclosure
                      open={marked(i)}
                      name={fit(safe(row.item.title), panel - 3)}
                    />
                  </Row>
                  {marked(i) && (
                    <Detail>
                      {/* One paragraph per idea, every one after the first
                          under a blank row that says a new idea starts here.
                          Each paragraph is drawn a wrapped row at a time, so
                          the rows it takes are the rows it was measured at. */}
                      {described(row.item).map((part, at) =>
                        wrapLines(part, cardWidth).map((line, row) => (
                          <Line
                            // biome-ignore lint/suspicious/noArrayIndexKey: a row is its place
                            key={`${at}-${row}`}
                            height={1}
                            flexShrink={0}
                            truncate
                            attributes={ui.dim}
                            marginTop={at > 0 && row === 0 ? 1 : 0}
                          >
                            {safe(line)}
                          </Line>
                        )),
                      )}
                      {/* The blank row the confirm dialog draws above its key
                          line, here between the description and everything
                          the reader can act on: `Next`, the command, and the
                          keys that reach them. One row, out of the same
                          budget, so the action lines sit where they sat. */}
                      {action(nextLabel, row.item.next, undefined, 1)}
                      {row.item.command !== undefined &&
                        action(copyLabel, row.item.command, ui.accent)}
                      <Line
                        height={1}
                        flexShrink={0}
                        truncate
                        attributes={ui.dim}
                      >
                        {`${keyLabel(c.keys.open)} opens ${row.item.target?.kind === "lane" ? "the agent" : row.item.view}${row.item.command === undefined ? "" : ` · ${keyLabel(c.keys.copy)} copies the command`}`}
                      </Line>
                    </Detail>
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
              {...heading(2)}
              width={panel}
              // Zero alerts is a reading a reader can act on. Dropping the
              // count there leaves no way to tell it from a count vsys never
              // took, which is the same defect as a blank standing for zero.
              count={`${alertsOpened} ${plural(alertsOpened, "alert", "alerts")} opened since vsys started`}
            />
            {!recent.length && (
              <Empty text="Nothing has changed since vsys started." />
            )}
            {rows.map((row, i) =>
              row.kind === "change" ? (
                <box id={`home-${i}`} key={eventKey(row.event)} flexShrink={0}>
                  <Row selected={marked(i)} onOpen={() => onOpen(row)}>
                    {(() => {
                      const e = eventParts(row.event, c);
                      const [timeColumn, kindColumn, subjectColumn] =
                        changeColumns;
                      return (
                        <>
                          <span attributes={ui.dim}>
                            {`${cell(timeColumn, e.time)}${columnGap}`}
                          </span>
                          <Ink
                            color={levelColor(e.level)}
                            attributes={e.level === "ok" ? ui.none : ui.bold}
                          >
                            {cell(kindColumn, e.kind)}
                          </Ink>
                          {safe(cell(subjectColumn, e.text))}
                        </>
                      );
                    })()}
                  </Row>
                </box>
              ) : null,
            )}
            <Section
              {...heading(3)}
              width={panel}
              count={heldCount(undefined, hold.held)}
            />
            {!agents.length && (
              <Empty text="No agent is running in a watched scope." />
            )}
            {agents.length > 0 && (
              <TableHeader
                columns={agentColumns}
                sort={
                  hold.held
                    ? undefined
                    : {
                        label:
                          busiestSorts.find(
                            ([, key]) => key === sort.key,
                          )?.[0] ?? "",
                        descending: sort.descending,
                      }
                }
              />
            )}
            {rows.map((row, i) =>
              row.kind === "agent" ? (
                <box id={`home-${i}`} key={row.lane.id} flexShrink={0}>
                  <Row selected={marked(i)} onOpen={() => onOpen(row)}>
                    {safe(cell(nameColumn, row.lane.name))}
                    <span attributes={ui.dim}>
                      {`${columnGap}${pidCell(row.lane.mainPid)}`}
                    </span>
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
                    {stateColumn && columnGap}
                    <span attributes={ui.dim}>
                      {stateColumn ? cell(stateColumn, row.lane.state) : ""}
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
