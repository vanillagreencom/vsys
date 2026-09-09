import { useState } from "react";
import type { Config } from "../config/config";
import { safe } from "../model/export";
import { dangerousCap } from "../model/lanes";
import type { Group, Snapshot } from "../model/types";
import { type Level, meters } from "../model/verdict";
import { meterTile } from "./attention";
import { amount, bytes, gap, percent, share } from "./format";
import { useScreenKeys } from "./keys";
import { levelColor, ui } from "./theme";
import { Bar, Field, Heading, List, nextDown, Row } from "./widgets";

/** A group with nothing running and little memory is noise until asked for. */
export function idle(g: Group): boolean {
  return (
    !g.name.endsWith(".slice") &&
    g.path !== "." &&
    (g.cpuPercent ?? 0) < 0.5 &&
    (g.memory ?? 0) < 64 * 1024 * 1024
  );
}
/** The rows Resources lists, in tree order, with idle leaves hidden unless asked. */
export function groupRows(s: Snapshot, all: boolean): Group[] {
  return s.groups.filter((g) => all || !idle(g));
}
export function groupLevel(g: Group, s: Snapshot, c: Config): Level {
  if (
    dangerousCap(g, s.groups, c.memoryFloor) ||
    s.lanes.some((l) => l.id === g.path && l.unconfined)
  )
    return "danger";
  const worst = Math.max(...Object.values(g.pressure).map((p) => p?.some ?? 0));
  if (worst > c.pressureRed) return "danger";
  if (worst > c.pressureAmber) return "warn";
  if (g.memory !== null && g.high !== null && g.memory >= g.high * 0.9)
    return "warn";
  return "ok";
}

/** The machine's meters, then the resource groups as a tree. */
export function Resources({
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
  const [all, setAll] = useState(false);
  const rows = groupRows(s, all);
  const hidden = s.groups.length - rows.length;
  useScreenKeys((name) => {
    if (name === c.keys.down || name === "down") {
      setSelected((i) => nextDown(rows.length, i));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      setSelected((i) => Math.max(0, i - 1));
      return true;
    }
    if (name === c.keys.details) {
      setAll((v) => !v);
      setSelected(0);
      return true;
    }
    return false;
  });
  const tiles = meters(s, c)
    .filter((m) => m.id !== "builds")
    .map((m) => meterTile(m, s, c));
  const limit = (v: number | null) => (v === null ? "none" : bytes(v, c));
  const { SwapTotal, SwapFree } = s.system.memory;
  const swapUsed =
    SwapTotal === undefined || SwapFree === undefined
      ? null
      : SwapTotal - SwapFree;
  const current = rows[Math.min(selected, rows.length - 1)];
  const topCpu = Math.max(100, ...rows.map((g) => g.cpuPercent ?? 0));
  const topMemory = Math.max(1, ...rows.map((g) => g.memory ?? 0));
  const nameWidth = Math.max(12, Math.min(44, width - 4 - 50));
  // Four machine lines, the heading, and the detail block under the list.
  const listHeight = height - 4 - 2 - 4;
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingX={2}>
      {tiles.map((tile) => (
        <Field
          key={tile.label}
          label={tile.label}
          value={tile.facts
            .map(([k, v]) => `${k.toLowerCase()} ${v}`)
            .join(" · ")}
          color={levelColor(tile.level)}
        />
      ))}
      <Field
        label="Swap"
        value={`${amount(swapUsed, c)} of ${amount(s.system.memory.SwapTotal ?? null, c)}${s.system.zram
          .map(
            (z) =>
              ` · ${z.device} holds ${bytes(z.original, c)} in ${bytes(z.compressed, c)}`,
          )
          .join("")}`}
      />
      <Heading
        title="Groups"
        count={`${rows.length}${hidden ? ` shown · ${hidden} idle hidden · ${c.keys.details} shows all` : ""}`}
      />
      <List
        items={rows}
        selected={selected}
        height={listHeight}
        empty="No resource group could be read."
        render={(g, i, isSelected) => {
          const depth = g.path === "." ? 0 : g.path.split("/").length;
          const name = `${"  ".repeat(depth)}${g.path === "." ? "session" : g.name}`;
          return (
            <Row
              key={g.path}
              selected={isSelected}
              color={levelColor(groupLevel(g, s, c))}
              onOpen={() => setSelected(i)}
            >
              {safe(name.padEnd(nameWidth).slice(0, nameWidth))}{" "}
              <Bar value={g.cpuPercent} max={topCpu} width={8} />
              {` ${share(g.cpuPercent).padStart(7)} `}
              <Bar value={g.memory} max={topMemory} width={8} />
              {` ${amount(g.memory, c).padStart(10)}`}
              <span attributes={ui.dim}>{`  ${g.tasks ?? gap} tasks`}</span>
            </Row>
          );
        }}
      />
      {current && (
        <box flexDirection="column" flexShrink={0} marginTop={1}>
          <Field
            label="Limits"
            value={`memory high ${limit(current.high)} · max ${current.maxRead ? limit(current.max) : gap} · swap ${amount(current.swap, c)} of ${limit(current.swapMax)} · tasks max ${current.tasksMax ?? "none"}`}
          />
          <Field
            label="CPU"
            value={`weight ${current.weight ?? gap} · quota ${current.cpuMax ?? gap} · page cache ${amount(current.cache, c)} · written ${current.writeRate === null ? gap : `${bytes(current.writeRate, c)}/s`}`}
          />
          <Field
            label="Waiting"
            value={Object.entries(current.pressure)
              .map(([kind, p]) => `${kind} ${percent(p?.some)}`)
              .join(" · ")}
          />
        </box>
      )}
    </box>
  );
}
