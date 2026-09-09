import { useState } from "react";
import { type Config, columns, validate } from "../config/config";
import { safe } from "../model/export";
import { lanePressure } from "../model/lanes";
import type { Lane, Snapshot } from "../model/types";
import type { Level } from "../model/verdict";
import type { History } from "../store/history";
import { Agent } from "./agent";
import { narrowWidth } from "./chrome";
import { amount, blockedText, laneValue, share, sortLanes } from "./format";
import { useScreenKeys } from "./keys";
import { levelColor, scrollbar, ui } from "./theme";
import { Bar, Line, List, nextDown, Row } from "./widgets";

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
const widths: Record<string, number> = {
  name: 26,
  account: 14,
  cwd: 30,
  branch: 16,
  tool: 10,
  cgroup: 30,
};
const columnWidth = (column: string) => widths[column] ?? 12;
/** The lanes whose text matches the query, in the configured order. */
export function findLanes(lanes: Lane[], query: string, c: Config): Lane[] {
  const q = query.toLowerCase();
  return sortLanes(
    lanes.filter((lane) =>
      [
        lane.name,
        lane.account ?? "",
        lane.pane,
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
/** The one word that says what is wrong with a lane, or nothing. */
export function laneBadge(lane: Lane): { text: string; level: Level } | null {
  if (lane.unconfined) return { text: "outside agent slice", level: "danger" };
  if (lane.dangerous) return { text: "low memory limit", level: "danger" };
  if (lane.state === "blocked")
    return { text: blockedText(lane), level: "warn" };
  return null;
}
export function laneLevel(lane: Lane, c: Config): Level {
  const wait = lanePressure(lane) ?? 0;
  return lane.unconfined || lane.dangerous || wait > c.pressureRed
    ? "danger"
    : wait > c.pressureAmber
      ? "warn"
      : "ok";
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
}) {
  const [selected, setSelected] = useState(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [table, setTable] = useState(false);
  const [chooser, setChooser] = useState(false);
  const [column, setColumn] = useState(0);
  const lanes = findLanes(s.lanes, query, c);
  const open = laneId === null ? null : s.lanes.find((l) => l.id === laneId);
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
    const index = chooser ? column : selected;
    const move = chooser ? setColumn : setSelected;
    if (name === c.keys.down || name === "down") {
      move(nextDown(rows, index));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      move(Math.max(0, index - 1));
      return true;
    }
    if (name === c.keys.open) {
      if (chooser) toggleColumn(columns[column]);
      else if (lanes[selected]) onOpen(lanes[selected].id);
      return true;
    }
    if (name === c.keys.search) {
      key.preventDefault();
      setSearching(true);
      setSelected(0);
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
    if (name === c.keys.sort) {
      save({
        ...c,
        sort: columns[
          (columns.indexOf(c.sort as (typeof columns)[number]) + 1) %
            columns.length
        ],
      });
      return true;
    }
    if (name === c.keys.reverse) {
      save({ ...c, descending: !c.descending });
      return true;
    }
    return false;
  });
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
      />
    ) : (
      <box paddingX={2}>
        <Line attributes={ui.dim}>This agent is no longer in the sample.</Line>
      </box>
    );
  if (chooser)
    return (
      <box flexDirection="column" paddingX={2}>
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
            <span fg={c.columns.includes(name) ? ui.accent : undefined}>
              {c.columns.includes(name) ? "◉ " : "○ "}
            </span>
            {columnLabels[name] ?? name}
          </Row>
        ))}
      </box>
    );
  const sortLabel = `${columnLabels[c.sort] ?? c.sort} ${c.descending ? "↓" : "↑"}`;
  const listHeight = height - 2 - (searching ? 3 : 0);
  const topCpu = Math.max(100, ...lanes.map((l) => l.cpu ?? 0));
  // Marker, program, bar, CPU, memory, wait and the badge take fixed columns;
  // a narrow terminal drops the program and the wait share.
  const narrow = width < narrowWidth;
  const nameWidth = Math.max(12, Math.min(36, width - 4 - (narrow ? 42 : 62)));
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingX={2}>
      <Line height={1} flexShrink={0} truncate>
        <span
          attributes={ui.bold}
        >{`${lanes.length} ${lanes.length === 1 ? "agent" : "agents"}`}</span>
        <span attributes={ui.dim}>
          {`  sorted by ${sortLabel}${query ? `  matching "${safe(query)}"` : ""}`}
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
            focused
            value={query}
            placeholder="name, account, pane, branch or worktree"
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
          horizontalScrollbarOptions={scrollbar}
          contentOptions={{ flexShrink: 0 }}
        >
          <box flexDirection="column" flexShrink={0}>
            <box height={1} flexShrink={0} flexDirection="row">
              <Line width={1} height={1}>
                {" "}
              </Line>
              {c.columns.map((name) => (
                <Line
                  key={name}
                  width={columnWidth(name)}
                  height={1}
                  flexShrink={0}
                  truncate
                  attributes={c.sort === name ? ui.bold : ui.dim}
                  onMouseDown={() =>
                    save({
                      ...c,
                      sort: name,
                      descending: c.sort === name ? !c.descending : true,
                    })
                  }
                >
                  {`${columnLabels[name] ?? name}${c.sort === name ? (c.descending ? " ↓" : " ↑") : ""}`}
                </Line>
              ))}
            </box>
            <List
              items={lanes}
              selected={selected}
              height={listHeight - 1}
              empty="No agent matches."
              render={(lane, i, isSelected) => (
                <Row
                  key={lane.id}
                  selected={isSelected}
                  color={levelColor(laneLevel(lane, c))}
                  onOpen={() => {
                    setSelected(i);
                    onOpen(lane.id);
                  }}
                >
                  {c.columns
                    .map((name) =>
                      safe(laneValue(lane, name, c))
                        .padEnd(columnWidth(name))
                        .slice(0, columnWidth(name) - 1),
                    )
                    .join(" ")}
                </Row>
              )}
            />
          </box>
        </scrollbox>
      ) : (
        <List
          items={lanes}
          selected={selected}
          height={listHeight}
          empty={
            query
              ? "No agent matches."
              : "No process runs in a watched scope, and no agent has escaped one."
          }
          render={(lane, i, isSelected) => {
            const badge = laneBadge(lane);
            return (
              <Row
                key={lane.id}
                selected={isSelected}
                color={levelColor(laneLevel(lane, c))}
                onOpen={() => {
                  setSelected(i);
                  onOpen(lane.id);
                }}
              >
                {safe(lane.name.padEnd(nameWidth).slice(0, nameWidth))}
                {!narrow && (
                  <span attributes={ui.dim}>
                    {` ${safe((lane.tool || "").padEnd(9).slice(0, 9))}`}
                  </span>
                )}{" "}
                <Bar
                  value={lane.cpu}
                  max={topCpu}
                  width={10}
                  level={laneLevel(lane, c)}
                />
                {` ${share(lane.cpu).padStart(7)} ${amount(lane.rss, c).padStart(10)}`}
                {!narrow && ` ${share(lane.pressure).padStart(6)} wait`}
                {badge ? (
                  <span fg={levelColor(badge.level)}>{`  ${badge.text}`}</span>
                ) : (
                  <span attributes={ui.dim}>{`  ${lane.state}`}</span>
                )}
              </Row>
            );
          }}
        />
      )}
    </box>
  );
}
