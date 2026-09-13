import type { RGBA, ScrollBoxRenderable } from "@opentui/core";
import type { TextProps } from "@opentui/react";
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
} from "react";
import { safe } from "../model/export";
import type { Level } from "../model/verdict";
import { type Column, fit, headerText, sortedColumns } from "./columns";
import { levelColor, readingWeight, ui } from "./theme";

/**
 * The colour of the band a selected row is drawn as, while the row is
 * selected and has a colour of its own. `Row` provides it; `Ink`, `Bar` and
 * `Sparkline` read it.
 */
const Band = createContext<RGBA | undefined>(undefined);
/**
 * The colour a word or a mark on a row is drawn in. On a selected row's band
 * of one colour, a word in that same colour would vanish into it, so it takes
 * the band's text colour, the one the row's own words take.
 */
function useInk(colour: RGBA | undefined): RGBA | undefined {
  const band = useContext(Band);
  return band && colour?.equals(band) ? ui.fg : colour;
}
/** A coloured word on a row, which stays readable when the row is selected. */
export function Ink({
  color,
  attributes,
  children,
}: {
  color?: RGBA;
  attributes?: number;
  children: ReactNode;
}) {
  return (
    <span fg={useInk(color)} attributes={attributes}>
      {children}
    </span>
  );
}

/**
 * Keeps the thing the reader is standing on where they can see it, in a box
 * they can also scroll themselves.
 *
 * Asked of the drawing rather than enumerated from state: a list of the state
 * that can move a row misses whatever moves it next, such as a capture arriving
 * above the selected row or the focus moving from a list to the tiles.
 *
 * There are two questions here and they have different answers.
 *
 * The reader moved: the target's id is not the one it was. Go to it, wherever
 * it is. That is the whole of what a selection following its reader means.
 *
 * The drawing moved under a reader who did not: the id is the same and the
 * target sits somewhere else in the content. Chase it only if it has left the
 * screen, and only once the reader has chosen something. Without that second
 * half, a screen still assembling itself chases its own rows and opens a line
 * down from its own top, on the runs where its charts happen to arrive late.
 * Without the first, a capture landing above the selected row leaves the
 * reader pressing keys on a row that is no longer drawn.
 *
 * The position asked for is the target's place in the content: its screen `y`
 * plus how far the content is scrolled. That sum is the one number the
 * reader's own scrolling leaves alone, and these boxes do take the wheel, so
 * without it every turn of it would read as the drawing moving.
 *
 * The reading is taken on a timeout because a row that has just grown does not
 * know its size until the layout after the render that grew it.
 */
export function useKeepInView(
  scroller: RefObject<ScrollBoxRenderable | null>,
  /** The id of the child to keep in view, which may change between renders. */
  target: string,
) {
  const placed = useRef<{ id: string; at: number } | null>(null);
  const wanted = useRef(target);
  wanted.current = target;
  // Whether the reader has ever chosen anything on this screen. Until they
  // have, there is nothing to keep in view: a screen drawing itself moves its
  // own rows, and chasing them opens the screen part-way down.
  const moved = useRef(false);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const place = () => {
      const box = scroller.current;
      const id = wanted.current;
      const child = box?.content.findDescendantById(id);
      if (!box || !child) return;
      const top = box.viewport.y;
      const seen =
        child.y >= top && child.y + child.height <= top + box.viewport.height;
      const at = child.y + box.scrollTop;
      const was = placed.current;
      placed.current = { id, at };
      if (!was) return;
      if (was.id !== id) {
        moved.current = true;
        box.scrollChildIntoView(id);
        return;
      }
      if (moved.current && was.at !== at && !seen) box.scrollChildIntoView(id);
    };
    // The first reading has to be a settled one: read early, the target's own
    // height is a layout behind, and a row that will be below the fold reports
    // itself on screen. Taken as the baseline, that early reading makes the
    // settled one look like a row that has left the screen.
    if (placed.current !== null) place();
    // One reading in flight, and the render that follows does not cancel it: a
    // reader holding a key down renders faster than a timeout fires, so a
    // render that cancelled would starve every reading. A late reading asks the
    // box its own question when it runs and takes the target from a ref, so it
    // is a current one.
    if (pending.current === null)
      pending.current = setTimeout(() => {
        pending.current = null;
        place();
      }, 0);
  });
  // Nothing to depend on: the unmount is the whole of the reason this runs.
  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );
}

/**
 * A text line in the terminal's own foreground. OpenTUI paints text a fixed
 * white unless told otherwise, so every line on screen goes through here. A
 * caller's `fg={undefined}` counts as not telling it, so the fallback is
 * applied after the caller's props, not before. Text dragged over with the
 * mouse is otherwise painted a fixed black on its own foreground, so a
 * selection takes the selected row's grey.
 */
export function Line(props: TextProps) {
  return (
    <text
      {...props}
      fg={props.fg ?? ui.fg}
      selectionBg={props.selectionBg ?? ui.quiet}
    />
  );
}

/**
 * A section: the name in bold, an optional count beside it, and a dim rule to
 * the panel edge so the reader sees where one section ends and the next
 * begins. A section is never boxed; a box is for what floats above the screen.
 */
export function Section({
  title,
  count,
  width,
  marginTop = 1,
  focused = false,
  hotkey,
}: {
  title: string;
  count?: number | string;
  /** The panel's inner width, which the rule runs to. */
  width: number;
  marginTop?: number;
  /**
   * The region the arrows are moving inside. Its title takes the accent colour
   * and its rule stops being dim, so a reader never has to press a key to find
   * out where they are.
   */
  focused?: boolean;
  /**
   * The key that jumps to this section, drawn dim before the title the way the
   * tab bar draws a screen's key before its name. React keeps `key` for itself
   * and never passes it to a component, hence the name.
   */
  hotkey?: string;
}) {
  const lead = hotkey === undefined ? "" : `${hotkey} `;
  const label = `${lead}${count === undefined ? title : `${title}  ${count}`}`;
  const rule = Math.max(0, width - [...label].length - 1);
  return (
    <Line height={1} flexShrink={0} truncate marginTop={marginTop}>
      {hotkey !== undefined && <span attributes={ui.dim}>{lead}</span>}
      <span attributes={ui.bold} fg={focused ? ui.accent : undefined}>
        {title}
      </span>
      {count !== undefined && <span attributes={ui.dim}>{`  ${count}`}</span>}
      <span attributes={focused ? ui.none : ui.dim}>
        {` ${"─".repeat(rule)}`}
      </span>
    </Line>
  );
}
/**
 * The one marker for a row that has more inside it: closed, open, and how much
 * is in there. It is drawn whether or not anything is open, so a reader can see
 * what is worth opening without opening it.
 */
export function Disclosure({
  open,
  name,
  count,
}: {
  open: boolean;
  name: string;
  count?: number | string;
}) {
  return (
    <>
      <span fg={ui.accent}>{open ? "▾ " : "▸ "}</span>
      {safe(name)}
      {count !== undefined && <span attributes={ui.dim}>{`  ${count}`}</span>}
    </>
  );
}
/**
 * The heading over a table, built from the column spec its rows read, so a
 * width changed in one place moves both. The selection marker takes the first
 * column of every row, so the heading starts one column in.
 */
export function TableHeader({
  columns,
  sort,
}: {
  columns: Column[];
  /**
   * The heading the rows are sorted by, and which way. Without it a reader
   * has to remember what they pressed; with it the answer is on the screen
   * where the sorting shows.
   */
  sort?: { label: string; descending: boolean };
}) {
  return (
    <Line height={1} flexShrink={0} truncate attributes={ui.dim}>
      {` ${headerText(sortedColumns(columns, sort))}`}
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
/**
 * The middle of an otherwise blank screen: what is not happening, and what
 * will appear here when it does. A message in the top-left corner of fifty
 * empty rows reads as a screen that failed to draw.
 */
export function Nothing({ text, next }: { text: string; next: string }) {
  return (
    <box
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <Line flexShrink={0} attributes={ui.dim} wrapMode="word">
        {text}
      </Line>
      <Line flexShrink={0} attributes={ui.dim} wrapMode="word">
        {next}
      </Line>
    </box>
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
      <span attributes={ui.dim}>{fit(label, width)}</span>
      <span fg={color}>{safe(value)}</span>
    </Line>
  );
}

/** The filled part of a meter, in eighths of nothing: whole cells only. */
export function bar(value: number | null, max: number, width: number): string {
  if (width < 1) return "";
  const filled =
    value === null || max <= 0
      ? 0
      : Math.round((Math.max(0, Math.min(value, max)) / max) * width);
  return "█".repeat(filled);
}
/**
 * The unfilled part is a rail rather than a shaded block: thirty rows of
 * near-empty bars would otherwise lay a grey slab across the screen.
 */
export function Bar({
  value,
  max,
  width,
  level = "ok",
  color,
}: {
  value: number | null;
  max: number;
  width: number;
  level?: Level;
  /** Overrides the severity colour where a bar draws one named metric. */
  color?: RGBA;
}) {
  const filled = bar(value, max, width);
  const ink = useInk(color ?? levelColor(level));
  return (
    <>
      <span fg={ink}>{filled}</span>
      <span fg={ui.fg} attributes={ui.dim}>
        {"─".repeat(width - filled.length)}
      </span>
    </>
  );
}
/**
 * A one-row chart. Columns with no sample are drawn quietly, so a window vsys
 * has not filled yet reads as waiting rather than as lost data.
 */
export function Sparkline({ marks, color }: { marks: string; color?: RGBA }) {
  const ink = useInk(color);
  return (
    <>
      {gapRuns(marks).map((run) => (
        <span
          key={`${run.at}`}
          fg={run.sampled ? ink : ui.fg}
          attributes={run.sampled ? ui.none : ui.dim}
        >
          {run.text}
        </span>
      ))}
    </>
  );
}
/** A number in a table cell: a zero recedes, a reading keeps its weight. */
export function Reading({
  value,
  text,
  color,
}: {
  value: number | null | undefined;
  text: string;
  color?: RGBA;
}) {
  return (
    <span fg={color} attributes={readingWeight(value)}>
      {text}
    </span>
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
  selected = false,
  chart,
  chartColor,
  width,
  onOpen,
}: {
  label: string;
  value: string;
  level?: Level;
  /** Omitted where the number needs no context, which drops its row. */
  detail?: string;
  /** Marked when the reader has moved the selection onto this tile. */
  selected?: boolean;
  /** A one-row sparkline under the number, when history exists. */
  chart?: string;
  /** The metric's own hue, so the same quantity reads alike on every screen. */
  chartColor?: RGBA;
  /** The tile's own columns, filled in by `Tiles`. A cut then ends in a mark. */
  width?: number;
  /** Opens whatever the tile stands for; the same target its key reaches. */
  onOpen?: () => void;
}) {
  // Cutting a sentence with no mark leaves `of one core · 12.3% of the`, which
  // reads as a sentence rather than as one that ran out of room.
  const sized = (text: string) => (width ? fit(text, width) : text);
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      minWidth={0}
      overflow="hidden"
      onMouseDown={onOpen}
    >
      <Line
        height={1}
        width="100%"
        truncate
        bg={selected ? ui.bg : undefined}
        attributes={selected ? ui.selected : ui.dim}
      >
        {sized(label)}
      </Line>
      <Line height={1} width="100%" truncate>
        <span fg={levelColor(level)} attributes={ui.bold}>
          {sized(safe(value))}
        </span>
      </Line>
      {chart !== undefined && (
        <Line height={1} width="100%" truncate>
          <Sparkline marks={chart} color={chartColor ?? levelColor(level)} />
        </Line>
      )}
      {detail !== undefined && (
        <Line height={1} width="100%" truncate attributes={ui.dim}>
          {sized(safe(detail))}
        </Line>
      )}
    </box>
  );
}
/** The rows a tile row occupies, so a caller can budget the space it takes. */
export function tilesHeight(
  count: number,
  width: number | undefined,
  lines: number,
): number {
  const rows = Math.ceil(count / tilesPerRow(count, width));
  return rows * lines + (rows - 1);
}

/** The columns a tile needs before its own text starts running together. */
export const tileWidth = 26;
/**
 * How many tiles one row can hold. Four tiles in a hundred columns give each
 * twenty-three and the captions merge; two rows of two give each forty-eight.
 * An unstated width keeps every tile on one row.
 */
export function tilesPerRow(count: number, width: number | undefined): number {
  if (width === undefined || count < 1) return Math.max(1, count);
  const fits = Math.max(1, Math.floor((width + 2) / (tileWidth + 2)));
  // The rows share the tiles evenly: four tiles in a width that holds three
  // read better as two rows of two than as a row of three and a lone tile.
  const rows = Math.ceil(count / Math.min(count, fits));
  return Math.ceil(count / rows);
}
/**
 * Tiles side by side, wrapping to further rows when the width cannot hold
 * them all.
 */
export function Tiles({
  children,
  width,
  id,
}: {
  children: ReactNode;
  /** The panel's inner width. Omitted keeps every tile on one row. */
  width?: number;
  /** Given when a screen has to be able to scroll the row back into view. */
  id?: string;
}) {
  const count = Children.count(children);
  const perRow = tilesPerRow(count, width);
  // Each tile's own columns: the panel less the gaps, shared evenly. A tile
  // that knows its width can mark a cut instead of ending mid-word.
  const each =
    width === undefined
      ? undefined
      : Math.max(1, Math.floor((width - 2 * (perRow - 1)) / perRow));
  const rows: ReactNode[][] = [];
  Children.forEach(children, (child, i) => {
    const at = Math.floor(i / perRow);
    if (!rows[at]) rows[at] = [];
    rows[at].push(
      each !== undefined && isValidElement<{ width?: number }>(child)
        ? cloneElement(child, { width: each })
        : child,
    );
  });
  return (
    <box id={id} flexDirection="column" flexShrink={0} gap={1}>
      {rows.map((row, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a row is its position
        <box key={`tiles-${at}`} flexDirection="row" flexShrink={0} gap={2}>
          {row}
          {/* The last row keeps the earlier rows' column widths. */}
          {Array.from({ length: perRow - row.length }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a filler is its position
            <box key={`pad-${i}`} flexGrow={1} flexBasis={0} minWidth={0} />
          ))}
        </box>
      ))}
    </box>
  );
}

/**
 * The column an expansion's rule stands in, counted from the left edge of the
 * row it opened. A row spends its first column on the selection marker, so
 * this is one past where the row's own text begins: the rule falls between
 * that text and the copy under it, which is what says the copy is inside the
 * row rather than beside it.
 */
const detailRule = 2;
/**
 * The columns from that same edge to an expansion's copy: the rule, then one
 * blank. Every expansion in the app reads this one number, and so does the
 * width its copy is measured at, so the room a screen writes into and the room
 * it draws into cannot disagree.
 */
export const detailIndent = detailRule + 2;
/**
 * The block under a row that explains it: a rule down its left edge and an
 * indent after it, so it reads as part of that row rather than as the next
 * one. An indent alone is not enough at a glance: a line indented under
 * another reads as a new top-level line as readily as a child of it. The
 * indent goes on a box, because `paddingLeft` on a text element moves nothing
 * at all, not even its first line.
 */
export function Detail({ children }: { children: ReactNode }) {
  // The rule is a box's own left border, so it runs the full height of
  // whatever is inside without anyone counting lines. That border is a column
  // of the box, which is why the padding after it is one short of the blank
  // the copy sits behind.
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      marginLeft={detailRule}
      border={["left"]}
      borderColor={ui.quiet}
      paddingLeft={detailIndent - detailRule - 1}
    >
      {children}
    </box>
  );
}

/**
 * One selectable line. The selected line is drawn in reverse video and keeps
 * its marker: in a list thirty rows deep a marker alone is easy to lose.
 *
 * OpenTUI trades a reversed cell's two colours in its buffer and also sends
 * reverse video, so the terminal trades them again. The terminal's two
 * default colours, which go out by slot rather than by value, come out
 * reversed, and a numbered colour comes out where it was named. A plain row
 * therefore reads as the scheme's background colour on a band of its text
 * colour, and a bar or a coloured word on it keeps its colour. A row in one
 * colour names that colour as its background, which comes out as a band of
 * that colour, and a word or a mark on it in that same colour is drawn
 * through `Ink` so it does not vanish into the band. The background must be
 * opaque: behind a transparent one OpenTUI fills a coloured word's cell with
 * the word's own colour, and the word vanishes.
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
      width="100%"
      flexShrink={0}
      truncate
      fg={selected && color ? ui.fg : color}
      bg={selected ? (color ?? ui.bg) : undefined}
      attributes={selected ? ui.selected : ui.none}
      onMouseDown={onOpen}
    >
      <span fg={ui.accent}>{selected ? "▍" : " "}</span>
      <Band.Provider value={selected ? color : undefined}>
        {children}
      </Band.Provider>
    </Line>
  );
}

/**
 * The selection one row below `index` in a list of `count` rows. Clamped at 0
 * so an empty list holds the selection on the first row: a bare
 * `count - 1` yields -1, and no row highlights when the rows come back.
 */
export function nextDown(count: number, index: number): number {
  return Math.max(0, Math.min(count - 1, index + 1));
}

/**
 * The rows a windowed list shows, as a half-open range. A caller that has to
 * fetch something per visible row reads this rather than repeating the
 * arithmetic, so what it fetches and what the list draws cannot disagree.
 */
export function listWindow(
  count: number,
  selected: number,
  height: number,
  rowHeight = 1,
): { start: number; end: number } {
  if (count < 1) return { start: 0, end: 0 };
  const rows = Math.max(1, Math.floor((height - 1) / rowHeight));
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(rows / 2), count - rows),
  );
  return { start, end: Math.min(count, start + rows) };
}
/**
 * A list windowed to the rows it has. Selection owns paging: the selected row
 * stays in view and the viewport never moves on its own. The wheel moves the
 * selection rather than the viewport, for the same reason.
 */
export function List<T>({
  items,
  selected,
  height,
  rowHeight = 1,
  render,
  empty,
  onSelect,
}: {
  items: T[];
  selected: number;
  height: number;
  rowHeight?: number;
  render: (item: T, index: number, selected: boolean) => ReactNode;
  empty: string;
  /** Given, the wheel moves the selection one row per notch. */
  onSelect?: (index: number) => void;
}) {
  if (!items.length) return <Empty text={empty} />;
  const { start, end } = listWindow(items.length, selected, height, rowHeight);
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      onMouseScroll={
        onSelect &&
        ((event) => {
          const up = event.scroll?.direction === "up";
          if (!up && event.scroll?.direction !== "down") return;
          onSelect(
            Math.max(0, Math.min(items.length - 1, selected + (up ? -1 : 1))),
          );
        })
      }
    >
      {items
        .slice(start, end)
        .map((item, i) => render(item, start + i, start + i === selected))}
      {items.length > end - start && (
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
/** The mark a chart column with no sample draws, on the base row. */
const gapMark = "·";
/**
 * A chart row split into runs of sampled and unsampled columns, so a gap can
 * be painted quietly in one span rather than a span per column.
 */
export function gapRuns(
  row: string,
): { at: number; sampled: boolean; text: string }[] {
  const runs: { at: number; sampled: boolean; text: string }[] = [];
  [...row].forEach((mark, at) => {
    const sampled = mark !== gapMark;
    const last = runs.at(-1);
    if (last && last.sampled === sampled) last.text += mark;
    else runs.push({ at, sampled, text: mark });
  });
  return runs;
}
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
          {/* A column with no sample is dim, so a window vsys has not filled
              yet reads as waiting rather than as a fault. */}
          {gapRuns(row).map((run) => (
            <span
              key={`${run.at}`}
              fg={run.sampled ? color : ui.fg}
              attributes={run.sampled ? ui.none : ui.dim}
            >
              {run.text}
            </span>
          ))}
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
      backgroundColor={ui.bg}
      paddingX={1}
      maxWidth="60%"
    >
      <Line wrapMode="word" fg={levelColor(level)}>
        {safe(text)}
      </Line>
    </box>
  );
}

/**
 * A centred panel over the screen. It is sized to the content it was given,
 * because a panel stretched to the terminal leaves the screen behind it
 * showing through its own blank rows, which reads as a paint fault.
 */
export function Overlay({
  title,
  columns,
  lines,
  children,
}: {
  title: string;
  /** The widest line the content holds, in columns. */
  columns: number;
  /** The rows the content takes. */
  lines: number;
  children: ReactNode;
}) {
  return (
    <box
      position="absolute"
      top="50%"
      left="50%"
      marginTop={-Math.ceil((lines + 4) / 2)}
      marginLeft={-Math.ceil((columns + 6) / 2)}
      width={columns + 6}
      height={lines + 4}
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
