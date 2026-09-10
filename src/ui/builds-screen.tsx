import { useState } from "react";
import { compileOrLink } from "../collect/builds";
import type { Config } from "../config/config";
import { buildsSummary, type Rates } from "../model/builds";
import { safe } from "../model/export";
import type { Snapshot } from "../model/types";
import { meters } from "../model/verdict";
import { meterTile } from "./attention";
import { keyLabel } from "./chrome";
import { type Column, cell, columnGap, columnsWidth, fit } from "./columns";
import { age, bytes, count, gap, percent, share } from "./format";
import { useScreenKeys } from "./keys";
import { metric, ui } from "./theme";
import {
  Bar,
  Empty,
  Line,
  List,
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
  const rows = summary.rows;
  const fixed: Column[] = [
    { label: "", width: 10 },
    { label: "Building", width: 14, align: "right" as const },
    { label: "Linkers", width: 30 },
  ];
  const buildColumns: Column[] = [
    {
      label: "Lane",
      width: Math.max(12, Math.min(40, width - 5 - columnsWidth(fixed))),
    },
    ...fixed,
  ];
  const [nameColumn, barColumn, countColumn] = buildColumns;
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
    return false;
  });
  const current = rows[Math.min(selected, rows.length - 1)];
  const lane = current ? s.lanes.find((l) => l.id === current.id) : undefined;
  const owned = new Set(s.lanes.flatMap((l) => l.pids));
  const procs = current
    ? s.procs
        .filter(
          (p) =>
            compileOrLink(p.build, c.compilerNames, c.linkerNames) &&
            (current.id ? lane?.pids.includes(p.pid) : !owned.has(p.pid)),
        )
        .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0))
    : [];
  const cache = summary.cache;
  const meter = meters(s, c).find((m) => m.id === "builds");
  if (!meter) throw new Error("The verdict model has no builds meter");
  const total = meterTile(meter, s, c);
  const topBuilds = Math.max(1, ...rows.map((r) => r.builds));
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingX={2}>
      <Tiles>
        <Tile
          label="Compile and link"
          value={total.value}
          level={total.level}
          detail={total.detail}
        />
        <Tile
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
          label="Make tokens"
          value={
            summary.jobservers.length
              ? summary.jobservers
                  .map((j) => `${j.inUse} of ${j.total ?? gap}`)
                  .join(", ")
              : "no pool"
          }
          detail={
            summary.jobservers.map((j) => j.fifo).join(", ") ||
            "no make jobserver in use"
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
        count={rows.length || undefined}
      />
      {rows.length > 0 && <TableHeader columns={buildColumns} />}
      {!rows.length && <Empty text="Nothing is compiling or linking." />}
      <List
        items={rows}
        selected={selected}
        height={Math.max(3, Math.floor((height - 8) / 2))}
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
            {columnGap}
            <span attributes={ui.dim}>
              {`${count(row.linkers, "linker")}${row.linkerNames.length ? ` (${row.linkerNames.join(", ")})` : ""}`}
            </span>
          </Row>
        )}
      />
      {processes && current && (
        <box flexDirection="column" flexShrink={0} marginTop={1}>
          <Section
            title={`Processes in ${current.name || "no watched lane"}`}
            width={width}
            count={procs.length}
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
