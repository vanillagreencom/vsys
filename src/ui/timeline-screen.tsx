import { useCallback, useEffect, useState } from "react";
import type { Config } from "../config/config";
import { safe } from "../model/export";
import type { Snapshot } from "../model/types";
import type { TimelineEvent } from "../store/events";
import type { History } from "../store/history";
import { changed, type Point } from "../store/point";
import { fit } from "./columns";
import {
  bucketPeaks,
  bytes,
  gap,
  percent,
  spanLabel,
  sparkline,
  timeBuckets,
} from "./format";
import { useScreenKeys } from "./keys";
import { levelColor, metric, readingWeight, ui } from "./theme";
import { eventKey, eventParts } from "./timeline";
import {
  Chart,
  Field,
  gutter,
  Line,
  List,
  nextDown,
  Row,
  Section,
  Sparkline,
  Tile,
  Tiles,
  tilesHeight,
} from "./widgets";

/** The windows the reader can step through, shortest first. */
export const windows = [300000, 900000, 3600000, 21600000, 86400000];
/** The point the cursor stands on: the last sample at or before it. */
export function pointAt(
  points: Point[],
  cursor: number | null,
): Point | undefined {
  const at = cursor ?? points.at(-1)?.time;
  return points.findLast((p) => at !== undefined && p.time <= at);
}
/** A window as the reader says it: minutes under an hour, whole hours above. */
export function windowLabel(ms: number): string {
  return ms < 3600000
    ? `${Math.round(ms / 60000)}m`
    : `${Math.round(ms / 3600000)}h`;
}
/** The marker strip under the charts, as runs of one kind so each run is one span. */
export interface MarkerRun {
  kind: "cursor" | "change" | "quiet";
  at: number;
  text: string;
}
export function markerRuns(
  changedColumns: boolean[],
  cursor: number | undefined,
): MarkerRun[] {
  const runs: MarkerRun[] = [];
  changedColumns.forEach((isChange, i) => {
    const kind: MarkerRun["kind"] =
      i === cursor ? "cursor" : isChange ? "change" : "quiet";
    const text = kind === "cursor" ? "▲" : kind === "change" ? "!" : "·";
    const last = runs.at(-1);
    if (last && last.kind === kind) last.text += text;
    else runs.push({ kind, at: i, text });
  });
  return runs;
}
const anyChange = (bucket: Point[]) => bucket.some(changed);
const numeric = (key: keyof Point) => (p: Point) => {
  const v = p[key];
  return typeof v === "number" ? v : null;
};

/** History: what the machine did over the window, then what changed and why. */
export function Timeline({
  snapshot: s,
  history,
  config: c,
  points,
  windowIndex,
  cursor,
  width,
  height,
  onCursor,
  onWindow,
  target,
  onTargetUsed,
}: {
  snapshot: Snapshot;
  history: History;
  config: Config;
  points: Point[];
  windowIndex: number;
  cursor: number | null;
  width: number;
  height: number;
  onCursor: (time: number | null) => void;
  onWindow: (index: number) => void;
  /** The event time a Home row asked this screen to land on. */
  /** The moment a Home row asked for, and which change at that moment. */
  target: { at: number; id: string } | null;
  onTargetUsed: () => void;
}) {
  const windowMs = windows[windowIndex];
  const changes = history.events(s.time, windowMs);
  /**
   * What the reader chose: the row they moved to, and the change that row
   * named. The window key can swap a long list for a shorter one and a new
   * sample prepends to it, so a row number alone outlives what it pointed at.
   *
   * The first row is a choice like any other, so it is seeded with the change
   * it sits on rather than left as a null to be resolved by index. Left null,
   * a change arriving at the top took the highlight while the cursor stayed
   * on the row the reader had opened.
   */
  const [selection, setSelection] = useState<{
    index: number;
    id: string | null;
  }>(() => ({ index: 0, id: changes[0] ? eventKey(changes[0]) : null }));
  const start = s.time - windowMs;
  const chartWidth = Math.max(10, width - 4 - gutter);
  const buckets = timeBuckets(points, start, s.time, chartWidth);
  const selected = pointAt(points, cursor);
  const at = cursor ?? points.at(-1)?.time;
  const cursorColumn =
    at === undefined
      ? undefined
      : Math.min(
          chartWidth - 1,
          Math.max(0, Math.floor(((at - start) * chartWidth) / windowMs)),
        );
  useScreenKeys((name, key) => {
    if (name === c.keys.down || name === "down") {
      const next = nextDown(changes.length, row);
      select(next, changes[next]);
      return true;
    }
    if (name === c.keys.up || name === "up") {
      const up = Math.max(0, row - 1);
      select(up, changes[up]);
      return true;
    }
    // The change list is a list: Enter moves the time cursor to the row, and
    // the pin key pins the sample the row happened in.
    if (name === c.keys.open && changes[row]) {
      open(row, changes[row]);
      return true;
    }
    const left = name === c.keys.left || name === "left";
    const right = name === c.keys.right || name === "right";
    if (!left && !right) return false;
    key.preventDefault();
    const index =
      cursor === null
        ? points.length - 1
        : Math.max(
            0,
            points.findLastIndex((p) => p.time <= cursor),
          );
    const next = Math.max(
      0,
      Math.min(points.length - 1, index + (left ? -1 : 1)),
    );
    onCursor(points[next]?.time ?? null);
    return true;
  });
  const peaks = (key: keyof Point) =>
    bucketPeaks(points, start, s.time, chartWidth, numeric(key));
  const agents = peaks("agents");
  const memory = peaks("memory");
  const top = (values: (number | null)[], floor: number) =>
    Math.max(floor, ...values.map((v) => v ?? 0));
  const agentsTop = top(agents, 100);
  const memoryTop = top(memory, s.system.memory.MemTotal ?? 1);
  const value = (key: keyof Point, format: (n: number) => string) => {
    const v = selected ? numeric(key)(selected) : null;
    return v === null ? "" : format(v);
  };
  const pick = (column: number) =>
    onCursor(
      buckets[column].at(-1)?.time ?? start + (column * windowMs) / chartWidth,
    );
  const onChart = (event: {
    x: number;
    currentTarget: { x: number } | null;
  }) => {
    if (!event.currentTarget) return;
    pick(
      Math.max(
        0,
        Math.min(
          chartWidth - 1,
          Math.floor(event.x - event.currentTarget.x - 2 - gutter),
        ),
      ),
    );
  };
  /**
   * The row to draw, resolved against the list this render has. Following the
   * chosen change keeps the reader on it when the list shifts under them, and
   * where that change has gone the nearest row that exists takes over, so the
   * highlight is never on a row the list does not have and Enter is never a
   * no-op. Same rule as a lane leaving the Agents list.
   */
  const found = changes.findIndex((event) => eventKey(event) === selection.id);
  const row =
    found >= 0
      ? found
      : Math.min(selection.index, Math.max(0, changes.length - 1));
  /**
   * Move the highlight. The row and the change it names are recorded together
   * and the change is passed in, so no caller can record a row number without
   * saying which change it points at.
   */
  const select = useCallback(
    (index: number, event: TimelineEvent | undefined) =>
      setSelection({ index, id: event ? eventKey(event) : null }),
    [],
  );
  /**
   * Open a row: the highlight, the recorded identity and the time cursor move
   * as one. Every entry calls this — the keys, the mouse, and a row Home asked
   * for — because a rule written at each entry reaches the entries someone
   * remembered, and the key path was the one that was not.
   */
  const open = useCallback(
    (index: number, event: TimelineEvent) => {
      select(index, event);
      onCursor(event.time);
    },
    [select, onCursor],
  );
  /**
   * A row Home asked for is selected and made the cursor, once. Home lists
   * everything retained, so the row can be older than the window this screen
   * is showing and absent from `changes` entirely. Widening to a window that
   * holds it comes first, and the request is kept until it has been landed
   * on: consuming it before finding the row is the silent no-op where the
   * reader presses a key and the screen looks untouched.
   */
  useEffect(() => {
    if (target === null) return;
    // Found by identity, not by time: every change in one sample shares that
    // sample's time, so matching on the time lands on the first of them
    // whichever row the reader opened.
    const at = changes.findIndex((event) => eventKey(event) === target.id);
    if (at >= 0) {
      open(at, changes[at]);
      onTargetUsed();
      return;
    }
    const wider = windows.findIndex((ms) => s.time - target.at <= ms);
    if (wider >= 0 && wider !== windowIndex) {
      onWindow(wider);
      return;
    }
    // Older than the widest window, so no window can hold it. Retention is
    // capped below that width, so Home cannot list such a row; the request is
    // still consumed rather than left to fire on every later sample.
    onTargetUsed();
  }, [target, onTargetUsed, changes, open, onWindow, windowIndex, s.time]);
  // The header, two three-row charts with titles, the sparklines, the axis
  // and the heading come before the change list.
  // Each row takes its metric's own colour, so six sparklines one under the
  // other are six quantities rather than one wall of amber. Escaped agents and
  // corruption are severities, not metrics, and keep the severity colours.
  const rows = [
    ["CPU wait", "pressure", percent, metric.cpu],
    ["Memory wait", "memoryPressure", percent, metric.memory],
    ["Disk wait", "ioPressure", percent, metric.disk],
    ["Builds", "builds", String, metric.builds],
    ["Escaped", "unconfined", String, ui.warn],
    ["Corruption", "corruption", String, ui.danger],
  ] as const;
  // The window row and its blank, two three-row charts with their titles, the
  // marker strip and the axis, the cursor readings and the section heading.
  // With no sample under the cursor those readings are one line, not a wrapped
  // tile block: budgeting the block on a short first-run Timeline dropped the
  // sparkline rows and left the space they would have taken empty.
  const cursorHeight = selected ? tilesHeight(rows.length, width - 4, 2) : 1;
  // ...and the unit line the selected row can open under itself.
  const fixed = 2 + 4 + 4 + 3 + cursorHeight + 1 + 1;
  // A short terminal keeps the two charts and the change list, and drops the
  // sparkline rows, which the cursor tiles still summarise.
  const short = height < fixed + rows.length + 3;
  const listHeight = Math.max(3, height - (fixed + (short ? 0 : rows.length)));
  // A change row less its marker, its time and its kind, so a long subject is
  // cut with its mark rather than at the edge.
  const subjectWidth = width - 4 - 1 - 13 - 13;
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingX={2}>
      <box flexDirection="row" height={1} flexShrink={0}>
        <Line height={1} flexShrink={0} attributes={ui.dim}>
          {"Last "}
        </Line>
        {windows.map((ms, i) => (
          <Line
            key={ms}
            height={1}
            flexShrink={0}
            fg={i === windowIndex ? ui.accent : undefined}
            attributes={i === windowIndex ? ui.bold : ui.dim}
            onMouseDown={() => onWindow(i)}
          >{`${windowLabel(ms)}  `}</Line>
        ))}
        <Line height={1} flexGrow={1} truncate attributes={ui.dim}>
          {`  cursor ${at === undefined ? "no samples" : new Date(at).toLocaleString()}${selected && selected.time !== at ? ` · sample ${new Date(selected.time).toLocaleTimeString()}` : ""} · ! marks a change`}
        </Line>
      </box>
      <box height={1} flexShrink={0} />
      <box flexDirection="column" flexShrink={0} onMouseDown={onChart}>
        <Chart
          title={`Agents CPU  ${value("agents", percent)}  ${spanLabel(agents, windowMs)}`}
          values={agents}
          height={3}
          max={agentsTop}
          top={percent(agentsTop)}
          color={metric.cpu}
        />
        <Chart
          title={`Memory  ${value("memory", (n) => bytes(n, c))}`}
          values={memory}
          height={3}
          max={memoryTop}
          top={bytes(memoryTop, c)}
          color={metric.memory}
        />
        {!short &&
          rows.map(([label, key, , color]) => {
            const values = peaks(key);
            return (
              <Line key={key} height={1} flexShrink={0} truncate>
                <span attributes={ui.dim}>{fit(label, gutter)}</span>
                <span
                  attributes={readingWeight(
                    Math.max(0, ...values.map((v) => v ?? 0)),
                  )}
                >
                  <Sparkline
                    marks={sparkline(values, chartWidth, c.sparkline)}
                    color={color}
                  />
                </span>
              </Line>
            );
          })}
        <Line height={1} flexShrink={0} truncate>
          <span attributes={ui.dim}>{" ".repeat(gutter)}</span>
          {markerRuns(buckets.map(anyChange), cursorColumn).map((run) => (
            <span
              key={`${run.kind}-${run.at}`}
              fg={
                run.kind === "cursor"
                  ? ui.accent
                  : run.kind === "change"
                    ? ui.warn
                    : undefined
              }
              attributes={run.kind === "quiet" ? ui.dim : ui.none}
            >
              {run.text}
            </span>
          ))}
        </Line>
        <Line height={1} flexShrink={0} truncate attributes={ui.dim}>
          {`${" ".repeat(gutter)}${new Date(start).toLocaleTimeString()}${" ".repeat(Math.max(1, chartWidth - 22))}${new Date(s.time).toLocaleTimeString()}`}
        </Line>
      </box>
      {/* Six readings joined by dots is a run the reader has to parse; one
          tile each names the quantity above its own number. */}
      {selected ? (
        <Tiles width={width - 4}>
          {rows.map(([label, key, format]) => (
            <Tile key={key} label={label} value={value(key, format) || gap} />
          ))}
        </Tiles>
      ) : (
        <Line height={1} flexShrink={0} truncate attributes={ui.dim}>
          No sample under the cursor.
        </Line>
      )}
      <Section
        title="What changed"
        width={width - 4}
        count={changes.length ? `${changes.length}, newest first` : undefined}
      />
      {/* The shared list, which pages around its own selection. Slicing the
          first rows here instead let the selection walk off the end of what
          was drawn, and Enter then acted on a row the reader could not see. */}
      <List
        items={changes}
        selected={row}
        height={listHeight}
        empty="Nothing changed in this window: no lane, cgroup or cause moved."
        render={(event, at, isSelected) => {
          const e = eventParts(event, c);
          const unit = event.names.unit;
          return (
            // One row per event, so a long subject cannot push the rest out.
            <box key={eventKey(event)} flexDirection="column" flexShrink={0}>
              <Row selected={isSelected} onOpen={() => open(at, event)}>
                <span attributes={ui.dim}>{`${e.time.padStart(11)}  `}</span>
                <span
                  fg={levelColor(e.level)}
                  attributes={e.level === "ok" ? ui.none : ui.bold}
                >
                  {fit(e.kind, 13)}
                </span>
                {fit(safe(e.text), subjectWidth)}
              </Row>
              {isSelected && unit && unit !== event.subject && (
                // The subject reads as a name; the unit it decoded from is the
                // handle a reader needs to reach the scope itself.
                <Field label="Unit" value={unit} width={14} />
              )}
            </box>
          );
        }}
      />
    </box>
  );
}
