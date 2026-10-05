import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Config, columns, validate } from "../config/config";
import type { LaneIntent } from "../model/actions";
import { safe } from "../model/export";
import type { Lane, Snapshot } from "../model/types";
import type { Level } from "../model/verdict";
import type { History } from "../store/history";
import type { LaneSample } from "../store/lane-series";
import { Agent, AgentSummary } from "./agent";
import { narrowWidth, screenPad, wideWidth } from "./chrome";
import {
  type Column,
  cell,
  columnGap,
  columnsWidth,
  fitAddress,
  pidCell,
  pidColumn,
  sortedLabel,
  textWidth,
} from "./columns";
import {
  amount,
  blockedText,
  bucketPeaks,
  floorText,
  laneValue,
  share,
  sortLanes,
  sparkline,
  waitText,
} from "./format";
import { heldLabel, heldOrder, useHeldOrder } from "./hold";
import { useScreenKeys } from "./keys";
import { firstRow, useSelection } from "./selection";
import { levelColor, metric, scrollbar, textInput, ui } from "./theme";
import {
  Bar,
  Ink,
  Line,
  List,
  listWindow,
  nextDown,
  Reading,
  Row,
  Sparkline,
  TableHeader,
} from "./widgets";

export const columnLabels: Record<string, string> = {
  name: "Agent",
  account: "Account",
  cwd: "Worktree",
  branch: "Branch",
  tool: "Program",
  cpu: "CPU",
  pressure: "CPU wait",
  rss: "Memory",
  swap: "Swap",
  tasks: "Tasks",
  rustc: "Rustc",
  cargo: "Cargo",
  tests: "Tests",
  age: "Age",
  state: "State",
  cgroup: "Cgroup",
  cache: "Page cache",
  readRate: "Read",
  writeRate: "Written",
  sccache: "sccache",
  blocked: "Blocked",
};
/** Table columns wider than the default, because their values are names. */
const wideColumns: Record<string, number> = {
  name: 26,
  account: 14,
  cwd: 30,
  branch: 16,
  tool: 10,
  cgroup: 30,
};
/** A configurable column whose Lane field holds a number. */
type NumericColumn = {
  [K in (typeof columns)[number]]: NonNullable<Lane[K]> extends number
    ? K
    : never;
}[(typeof columns)[number]];
/**
 * Table columns whose values are numbers, which read down their last digit.
 * The names are still written out, because a type is not a value, but the
 * type is derived from `Lane` and requires exactly the numeric fields among
 * the configurable columns: one missing or one too many is a compile error.
 * A plain list is what left `cache`, `readRate`, `writeRate`, `sccache` and
 * `blocked` aligned left beside their neighbours.
 */
const numericColumns: Record<NumericColumn, true> = {
  cpu: true,
  pressure: true,
  rss: true,
  swap: true,
  tasks: true,
  rustc: true,
  cargo: true,
  tests: true,
  age: true,
  cache: true,
  readRate: true,
  writeRate: true,
  sccache: true,
  blocked: true,
};
/**
 * One table column, from the same spec the list rows read. The heading and
 * the row under it are built from this and cannot drift apart.
 */
export function tableColumn(name: string): Column {
  return {
    label: columnLabels[name] ?? name,
    width: wideColumns[name] ?? 12,
    align: Object.hasOwn(numericColumns, name) ? "right" : undefined,
  };
}
/**
 * The list heading a stored sort column appears under. The table draws every
 * column, so it needs no table; the list draws a few, and a sort on one it
 * does not draw simply marks no heading.
 */
const listHeading: Record<string, string> = {
  name: "Agent",
  tool: "Program",
  cpu: "CPU",
  rss: "Memory",
  pressure: "Wait",
  state: "State",
};
/** The columns a row's trend sparkline takes. */
export const trendWidth = 12;
/**
 * The CPU history of the lanes on screen, and only those. A list of forty
 * lanes in a terminal that shows twenty must read twenty series, not forty,
 * and a refresh must read none: the loaded set is keyed by lane and window,
 * so scrolling reads what scrolling revealed and nothing else.
 */
/**
 * The moment a trend is read against and drawn against, which has to be one
 * moment. The chart's columns are buckets of the window, so its shape cannot
 * change until the newest bucket rolls over, and quantising to that boundary
 * is what lets a sample cost no read. The drawn window has to be quantised the
 * same way: left on the sample time it slides forward over a series that did
 * not move, and every column it slides past draws as a gap. A gap in this
 * dashboard means vsys could not read something, so an unquantised render
 * makes the chart lie in the vocabulary the rest of the screen uses.
 */
export function trendEnd(end: number, windowMs: number): number {
  const bucketMs = windowMs / trendWidth;
  return Math.floor(end / bucketMs) * bucketMs;
}
/** What a trend read is an answer to: the window and the moment it ends. */
interface Question {
  windowMs: number;
  at: number;
}
/**
 * What the trend reads have answered for one store. It lives with the store
 * rather than with the screen, so leaving the list and coming back draws the
 * series already read and asks the store for none of them again.
 */
interface Trends {
  /** The question every key in `requested` was asked under. */
  question: Question;
  /**
   * One judge for "has this series been asked for": the keys already asked
   * for under `question`, whether answered or still in flight, so a render
   * between the ask and the answer does not ask again.
   */
  requested: Set<string>;
  /**
   * Keys whose read failed under `question`, with the sample time it was asked
   * on. Each stays requested until a later sample, which asks for it again,
   * so a read that keeps failing is retried once a sample and not in a loop.
   */
  failed: Map<string, number>;
  /** The series drawn, keyed by lane and window. */
  loaded: Map<string, LaneSample[]>;
}
/** Keyed by the store, so a replaced store starts with nothing read. */
const answered = new WeakMap<History, Trends>();
const unread = new Map<string, LaneSample[]>();
export function useLaneTrends(
  history: History,
  lanes: Lane[],
  end: number,
  windowMs: number,
): Map<string, LaneSample[]> {
  // An answer lands in `answered`, which React does not watch, so landing one
  // asks for a render.
  const [, redraw] = useState(0);
  // The one moment this reads against, and the one the caller draws against.
  // Keying on the sample time would cost a read per visible row every second;
  // keying on nothing but the lane and the window is what this did, and the
  // window then never moved at all.
  const at = trendEnd(end, windowMs);
  // A redraw is asked for only while the screen is up. An answer that lands
  // after it is gone is still kept, because it answers the question the
  // screen will ask again when it comes back.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ids = lanes.map((lane) => lane.id).join("\u0000");
  useEffect(() => {
    const keys = (ids ? ids.split("\u0000") : []).map(
      (id): [string, string] => [id, `${id}\u0000${windowMs}`],
    );
    let trends = answered.get(history);
    if (!trends) {
      trends = {
        question: { windowMs, at },
        requested: new Set(),
        failed: new Map(),
        loaded: new Map(),
      };
      answered.set(history, trends);
    } else if (
      trends.question.at !== at ||
      trends.question.windowMs !== windowMs
    ) {
      // A rolled-over bucket and a resized window each make a new answer for
      // every row, so what was asked for under the old question is not what
      // is wanted now. A row keeps drawing its last answer until the new one
      // lands or its read fails, and a row no longer on screen is let go.
      trends.question = { windowMs, at };
      trends.requested.clear();
      trends.failed.clear();
      const shown = new Set(keys.map(([, key]) => key));
      trends.loaded = new Map(
        [...trends.loaded].filter(([key]) => shown.has(key)),
      );
    }
    const kept = trends;
    for (const [key, time] of kept.failed)
      if (end > time) {
        kept.failed.delete(key);
        kept.requested.delete(key);
      }
    const missing = keys.flatMap(([id, key]) => {
      if (kept.requested.has(key)) return [];
      kept.requested.add(key);
      return [id];
    });
    if (!missing.length) return;
    // One read for every row this question reveals, so the store walks its
    // history once for all of them rather than once per row.
    const asked = kept.question;
    const askedOn = end;
    void (async () => {
      let series: Map<string, LaneSample[]> | null = null;
      try {
        series = await history.laneWindows(missing, asked.at, asked.windowMs);
      } catch {
        // A read that could not be taken is not an empty window, and the
        // answer a row carried from the previous bucket is not this window.
        // Each row it asked for loses that answer and draws blank, as a row
        // not read yet does, and is asked for again on the next sample. No
        // screen shows the error, so it is not kept.
        series = null;
      }
      // A read started under the previous question can still be in flight
      // when this one begins, and it resolves whenever the disk gets to it,
      // which can be after the newer read: stored unconditionally it would put
      // an older window back on the screen. Cancelling in advance is the
      // other mistake: every answer is discarded and the column stays blank.
      // So the answer is kept or dropped when it arrives, on what it answers.
      if (kept.question !== asked) return;
      const loaded = new Map(kept.loaded);
      for (const id of missing) {
        const key = `${id}\u0000${asked.windowMs}`;
        const samples = series?.get(id);
        if (samples) loaded.set(key, samples);
        else {
          loaded.delete(key);
          kept.failed.set(key, askedOn);
        }
      }
      kept.loaded = loaded;
      if (mounted.current) redraw((n) => n + 1);
    })();
    // The sample time is a dependency so a failed read is asked for again on
    // the next sample. A sample asks for nothing else: every other key on
    // screen is already in `requested`.
  }, [history, ids, windowMs, at, end]);
  return answered.get(history)?.loaded ?? unread;
}
/**
 * A row's CPU trend, or blank columns while its series is still loading. A
 * placeholder in a chart column is read as a measurement, so a row vsys has
 * not read yet draws nothing rather than a flat line at zero. An empty series
 * is a different answer: it was read, and the window holds no sample, which
 * the gap dots say.
 */
export function trendMarks(
  samples: LaneSample[] | undefined,
  end: number,
  windowMs: number,
  style: Config["sparkline"],
): string {
  if (samples === undefined) return " ".repeat(trendWidth);
  return sparkline(
    bucketPeaks(samples, end - windowMs, end, trendWidth, (x) => x.cpu),
    trendWidth,
    style,
  );
}
/** The lanes whose text matches the query, in the configured order. */
export function findLanes(lanes: Lane[], query: string, c: Config): Lane[] {
  const q = query.toLowerCase();
  return sortLanes(
    lanes.filter((lane) =>
      [
        lane.name,
        // The process id is a column on every row, and the one thing that
        // tells two lanes with one name apart.
        lane.mainPid ? String(lane.mainPid) : "",
        lane.account ?? "",
        lane.pane,
        // The address and the window are columns a reader can see, so a query
        // typed from the screen has to find the row showing it.
        lane.address,
        lane.window,
        lane.title,
        lane.cwd,
        lane.branch,
        lane.tool,
      ].some((value) => value.toLowerCase().includes(q)),
    ),
    c.sort,
    c.descending,
  );
}
/**
 * What is wrong with a lane, worst first, with the numbers that tripped it.
 * Every level but ok has one, so a coloured row always says why.
 */
export type LaneBadge =
  | { kind: "unconfined"; level: "danger" }
  | { kind: "cap"; level: "danger"; cap: number | null; floor: number }
  | {
      kind: "pressure";
      level: "danger" | "warn";
      resource: "cpu" | "memory" | "io";
      some: number;
      threshold: number;
    }
  | { kind: "blocked"; level: "warn" };
export function laneBadge(lane: Lane, c: Config): LaneBadge | null {
  if (lane.unconfined) return { kind: "unconfined", level: "danger" };
  if (lane.dangerous)
    return {
      kind: "cap",
      level: "danger",
      cap: lane.memoryMax,
      floor: c.memoryFloor,
    };
  const waits = [
    { resource: "cpu", some: lane.pressure },
    { resource: "memory", some: lane.memoryPressure },
    { resource: "io", some: lane.ioPressure },
  ] as const;
  let worst: { resource: "cpu" | "memory" | "io"; some: number } | null = null;
  // A lane stored before a pressure was read carries none at all.
  for (const { resource, some } of waits)
    if (typeof some === "number" && (worst === null || some > worst.some))
      worst = { resource, some };
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
  if (lane.state === "blocked") return { kind: "blocked", level: "warn" };
  return null;
}
export function badgeText(badge: LaneBadge, lane: Lane, c: Config): string {
  switch (badge.kind) {
    case "unconfined":
      return "outside agent slice";
    case "cap":
      return floorText(badge.cap, badge.floor, c);
    case "pressure":
      return waitText(badge.resource, badge.some, badge.threshold);
    case "blocked":
      return blockedText(lane);
    default:
      return badge satisfies never;
  }
}
/** A blocked lane is badged without colouring its row. */
export function laneLevel(lane: Lane, c: Config): Level {
  const badge = laneBadge(lane, c);
  return badge && badge.kind !== "blocked" ? badge.level : "ok";
}

/**
 * Agents holds the list, its search and table modes, and the open agent, so
 * the list selection survives a visit to the detail.
 */
export function Agents({
  snapshot: s,
  history,
  config: c,
  laneId,
  live,
  windowMs,
  width,
  height,
  onSave,
  onError,
  onOpen,
  onCopy,
  onAct,
  onCapture,
  onSwitch,
}: {
  snapshot: Snapshot;
  history: History;
  config: Config;
  laneId: string | null;
  live: boolean;
  windowMs: number;
  width: number;
  height: number;
  onSave: (c: Config) => Promise<void>;
  onError: (error: unknown) => void;
  onOpen: (id: string | null) => void;
  onCopy: (command: string | undefined) => void;
  onAct: (intent: LaneIntent) => void;
  /** Reads an agent's tmux pane; the agent detail alone uses it. */
  onCapture?: (paneId: string) => Promise<string[]>;
  /** Moves the reader's tmux view; absent when vsys is outside that server. */
  onSwitch?: (paneId: string) => Promise<void>;
}) {
  /**
   * What the reader chose, followed by lane. This screen reads the selection
   * three times over, for the highlight, for the summary beside the list, and
   * for what the open action opens.
   */
  const [selection, setSelection] = useState(firstRow);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [table, setTable] = useState(false);
  const [chooser, setChooser] = useState(false);
  const [column, setColumn] = useState(0);
  // Every lane is on this list, so a lane that starts while the order is held
  // is appended rather than hidden: a list that hides a live agent tells the
  // reader it is not running. The list and the table draw this one order.
  const hold = useHeldOrder();
  const lanes = heldOrder(
    findLanes(s.lanes, query, c),
    hold.kept("agents"),
    (lane) => lane.id,
    "append",
  );
  hold.drew(
    "agents",
    lanes.map((lane) => lane.id),
  );
  const open = laneId === null ? null : s.lanes.find((l) => l.id === laneId);
  // The list sorts by its readings, so an arrival can land on the very row a
  // departed lane left behind; the selection owner records what it resolves.
  // It must be called before the effect below, which moves the selection too.
  const {
    selected,
    choose,
    move: step,
  } = useSelection(
    lanes.map((lane) => lane.id),
    selection,
    setSelection,
  );
  // A lane opened from Home or from a card was never selected in this list,
  // so going back would land on the first row. Follow the open lane instead.
  // Declared after the selection owner, so that a lane opened from elsewhere
  // wins the pass it arrives in: declared before it, the two write different
  // rows on every pass and never settle, which hangs the render rather than
  // merely picking the wrong row.
  useEffect(() => {
    if (laneId === null) return;
    const at = lanes.findIndex((lane) => lane.id === laneId);
    // A lane missing from this list has exited; a filter cannot be hiding it,
    // because this screen unmounts when the reader leaves it and every route
    // that opens a lane from inside the list picks a row the list is already
    // showing. The resolution above holds a row that exists for that case, so
    // nothing is needed here for it.
    //
    // `lanes` is rebuilt every render, so this runs every render. Returning
    // the same object is how it stops: a fresh one of equal value would be a
    // new state on each pass and would never settle.
    if (at >= 0)
      setSelection((current) =>
        current.index === at && current.id === laneId
          ? current
          : { index: at, id: laneId },
      );
  }, [laneId, lanes]);
  const save = (value: Config) => {
    try {
      void onSave(validate(value)).catch(onError);
    } catch (error) {
      onError(error);
    }
  };
  const toggleColumn = (name: string) => {
    const next = c.columns.includes(name)
      ? c.columns.filter((v) => v !== name)
      : [...c.columns, name];
    if (next.length) save({ ...c, columns: next });
  };
  useScreenKeys((name, key) => {
    if (laneId !== null) {
      if (name === c.keys.back) {
        onOpen(null);
        return true;
      }
      return false;
    }
    if (searching) {
      if (name === c.keys.back) {
        key.preventDefault();
        setSearching(false);
        setQuery("");
      }
      return true;
    }
    const rows = chooser ? columns.length : lanes.length;
    // Each step starts where the last one landed, which a render has not
    // drawn yet when two keys arrive in one read.
    const move = (to: (from: number) => number) =>
      chooser ? setColumn(to) : step(to);
    if (name === c.keys.down || name === "down") {
      move((from) => nextDown(rows, from));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      move((from) => Math.max(0, from - 1));
      return true;
    }
    if (name === c.keys.open) {
      if (chooser) {
        const toggled = columns[column];
        if (toggled === undefined)
          throw new Error(
            `Column chooser row ${column} is outside the ${columns.length} columns`,
          );
        toggleColumn(toggled);
      } else if (lanes[selected]) onOpen(lanes[selected].id);
      return true;
    }
    if (name === c.keys.search) {
      key.preventDefault();
      setSearching(true);
      choose(0);
      return true;
    }
    if (name === c.keys.details) {
      setTable((v) => !v);
      setChooser(false);
      return true;
    }
    if (name === c.keys.columns) {
      setTable(true);
      setChooser((v) => !v);
      return true;
    }
    if (name === c.keys.back && chooser) {
      setChooser(false);
      return true;
    }
    // A key that asks for an order releases the held one, and while an order
    // is held no heading is marked, so none names an order the rows ignore.
    if (name === c.keys.sort) {
      hold.release();
      const at =
        (columns.indexOf(c.sort as (typeof columns)[number]) + 1) %
        columns.length;
      const sort = columns[at];
      if (sort === undefined)
        throw new Error(
          `Sort column ${at} is outside the ${columns.length} columns`,
        );
      save({ ...c, sort });
      return true;
    }
    if (name === c.keys.reverse) {
      hold.release();
      save({ ...c, descending: !c.descending });
      return true;
    }
    if (name === c.keys.hold) {
      hold.toggle();
      return true;
    }
    return false;
  });
  // Above the stated width the selected agent's summary sits beside the list,
  // so a row can be read against what it means without leaving the list.
  const sidePane = width >= wideWidth && !searching && !chooser && !table;
  const sideWidth = sidePane ? Math.max(34, Math.floor(width / 3)) : 0;
  const listWidth = width - sideWidth - (sidePane ? 3 : 0);
  // The program and the wait share leave a narrow list; the name takes
  // whatever the fixed columns leave, and the heading reads the same spec.
  const narrow = listWidth < narrowWidth;
  // The two panel margins and the selection marker take five columns. The
  // readings are fixed, State keeps a floor so a lane's badge always has room,
  // and the name takes what is left up to a cap.
  const margins = 5;
  const stateFloor = 9;
  // What the name keeps before any optional column is drawn. Every optional
  // column is a column of the same spec, so its heading and its rows move
  // together with the rest; each is drawn only where the name can spare the
  // width, because a name cut back to its account tells one row from the next
  // by nothing at all. The order they are given up in is below.
  const nameFloor = 24;
  // A narrowing list sheds in this order until the name has its floor back,
  // and identity outranks readings. The readings go first: the trend, whose own
  // number is already in the CPU column beside it; then the program, which
  // reads `claude` on every row of an ordinary fleet; then the wait, which
  // reads `0.0%` on every row that is not blocked. The pane address goes after
  // all three, because it is identity, though only for lanes inside the tmux
  // server vsys reads.
  //
  // The process id is not in this set at all. It is on every row and it is the
  // only thing that tells two lanes with one name apart, so a width at which it
  // is gone is a width at which a reader cannot pick the lane they came for.
  const optional = ["Trend", "Program", "Wait", "Pane"] as const;
  const wanted: Record<(typeof optional)[number], boolean> = {
    Trend: !narrow,
    Program: !narrow,
    Wait: !narrow,
    // `laneNameParts` listing `pane` composes nothing into the name: `%9` is a
    // server handle a reader cannot place. It selects this column instead, so
    // a stored config keeps loading and the setting keeps its meaning.
    Pane:
      !narrow &&
      c.laneNameParts.includes("pane") &&
      lanes.some((lane) => lane.address !== ""),
  };
  // The pane column is as wide as the longest address the list holds, and
  // never narrower than its heading. The readings are measured against the
  // whole address, so each of them is given up before any address is cut; the
  // column itself is given up only where even its heading's width leaves the
  // name short of its floor. Between the two it narrows to what the name can
  // spare, and `fitAddress` then cuts the session, never the `:window.pane`
  // suffix that is all two agents in one session differ by.
  const paneHeading = "Pane".length;
  const paneLongest = Math.max(
    paneHeading,
    ...lanes.map((lane) => textWidth(lane.address)),
  );
  const readingsWith = (shown: Set<string>, pane: number): Column[] => [
    ...(shown.has("Pane") ? [{ label: "Pane", width: pane }] : []),
    pidColumn,
    ...(shown.has("Program") ? [{ label: "Program", width: 9 }] : []),
    { label: "", width: 10 },
    { label: "CPU", width: 7, align: "right" as const },
    ...(shown.has("Trend") ? [{ label: "Trend", width: trendWidth }] : []),
    { label: "Memory", width: 10, align: "right" as const },
    ...(shown.has("Wait")
      ? [{ label: "Wait", width: 11, align: "right" as const }]
      : []),
  ];
  const roomWith = (shown: Set<string>, pane = paneLongest) =>
    listWidth -
    margins -
    columnsWidth(readingsWith(shown, pane)) -
    columnGap.length * 2 -
    stateFloor;
  const showing = new Set(optional.filter((label) => wanted[label]));
  for (const label of optional) {
    const pane = label === "Pane" ? paneHeading : paneLongest;
    if (roomWith(showing, pane) >= nameFloor) break;
    showing.delete(label);
  }
  const paneWidth = Math.min(
    paneLongest,
    paneLongest + roomWith(showing) - nameFloor,
  );
  const showTrend = showing.has("Trend");
  const readings = readingsWith(showing, paneWidth);
  const spare = roomWith(showing, paneWidth);
  const nameColumn: Column = {
    label: "Agent",
    width: Math.max(12, Math.min(36, spare)),
  };
  const measured: Column[] = [nameColumn, ...readings];
  // A lane's badge is a sentence, so State takes every column the rest leave.
  const laneColumns: Column[] = [
    ...measured,
    {
      label: "State",
      width: Math.max(
        stateFloor,
        listWidth - margins - columnsWidth(measured) - columnGap.length,
      ),
    },
  ];
  // The table's own columns, read by its heading and by every row in it. The
  // process id is not a configurable column: it is fixed after the name, or
  // first where the name is not shown, and has no sort to click.
  const tableCells: { name: string | null; column: Column }[] = c.columns.map(
    (name) => ({ name, column: tableColumn(name) }),
  );
  tableCells.splice(c.columns.indexOf("name") + 1, 0, {
    name: null,
    column: pidColumn,
  });
  const laneColumn = (label: string): Column => {
    const found = laneColumns.find((x) => x.label === label);
    if (!found) throw new Error(`No lane column named ${label}`);
    return found;
  };
  const barColumn = laneColumn("");
  const listHeight = height - 3 - (searching ? 3 : 0);
  // Only the rows the list draws: the window the list computes is the window
  // the store is asked for, so the two cannot disagree.
  const shown = listWindow(lanes.length, selected, listHeight);
  // Where the column is not drawn it is not read. The table view and the column
  // chooser draw something else, and an open agent draws its own detail, which
  // reads its series on the snapshot time rather than through this list.
  const drawsTrend = showTrend && !table && !chooser && laneId === null;
  const visible = drawsTrend ? lanes.slice(shown.start, shown.end) : [];
  const trends = useLaneTrends(history, visible, s.time, windowMs);
  const trend = (id: string) =>
    trendMarks(
      trends.get(`${id}\u0000${windowMs}`),
      trendEnd(s.time, windowMs),
      windowMs,
      c.sparkline,
    );

  /**
   * One lane row, in the list or in the table. Its identity, its marker, its
   * colour and what opening it does are decided here once, so neither view
   * can draw a lane by a rule the other has dropped.
   */
  const laneRow = (lane: Lane, isSelected: boolean, line: ReactNode) => (
    <Row
      key={lane.id}
      selected={isSelected}
      color={levelColor(laneLevel(lane, c))}
      onOpen={() => onOpen(lane.id)}
    >
      {line}
    </Row>
  );

  if (laneId !== null)
    return open ? (
      <Agent
        lane={open}
        snapshot={s}
        history={history}
        config={c}
        live={live}
        width={width}
        windowMs={windowMs}
        onCopy={onCopy}
        onAct={onAct}
        onError={onError}
        onCapture={onCapture}
        onSwitch={onSwitch}
      />
    ) : (
      <box paddingX={screenPad}>
        <Line attributes={ui.dim}>This agent is no longer in the sample.</Line>
      </box>
    );
  if (chooser)
    return (
      <box flexDirection="column" paddingX={screenPad}>
        <Line height={1} truncate attributes={ui.dim}>
          {`Table columns · ${c.keys.open} shows or hides · ${c.keys.back} done`}
        </Line>
        <box height={1} />
        {columns.map((name, i) => (
          <Row
            key={name}
            selected={column === i}
            onOpen={() => {
              setColumn(i);
              toggleColumn(name);
            }}
          >
            <Ink color={c.columns.includes(name) ? ui.accent : undefined}>
              {c.columns.includes(name) ? "◉ " : "○ "}
            </Ink>
            {columnLabels[name] ?? name}
          </Row>
        ))}
      </box>
    );
  const selectedLane = lanes[selected];
  const sortLabel = `${columnLabels[c.sort] ?? c.sort} ${c.descending ? "↓" : "↑"}`;
  const topCpu = Math.max(100, ...lanes.map((l) => l.cpu ?? 0));
  return (
    <box
      flexDirection="row"
      flexGrow={1}
      minHeight={0}
      paddingX={screenPad}
      gap={3}
    >
      <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
        <Line height={1} flexShrink={0} truncate>
          <span
            attributes={ui.bold}
          >{`${lanes.length} ${lanes.length === 1 ? "agent" : "agents"}`}</span>
          <span attributes={ui.dim}>
            {`  ${hold.held ? heldLabel : `sorted by ${sortLabel}`}${query ? `  matching "${safe(query)}"` : ""}`}
          </span>
        </Line>
        <box height={1} flexShrink={0} />
        {searching && (
          <box
            height={3}
            flexShrink={0}
            border
            borderStyle="rounded"
            borderColor={ui.accent}
            title=" Find "
            marginBottom={0}
          >
            <input
              {...textInput}
              focused
              value={query}
              placeholder="name, process id, account, pane, branch or worktree"
              onInput={setQuery}
              onSubmit={() => setSearching(false)}
            />
          </box>
        )}
        {table ? (
          <scrollbox
            id="agents-table"
            flexGrow={1}
            minHeight={0}
            focused={!searching}
            scrollX
            scrollY={false}
            scrollbarOptions={scrollbar}
            contentOptions={{ flexShrink: 0 }}
          >
            <box flexDirection="column" flexShrink={0}>
              {/* One cell per column so a click sorts it, spaced by the gap
                  the rows under it are joined with. */}
              <box height={1} flexShrink={0} flexDirection="row">
                {/* The marker column sits outside the gapped cells, because a
                    row draws its marker with no gap after it. */}
                <Line width={1} height={1}>
                  {" "}
                </Line>
                <box
                  height={1}
                  flexShrink={0}
                  flexDirection="row"
                  gap={columnGap.length}
                >
                  {tableCells.map(({ name, column }) => {
                    // A click reads the heading as drawn: while the order is
                    // held none is marked, so any heading sorts largest first.
                    const sorted =
                      name !== null && c.sort === name && !hold.held;
                    return (
                      <Line
                        key={name ?? column.label}
                        width={column.width}
                        height={1}
                        flexShrink={0}
                        truncate
                        attributes={sorted ? ui.bold : ui.dim}
                        onMouseDown={
                          name === null
                            ? undefined
                            : () => {
                                hold.release();
                                save({
                                  ...c,
                                  sort: name,
                                  descending: sorted ? !c.descending : true,
                                });
                              }
                        }
                      >
                        {cell(
                          column,
                          sortedLabel(column, sorted, c.descending),
                        )}
                      </Line>
                    );
                  })}
                </box>
              </box>
              <List
                items={lanes}
                selected={selected}
                height={listHeight - 1}
                onSelect={choose}
                empty="No agent matches."
                render={(lane, _, isSelected) =>
                  laneRow(
                    lane,
                    isSelected,
                    tableCells
                      .map(({ name, column }) =>
                        name === null
                          ? pidCell(lane.mainPid)
                          : cell(column, safe(laneValue(lane, name, c))),
                      )
                      .join(columnGap),
                  )
                }
              />
            </box>
          </scrollbox>
        ) : (
          <>
            {lanes.length > 0 && (
              <TableHeader
                columns={laneColumns}
                sort={
                  hold.held
                    ? undefined
                    : {
                        label: listHeading[c.sort] ?? "",
                        descending: c.descending,
                      }
                }
              />
            )}
            <List
              items={lanes}
              selected={selected}
              height={listHeight}
              onSelect={choose}
              empty={
                query
                  ? "No agent matches."
                  : "No process runs in a watched scope, and no agent has escaped one."
              }
              render={(lane, _, isSelected) => {
                const badge = laneBadge(lane, c);
                return laneRow(
                  lane,
                  isSelected,
                  <>
                    {safe(cell(nameColumn, lane.name))}
                    {showing.has("Pane") && (
                      <span attributes={ui.dim}>
                        {`${columnGap}${safe(fitAddress(lane.address, laneColumn("Pane").width))}`}
                      </span>
                    )}
                    {/* Every row, not only the ones that would collide: an id
                        that appears on some rows and not others reads as
                        arbitrary rather than as identity. And every width, so
                        there is no width at which the rows stop being rows a
                        reader can tell apart. */}
                    <span attributes={ui.dim}>
                      {`${columnGap}${pidCell(lane.mainPid)}`}
                    </span>
                    {showing.has("Program") && (
                      <span attributes={ui.dim}>
                        {`${columnGap}${safe(cell(laneColumn("Program"), lane.tool))}`}
                      </span>
                    )}
                    {columnGap}
                    <Bar
                      value={lane.cpu}
                      max={topCpu}
                      width={barColumn.width}
                      color={metric.cpu}
                    />
                    {columnGap}
                    <Reading
                      value={lane.cpu}
                      text={cell(laneColumn("CPU"), share(lane.cpu))}
                    />
                    {showTrend && columnGap}
                    {showTrend && (
                      // A series still loading draws nothing: a placeholder in
                      // a chart column is read as a measurement.
                      <Sparkline marks={trend(lane.id)} color={metric.cpu} />
                    )}
                    {columnGap}
                    <Reading
                      value={lane.rss}
                      text={cell(laneColumn("Memory"), amount(lane.rss, c))}
                    />
                    {showing.has("Wait") && columnGap}
                    {showing.has("Wait") && (
                      <Reading
                        value={lane.pressure}
                        text={cell(laneColumn("Wait"), share(lane.pressure))}
                      />
                    )}
                    {columnGap}
                    {badge ? (
                      <Ink color={levelColor(badge.level)}>
                        {cell(laneColumn("State"), badgeText(badge, lane, c))}
                      </Ink>
                    ) : (
                      <span attributes={ui.dim}>
                        {cell(laneColumn("State"), lane.state)}
                      </span>
                    )}
                  </>,
                );
              }}
            />
          </>
        )}
      </box>
      {sidePane && selectedLane && (
        <box flexDirection="column" flexShrink={0} width={sideWidth}>
          <AgentSummary
            lane={selectedLane}
            snapshot={s}
            config={c}
            width={sideWidth}
          />
        </box>
      )}
    </box>
  );
}
