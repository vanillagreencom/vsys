import type { RGBA } from "@opentui/core";
import type { TextProps } from "@opentui/react";
import type { ReactNode } from "react";
import { safe } from "../model/export";
import type { Level } from "../model/verdict";
import { levelColor, ui } from "./theme";

/**
 * A text line in the terminal's own foreground. OpenTUI paints text white
 * unless told otherwise, so every line on screen goes through here.
 */
export function Line(props: TextProps) {
  return <text fg={ui.fg} {...props} />;
}

/** A section title: the name in bold, an optional count beside it in dim. */
export function Heading({
  title,
  count,
  marginTop = 1,
}: {
  title: string;
  count?: number | string;
  marginTop?: number;
}) {
  return (
    <Line height={1} flexShrink={0} truncate marginTop={marginTop}>
      <span attributes={ui.bold}>{title}</span>
      {count !== undefined && <span attributes={ui.dim}>{`  ${count}`}</span>}
    </Line>
  );
}

/** A quiet one-line message for a list with nothing in it. */
export function Empty({ text }: { text: string }) {
  return (
    <Line flexShrink={0} attributes={ui.dim} wrapMode="word">
      {text}
    </Line>
  );
}

/** A dim label followed by its value on one line. */
export function Field({
  label,
  value,
  width = 12,
  color,
}: {
  label: string;
  value: string;
  width?: number;
  color?: RGBA;
}) {
  return (
    <Line height={1} flexShrink={0} truncate>
      <span attributes={ui.dim}>{label.padEnd(width)}</span>
      <span fg={color}>{safe(value)}</span>
    </Line>
  );
}

/**
 * A horizontal meter. The filled part takes the level colour; the rest stays
 * dim so an empty meter is visible without shouting.
 */
export function bar(value: number | null, max: number, width: number): string {
  if (width < 1) return "";
  const filled =
    value === null || max <= 0
      ? 0
      : Math.round((Math.max(0, Math.min(value, max)) / max) * width);
  return "█".repeat(filled);
}
export function Bar({
  value,
  max,
  width,
  level = "ok",
}: {
  value: number | null;
  max: number;
  width: number;
  level?: Level;
}) {
  const filled = bar(value, max, width);
  return (
    <>
      <span fg={levelColor(level)}>{filled}</span>
      <span attributes={ui.dim}>{"░".repeat(width - filled.length)}</span>
    </>
  );
}

/**
 * A headline number with its name above and one line of context below. Tiles
 * sit side by side in a row and share the width equally.
 */
export function Tile({
  label,
  value,
  level = "ok",
  detail,
  chart,
}: {
  label: string;
  value: string;
  level?: Level;
  detail: string;
  /** A one-row sparkline under the number, when history exists. */
  chart?: string;
}) {
  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      <Line height={1} truncate attributes={ui.dim}>
        {label}
      </Line>
      <Line height={1} truncate>
        <span fg={levelColor(level)} attributes={ui.bold}>
          {safe(value)}
        </span>
      </Line>
      {chart !== undefined && (
        <Line height={1} truncate fg={levelColor(level)}>
          {chart}
        </Line>
      )}
      <Line height={1} truncate attributes={ui.dim}>
        {safe(detail)}
      </Line>
    </box>
  );
}

/** A row of tiles with a gap between them. */
export function Tiles({ children }: { children: ReactNode }) {
  return (
    <box flexDirection="row" flexShrink={0} gap={2}>
      {children}
    </box>
  );
}

/**
 * One selectable line. The selected line carries a marker in the accent
 * colour, so selection never repaints the whole row.
 */
export function Row({
  selected,
  children,
  onOpen,
  color,
}: {
  selected: boolean;
  children: ReactNode;
  onOpen?: () => void;
  color?: RGBA;
}) {
  return (
    <Line
      height={1}
      flexShrink={0}
      truncate
      fg={color}
      attributes={selected ? ui.bold : ui.none}
      onMouseDown={onOpen}
    >
      <span fg={ui.accent}>{selected ? "▍" : " "}</span>
      {children}
    </Line>
  );
}

/**
 * A list windowed to the rows it has. Selection owns paging: the selected row
 * stays in view and the viewport never moves on its own.
 */
export function List<T>({
  items,
  selected,
  height,
  rowHeight = 1,
  render,
  empty,
}: {
  items: T[];
  selected: number;
  height: number;
  rowHeight?: number;
  render: (item: T, index: number, selected: boolean) => ReactNode;
  empty: string;
}) {
  if (!items.length) return <Empty text={empty} />;
  const count = Math.max(1, Math.floor((height - 1) / rowHeight));
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(count / 2), items.length - count),
  );
  const end = Math.min(items.length, start + count);
  return (
    <box flexDirection="column" flexShrink={0}>
      {items
        .slice(start, end)
        .map((item, i) => render(item, start + i, start + i === selected))}
      {items.length > count && (
        <Line height={1} flexShrink={0} truncate attributes={ui.dim}>
          {`${start + 1}–${end} of ${items.length}`}
        </Line>
      )}
    </box>
  );
}

/**
 * A multi-row chart of one series. Each column is a peak over its bucket,
 * drawn in eighths so a short spike stays visible. A column with no sample
 * shows a dot on the base line, which keeps collection gaps honest.
 */
export function chartRows(
  values: (number | null)[],
  height: number,
  max: number,
): string[] {
  const marks = "▁▂▃▄▅▆▇█";
  const rows: string[] = [];
  for (let row = 0; row < height; row++) {
    const below = (height - 1 - row) * 8;
    rows.push(
      values
        .map((v) => {
          if (v === null) return row === height - 1 ? "·" : " ";
          const eighths = Math.round(
            (Math.max(0, v) / Math.max(max, 1)) * height * 8,
          );
          const fill = Math.max(0, Math.min(8, eighths - below));
          if (fill === 0) return row === height - 1 && v > 0 ? "▁" : " ";
          return marks[fill - 1];
        })
        .join(""),
    );
  }
  return rows;
}
/** The columns a chart's axis labels take, shared with any label beside a sparkline. */
export const gutter = 13;
export function Chart({
  title,
  values,
  height,
  max,
  top,
  color = ui.fg,
  cursor,
}: {
  title: string;
  values: (number | null)[];
  height: number;
  /** The value the top of the chart stands for. */
  max: number;
  /** Its label, formatted by the caller. */
  top: string;
  color?: RGBA;
  /** A column to mark under the chart, when a time cursor sits on it. */
  cursor?: number;
}) {
  const rows = chartRows(values, height, max);
  return (
    <box flexDirection="column" flexShrink={0}>
      <Line height={1} truncate>
        <span attributes={ui.bold}>{title}</span>
      </Line>
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a chart row is its height
        <Line key={`${title}-${i}`} height={1} truncate>
          <span attributes={ui.dim}>
            {(i === 0 ? top : i === rows.length - 1 ? "0" : "").padStart(
              gutter - 1,
            )}{" "}
          </span>
          <span fg={color}>{row}</span>
        </Line>
      ))}
      {cursor !== undefined && (
        <Line height={1} truncate>
          <span attributes={ui.dim}>{" ".repeat(gutter)}</span>
          <span fg={ui.accent}>{`${" ".repeat(Math.max(0, cursor))}▲`}</span>
        </Line>
      )}
    </box>
  );
}

/**
 * A short notice in the top-right corner. It sits above the screen and goes
 * away by itself, so a new alert is seen without changing the current view.
 */
export function Toast({ text, level }: { text: string; level: Level }) {
  return (
    <box
      position="absolute"
      top={1}
      right={1}
      zIndex={10}
      border
      borderStyle="rounded"
      borderColor={levelColor(level)}
      paddingX={1}
      maxWidth="60%"
    >
      <Line wrapMode="word" fg={levelColor(level)}>
        {safe(text)}
      </Line>
    </box>
  );
}

/** A centred panel over the screen, used for help. */
export function Overlay({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <box
      position="absolute"
      top={2}
      left={4}
      right={4}
      bottom={2}
      zIndex={20}
      border
      borderStyle="rounded"
      borderColor={ui.accent}
      title={` ${title} `}
      paddingX={2}
      paddingY={1}
      flexDirection="column"
      backgroundColor={ui.bg}
    >
      {children}
    </box>
  );
}
