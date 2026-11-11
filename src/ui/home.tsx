import type { RGBA, ScrollBoxRenderable } from "@opentui/core";
import { Fragment, type ReactNode, useRef, useState } from "react";
import type { Config } from "../config/config";
import { safe } from "../model/export";
import type { Lane, Leftovers, Snapshot } from "../model/types";
import { type Meter, meters, processesComplete } from "../model/verdict";
import type { TimelineEvent } from "../store/events";
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
  age,
  amount,
  count,
  gap,
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
import type { ChartField, Retained } from "./retained";
import { type Selection, useSelection } from "./selection";
import { levelStatus, metric, scrollbar, statusColor, ui } from "./theme";
import { eventKey, eventParts, eventStatus } from "./timeline";
import {
  Bar,
  Detail,
  Disclosure,
  Empty,
  Ink,
  Line,
  ListRow,
  Reading,
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
/** The key line and the blank row above it. */
const keysRows = 2;
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
  ["CPU %/core", "cpu"],
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
const meterSeries: Record<Meter["id"], ChartField> = {
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
/** The one-row chart under a tile: the peak of each column, placed by time. */
function series(
  retained: Retained,
  key: ChartField,
  width: number,
  style: Config["sparkline"],
): string {
  if (!retained.points.length) return "";
  return sparkline(
    retained.columns(width).columns.map((column) => column?.peaks[key] ?? null),
    width,
    style,
  );
}

/** The tile row's name, so a screen that has scrolled away can come back. */
/** The warden's counts in the order the leftovers line reads them. */
const leftoverParts = [
  ["testWorlds", "test world", "test worlds"],
  ["failedUnits", "failed unit", "failed units"],
  ["testProcesses", "old test process", "old test processes"],
] as const;
/** Why the warden's status gave no counts, null where it gave them. */
function leftoversGap(l: Leftovers | undefined, now: number): string | null {
  if (l === undefined) return gap;
  if (l.state === "read") return null;
  if (l.state === "absent") return `${gap}: no agent warden status`;
  if (l.state === "failed" || l.time === null)
    return `${gap}: the agent warden status could not be read`;
  return now >= l.time
    ? `${gap}: the agent warden last wrote its status ${age((now - l.time) / 1000)} ago`
    : `${gap}: the agent warden status is dated ${age((l.time - now) / 1000)} ahead`;
}
/**
 * What test runs left behind, as the warden last counted it. Each count is a
 * reading of its own, so a backlog stands out from the zeros beside it, and a
 * count the warden could not take stays not available rather than zero.
 */
function LeftoversLine({
  leftovers: l,
  now,
}: {
  leftovers: Leftovers | undefined;
  now: number;
}) {
  const why = leftoversGap(l, now);
  return (
    <Line height={1} flexShrink={0} truncate>
      <span attributes={ui.dim}>Test leftovers: </span>
      {why !== null || l === undefined ? (
        <span attributes={ui.dim}>{why}</span>
      ) : (
        leftoverParts.map(([key, one, many], at) => {
          const n = l[key];
          return (
            <Fragment key={key}>
              {at > 0 && <span attributes={ui.dim}> · </span>}
              <Reading
                value={n}
                text={n === null ? `${many} ${gap}` : count(n, one, many)}
              />
            </Fragment>
          );
        })
      )}
    </Line>
  );
}
const tileRowId = "home-tiles";
export function Home({
  snapshot: s,
  config: c,
  items,
  changes,
  alertsOpened,
  retained,
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
  /** The window's points, and its chart columns kept across draws. */
  retained: Retained;
  /** The row the reader chose, and the item that row named. */
  selection: Selection;
  width: number;
  /** The columns an open card's copy is written and drawn at: `detailWidth`. */
  cardWidth: number;
  height: number;
  onSelect: (selection: Selection) => void;
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
  // has and the rows an open card has come from one place. The verdict is
  // drawn from these rows, because the renderer's own wrapping also breaks
  // after a full stop and would split `agents.slice` across a row these
  // never counted.
  const lead = verdictItem(items);
  const headline = verdictLine(items, s);
  const verdictStatus = lead
    ? levelStatus(lead.danger ? "danger" : "warn")
    : headline === "Healthy"
      ? "OK"
      : undefined;
  const verdict = wrapLines(
    verdictStatus
      ? `${verdictStatus}: ${lead ? headline.replace(/^[^:]+: /, "") : headline}`
      : headline,
    width,
  );
  // Without every process, the lanes miss each escaped agent, so the count
  // is not a fact.
  const agentCount = processesComplete(s)
    ? count(s.lanes.length, "agent")
    : `agents ${gap}`;
  const above = verdict.length;
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
  // and the key line with its blank row above.
  const actions = (item: Attention) =>
    lines(nextLabel, item.next).length +
    (item.command === undefined
      ? 0
      : lines(copyLabel, item.command).length + 1) +
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
  // The row to draw, following the chosen item when a change arrives above it.
  // The first row is a choice too, recorded on the first render that has any:
  // Home cannot seed it at construction, since its parent holds the selection
  // and only this screen knows the rows.
  const { selected, choose, move } = useSelection(
    rows.map(homeKey),
    selection,
    onSelect,
  );
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
  /** Whether the row at `i` carries the selection marker. */
  const marked = (i: number) => rowsFocused && i === selected;
  /** Opening a row chooses it, whether a key or the mouse opened it. */
  const openRow = (row: HomeItem, i: number) => {
    choose(i);
    onOpen(row);
  };
  /**
   * One Home row, whichever kind it is. Its identity, the place the screen
   * scrolls to, its marker, what opening it does and what is drawn under it
   * while marked are decided here once: a rule written at each kind's render
   * site reaches the kinds someone remembered, and misses the one added last.
   */
  const homeRow = (
    row: HomeItem,
    i: number,
    line: ReactNode,
    { under }: { under?: () => ReactNode } = {},
  ) => (
    <ListRow
      key={homeKey(row)}
      id={`home-${i}`}
      selected={marked(i)}
      onOpen={() => openRow(row, i)}
      under={marked(i) && under?.()}
    >
      {line}
    </ListRow>
  );
  const scroller = useRef<ScrollBoxRenderable | null>(null);
  // The tile row is a place the reader stands as much as any list row is, so
  // it is what has to be in view while it holds the focus, however far down a
  // list the reader was before.
  useKeepInView(scroller, tile === null ? `home-${selected}` : tileRowId);
  const region = tile === null ? 1 + regionOf(counts, selected) : 0;
  /** A region's heading: its title, the key that jumps to it, and its focus. */
  const heading = (at: 0 | 1 | 2 | 3) => ({
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
      if (tile === null) move((from) => stepWithin(counts, from, 1));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      if (tile === null) move((from) => stepWithin(counts, from, -1));
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
    const row = rows[selected];
    if (name === c.keys.open && row) {
      openRow(row, selected);
      return true;
    }
    // A key that asks for a different order releases the held one. While an
    // order is held the heading marks none, so it never names an order the
    // rows do not follow.
    if (name === c.keys.sort) {
      const at = drawnSorts.findIndex(([, key]) => key === sort.key);
      const next = drawnSorts[(at + 1) % drawnSorts.length];
      if (next === undefined)
        throw new Error("Home's agent table draws no heading it can sort by");
      hold.release();
      setSort({ key: next[1], descending: sort.descending });
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
  const barColumn: Column = { label: "", width: 10 };
  const cpuColumn: Column = { label: "CPU %/core", width: 12, align: "right" };
  const memoryColumn: Column = { label: "Memory", width: 10, align: "right" };
  const stateOption: Column = { label: "State", width: 9 };
  const fixedWith = (state: boolean): Column[] => [
    pidColumn,
    barColumn,
    cpuColumn,
    memoryColumn,
    ...(state ? [stateOption] : []),
  ];
  const nameRoom = (state: boolean) =>
    panel - 5 - columnsWidth(fixedWith(state));
  const withState = nameRoom(true) >= homeNameFloor;
  const fixed = fixedWith(withState);
  // The time, the kind and the subject each take a column, so the rows scan
  // as rows. The subject takes what the time and the kind leave and is cut
  // through the same helper every other cell uses, which ends a cut with its
  // mark instead of stopping mid-word.
  const changeColumns: [Column, Column, Column] = [
    { label: "", width: 11, align: "right" },
    { label: "", width: 22 },
    { label: "", width: Math.max(8, panel - 5 - 11 - 22 - 4) },
  ];
  const nameColumn: Column = {
    label: "Agent",
    width: Math.max(8, Math.min(40, nameRoom(withState))),
  };
  const agentColumns: Column[] = [nameColumn, ...fixed];
  const stateColumn = withState ? stateOption : undefined;
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
        {verdict.map((line, at) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a row is its place
          <Line key={at} height={1} flexShrink={0} truncate>
            {at === 0 && verdictStatus ? (
              <>
                <Ink color={statusColor(verdictStatus)} attributes={ui.bold}>
                  {verdictStatus}
                </Ink>
                {": "}
                {line.slice(verdictStatus.length + 2)}
              </>
            ) : (
              line
            )}
          </Line>
        ))}
        <Line height={1} flexShrink={0} truncate attributes={ui.dim}>
          {`${agentCount} · ${s.system.cores} cores · ${items.length ? `${items.length} ${plural(items.length, "concern", "concerns")}` : "nothing needs attention"}`}
        </Line>
        <LeftoversLine leftovers={s.leftovers} now={s.time} />
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
                  retained,
                  meterSeries[gauge.id],
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
              row.kind === "concern"
                ? homeRow(
                    row,
                    i,
                    // The same question the detail below is drawn under, so
                    // the marker says open only while the detail is drawn.
                    // The title is cut to the row with its mark, and the
                    // detail repeats what a cut can lose.
                    <>
                      <Disclosure open={marked(i)} name="" />
                      <Ink
                        color={statusColor(
                          row.item.danger ? "Error" : "Warning",
                        )}
                      >
                        {row.item.danger ? "Error" : "Warning"}
                      </Ink>{" "}
                      {fit(safe(row.item.title), panel - 11)}
                    </>,
                    {
                      under: () => (
                        <Detail>
                          {/* One paragraph per idea, every one after the first
                              under a blank row that says a new idea starts
                              here. Each paragraph is drawn a wrapped row at a
                              time, so the rows it takes are the rows it was
                              measured at. */}
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
                          {/* The blank row the confirm dialog draws above its
                              key line, here between the description and
                              everything the reader can act on: `Next`, the
                              command, and the keys that reach them. One row,
                              out of the same budget, so the action lines sit
                              where they sat. */}
                          {action(nextLabel, row.item.next, undefined, 1)}
                          {row.item.command !== undefined &&
                            action(copyLabel, row.item.command, ui.accent, 1)}
                          {/* One row, cut with its mark where the card is
                              narrower than the line: a row the edge shortens
                              says nothing of what it dropped. */}
                          <Line
                            height={1}
                            flexShrink={0}
                            truncate
                            attributes={ui.dim}
                            marginTop={1}
                          >
                            {fit(
                              `${keyLabel(c.keys.open)} opens ${row.item.target?.kind === "lane" ? "the agent" : row.item.view}${row.item.command === undefined ? "" : ` · ${keyLabel(c.keys.copy)} copies the command`}`,
                              cardWidth,
                            )}
                          </Line>
                        </Detail>
                      ),
                    },
                  )
                : null,
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
            {rows.map((row, i) => {
              if (row.kind !== "change") return null;
              const e = eventParts(row.event, c);
              const [timeColumn, kindColumn, subjectColumn] = changeColumns;
              return homeRow(
                row,
                i,
                <>
                  <span attributes={ui.dim}>
                    {`${cell(timeColumn, e.time)}${columnGap}`}
                  </span>
                  <Ink
                    color={statusColor(eventStatus(row.event, e.level))}
                    attributes={e.level === "ok" ? ui.none : ui.bold}
                  >
                    {eventStatus(row.event, e.level)}
                  </Ink>
                  {fit(
                    eventStatus(row.event, e.level) === e.kind
                      ? ""
                      : ` ${e.kind}`,
                    kindColumn.width - eventStatus(row.event, e.level).length,
                  )}
                  {columnGap}
                  {safe(cell(subjectColumn, e.text))}
                </>,
              );
            })}
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
              row.kind === "agent"
                ? homeRow(
                    row,
                    i,
                    <>
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
                    </>,
                  )
                : null,
            )}
          </box>
        </box>
      </box>
    </scrollbox>
  );
}
