import { useState } from "react";
import { compileOrLink } from "../collect/builds";
import type { Config } from "../config/config";
import { buildsSummary, type Rates } from "../model/builds";
import { safe } from "../model/export";
import type { Snapshot } from "../model/types";
import { meters } from "../model/verdict";
import { meterTile } from "./attention";
import { keyLabel } from "./chrome";
import {
  type Column,
  cell,
  columnGap,
  columnsWidth,
  fit,
  pidCell,
  pidColumn,
} from "./columns";
import { age, bytes, count, gap, percent, share } from "./format";
import { heldCount, heldOrder, useHeldOrder } from "./hold";
import { useScreenKeys } from "./keys";
import { metric, ui } from "./theme";
import {
  Bar,
  Line,
  List,
  Nothing,
  nextDown,
  Reading,
  Row,
  Section,
  TableHeader,
  Tile,
  Tiles,
} from "./widgets";

/** The cache reading in one clause, with the window it was measured over. */
export function cacheText(r: Rates | null): string {
  if (r === null) return gap;
  const over =
    r.windowMs > 0 ? `over ${age(r.windowMs / 1000)}` : "over no elapsed time";
  if (r.rate === null) return `no requests ${over}`;
  return `${share(r.rate)} hits · ${count(r.hits, "hit")}, ${count(r.misses, "miss", "misses")} ${over}`;
}

/** Compile and link work: the fleet total, each lane's share, then the processes. */
export function Builds({
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
  const [processes, setProcesses] = useState(false);
  const summary = buildsSummary(s, c);
  // One key holds both lists. Each is every row there is, every lane building
  // and every build process of the selected lane, so a row that starts while
  // the order is held is appended rather than hidden.
  const hold = useHeldOrder();
  const rows = heldOrder(
    summary.rows,
    hold.kept("lanes"),
    (row) => row.id,
    "append",
  );
  hold.drew(
    "lanes",
    rows.map((row) => row.id),
  );
  // The id for the same reason every other lane list carries one: two lanes
  // that resolve to one name are told apart by a column, never by a suffix on
  // the name. The catch-all row for work outside every lane leads no process,
  // so its cell is blank rather than a made-up zero.
  //
  // The name keeps its floor and the id is never given up, so a narrow screen
  // narrows the linkers column instead, and drops it where even its heading
  // would leave the name short.
  const nameFloor = 12;
  const core: Column[] = [
    pidColumn,
    { label: "", width: 10 },
    { label: "Building", width: 14, align: "right" as const },
  ];
  const linkersRoom =
    width - 5 - columnsWidth(core) - columnGap.length - nameFloor;
  const linkerColumn: Column | undefined =
    linkersRoom >= "Linkers".length
      ? { label: "Linkers", width: Math.min(30, linkersRoom) }
      : undefined;
  const fixed = linkerColumn ? [...core, linkerColumn] : core;
  const buildColumns: Column[] = [
    {
      label: "Lane",
      width: Math.max(nameFloor, Math.min(40, width - 5 - columnsWidth(fixed))),
    },
    ...fixed,
  ];
  const [nameColumn, , barColumn, countColumn] = buildColumns;
  useScreenKeys((name) => {
    if (name === c.keys.down || name === "down") {
      setSelected((i) => nextDown(rows.length, i));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      setSelected((i) => Math.max(0, i - 1));
      return true;
    }
    if (name === c.keys.open && rows.length) {
      setProcesses((v) => !v);
      return true;
    }
    if (name === c.keys.back && processes) {
      setProcesses(false);
      return true;
    }
    if (name === c.keys.hold) {
      hold.toggle();
      return true;
    }
    return false;
  });
  const current = rows[Math.min(selected, rows.length - 1)];
  const lane = current ? s.lanes.find((l) => l.id === current.id) : undefined;
  const owned = new Set(s.lanes.flatMap((l) => l.pids));
  const procs = heldOrder(
    current
      ? s.procs
          .filter(
            (p) =>
              compileOrLink(p.build, c.compilerNames, c.linkerNames) &&
              (current.id ? lane?.pids.includes(p.pid) : !owned.has(p.pid)),
          )
          .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0))
      : [],
    hold.kept("processes"),
    (p) => String(p.pid),
    "append",
  );
  hold.drew(
    "processes",
    procs.map((p) => String(p.pid)),
  );
  const cache = summary.cache;
  const meter = meters(s, c).find((m) => m.id === "builds");
  if (!meter) throw new Error("The verdict model has no builds meter");
  const total = meterTile(meter, s, c);
  const topBuilds = Math.max(1, ...rows.map((r) => r.builds));
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingX={2}>
      <Tiles width={width}>
        <Tile
          key="Compile and link"
          label="Compile and link"
          value={total.value}
          level={total.level}
          detail={total.detail}
        />
        <Tile
          key="Cache hits"
          label="Cache hits"
          value={
            cache.available && cache.recent ? share(cache.recent.rate) : gap
          }
          level={cache.bypassed.length ? "warn" : "ok"}
          detail={
            cache.available
              ? `since start ${cacheText(cache.sinceStart)}`
              : "sccache is not running"
          }
        />
        <Tile
          key="Make tokens"
          label="Make tokens"
          value={
            summary.jobservers.length
              ? summary.jobservers
                  .map((j) =>
                    j.total === null
                      ? `${j.inUse} in use`
                      : `${j.inUse} of ${j.total}`,
                  )
                  .join(", ")
              : "no pool"
          }
          detail={
            summary.jobservers.length
              ? `${summary.jobservers.map((j) => j.fifo).join(", ")}${
                  summary.jobservers.some((j) => j.total === null)
                    ? " · pool size not stated in the build flags"
                    : ""
                }`
              : "no make jobserver in use"
          }
        />
      </Tiles>
      {cache.bypassed.length > 0 && (
        <Line flexShrink={0} wrapMode="word" fg={ui.warn} marginTop={1}>
          {safe(
            `sccache is bypassed in ${cache.bypassed.join(", ")}: RUSTC_WRAPPER is empty there, so those compilations never reach the cache.`,
          )}
        </Line>
      )}
      <Section
        title="Lanes building"
        width={width}
        count={heldCount(rows.length || undefined, hold.held)}
      />
      {rows.length > 0 && <TableHeader columns={buildColumns} />}
      {!rows.length && (
        <Nothing
          text="Nothing is compiling or linking."
          next="A lane appears here as soon as it starts a compiler or a linker, with its process count and its linkers named."
        />
      )}
      {rows.length > 0 && (
        <List
          items={rows}
          selected={selected}
          height={Math.max(3, Math.floor((height - 8) / 2))}
          onSelect={setSelected}
          empty=""
          render={(row, i, isSelected) => (
            <Row
              key={row.id || "outside"}
              selected={isSelected}
              onOpen={() => {
                setSelected(i);
                setProcesses(true);
              }}
            >
              {safe(cell(nameColumn, row.name || "outside the watched lanes"))}
              <span attributes={ui.dim}>
                {`${columnGap}${pidCell(row.mainPid)}`}
              </span>
              {columnGap}
              <Bar
                value={row.builds}
                max={topBuilds}
                width={barColumn.width}
                color={metric.builds}
              />
              {columnGap}
              <Reading
                value={row.builds}
                text={cell(
                  countColumn,
                  `${row.builds} ${row.builds === 1 ? "process" : "processes"}`,
                )}
              />
              {linkerColumn && (
                <span attributes={ui.dim}>
                  {`${columnGap}${cell(
                    linkerColumn,
                    `${count(row.linkers, "linker")}${row.linkerNames.length ? ` (${row.linkerNames.join(", ")})` : ""}`,
                  )}`}
                </span>
              )}
            </Row>
          )}
        />
      )}
      {processes && current && (
        <box flexDirection="column" flexShrink={0} marginTop={1}>
          <Section
            title={`Processes in ${current.name || "no watched lane"}`}
            width={width}
            count={heldCount(procs.length, hold.held)}
            marginTop={0}
          />
          <Line height={1} flexShrink={0} truncate attributes={ui.dim}>
            {
              "PID      kind        CPU     threads  memory     age    directory"
            }
          </Line>
          {procs
            .slice(0, Math.max(1, Math.floor((height - 8) / 2) - 2))
            .map((p) => (
              <Line key={p.pid} height={1} flexShrink={0} truncate>
                {safe(
                  `${fit(String(p.pid), 8)} ${fit(p.build ?? "", 11)} ${percent(p.cpuPercent).padStart(6)} ${String(p.threads).padStart(8)}  ${bytes(p.rss, c).padStart(9)}  ${age(p.age).padStart(5)}  ${p.cwd ?? gap}`,
                )}
              </Line>
            ))}
        </box>
      )}
      {!processes && rows.length > 0 && (
        <Line
          height={1}
          flexShrink={0}
          truncate
          attributes={ui.dim}
          marginTop={1}
        >
          {`${keyLabel(c.keys.open)} lists the processes of the selected lane`}
        </Line>
      )}
    </box>
  );
}
