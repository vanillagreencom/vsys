import type { Config } from "../config/config";
import type { LaneIntent } from "../model/actions";
import { safe } from "../model/export";
import { fit } from "./columns";
import { ui } from "./theme";
import { Line, Overlay } from "./widgets";

export const views = [
  "Home",
  "Agents",
  "Resources",
  "Builds",
  "Storage",
  "Timeline",
  "Settings",
] as const;
export type View = (typeof views)[number];
/** A key as the reader sees it on the keyboard. */
export function keyLabel(key: string): string {
  return (
    {
      return: "Enter",
      escape: "Esc",
      tab: "Tab",
      up: "↑",
      down: "↓",
      left: "←",
      right: "→",
      space: "Space",
    }[key] ?? key
  );
}
/** The settings key that opens a view is the view's own name. */
export const viewKey = (view: View): string => view.toLowerCase();

/** The width under which a list drops the columns it can do without. */
export const narrowWidth = 100;
/** The width at or above which a screen can hold two columns side by side. */
export const wideWidth = 150;
/** The columns one tab takes: its key, a space, and the longest view name. */
const tabWidth = (c: Config) =>
  Math.max(...views.map((v) => c.keys[viewKey(v)].length + 1 + v.length));
/**
 * Whether the tabs fit on the header's own row. The host and the clock are
 * reserved first, so a tab row is offered only what is actually left: at a
 * hundred columns the capture read `cachyHome` and `7 Settin5:50:23 PM`
 * because the tabs took the space those two were already using.
 */
export function tabsFitOneRow(
  width: number,
  host: string,
  clock: string,
  c: Config,
): boolean {
  // Two padding columns, the program name and its live marker, the host, the
  // clock, and a blank on either side of the tab block.
  const reserved = 2 + 12 + [...host].length + [...clock].length + 4;
  return width - reserved >= tabWidth(c) * views.length + views.length - 1;
}
/**
 * The program, whether it shows live data, the host, the tabs and the clock.
 * One row when the terminal is wide enough, two when it is not.
 */
export function Header({
  host,
  pinnedAt,
  time,
  view,
  width,
  config: c,
  onNavigate,
}: {
  host: string;
  pinnedAt: number | null;
  time: number;
  view: View;
  width: number;
  config: Config;
  onNavigate: (view: View) => void;
}) {
  const clock = new Date(time).toLocaleTimeString();
  const narrow = !tabsFitOneRow(width, host, clock, c);
  const tabs = (
    <box
      flexDirection="row"
      flexGrow={narrow ? 0 : 1}
      minWidth={0}
      justifyContent={narrow ? "flex-start" : "center"}
      gap={narrow ? 1 : 2}
      paddingX={narrow ? 1 : 0}
    >
      {views.map((v) => (
        <Line
          key={v}
          height={1}
          flexShrink={0}
          onMouseDown={() => onNavigate(v)}
        >
          <span attributes={ui.dim}>{c.keys[viewKey(v)]}</span>
          <span
            fg={v === view ? ui.accent : ui.fg}
            attributes={v === view ? ui.bold : ui.none}
          >{` ${v}`}</span>
        </Line>
      ))}
    </box>
  );
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" height={1} flexShrink={0} paddingX={1}>
        <Line height={1} flexShrink={0} truncate>
          <span attributes={ui.bold}>vsys</span>
          {pinnedAt === null ? (
            <span fg={ui.ok}>{" ● live"}</span>
          ) : (
            <span fg={ui.warn}>
              {` ◆ ${new Date(pinnedAt).toLocaleTimeString()}`}
            </span>
          )}
          <span attributes={ui.dim}>{`  ${safe(host)} `}</span>
        </Line>
        {narrow ? <box flexGrow={1} /> : tabs}
        <Line height={1} flexShrink={0} attributes={ui.dim}>
          {` ${clock}`}
        </Line>
      </box>
      {narrow && tabs}
    </box>
  );
}

/** Key hints on the left, the machine's standing on the right. */
export function Footer({
  hints,
  status,
  statusColor,
  statusDim = false,
}: {
  hints: [string, string][];
  status: string;
  statusColor?: typeof ui.fg;
  statusDim?: boolean;
}) {
  return (
    <box flexDirection="row" height={1} flexShrink={0} paddingX={1}>
      <Line height={1} flexGrow={1} truncate>
        {hints.map(([key, action], i) => (
          <span key={key}>
            <span fg={ui.accent}>{`${i ? "  " : ""}${keyLabel(key)}`}</span>
            <span attributes={ui.dim}>{` ${action}`}</span>
          </span>
        ))}
      </Line>
      <Line
        height={1}
        flexShrink={0}
        truncate
        fg={statusDim ? undefined : statusColor}
        attributes={statusDim ? ui.dim : ui.none}
      >
        {safe(status)}
      </Line>
    </box>
  );
}

/** Every binding in the settings, grouped so the reader can find one. */
export function Help({ config: c }: { config: Config }) {
  const k = c.keys;
  const groups: [string, [string, string][]][] = [
    [
      "Move",
      [
        [`${k.up} ${k.down} ↑ ↓`, "select"],
        [`${k.left} ${k.right} ← →`, "move the time cursor"],
        [k.open, "open the selection"],
        [k.back, "go back"],
        [`${k.next} ${k.previous}`, "next and previous tab"],
      ],
    ],
    [
      "Agents",
      [
        [k.search, "find an agent"],
        [k.details, "list or table"],
        [k.columns, "choose table columns"],
        [`${k.sort} ${k.reverse}`, "sort column and direction"],
      ],
    ],
    [
      "History",
      [
        [k.window, "change the time window"],
        [k.pin, "show the machine at the cursor"],
      ],
    ],
    [
      "Program",
      [
        [k.copy, "copy the selected command"],
        [`${k.exportJson} ${k.exportMarkdown}`, "export JSON or Markdown"],
        [k.help, "this help"],
        [`${k.quit} ctrl+c`, "quit"],
      ],
    ],
  ];
  // The panel is as wide as its widest line and as tall as its rows, so no
  // part of the screen behind it shows through inside its border.
  const keyColumn = 16;
  const columns =
    Math.max(
      ...groups.flatMap(([name, rows]) => [
        [...name].length,
        ...rows.map(([, action]) => keyColumn + [...action].length),
      ]),
    ) + 1;
  const lines = groups.reduce((total, [, rows]) => total + rows.length + 2, 0);
  return (
    <Overlay title="Keys" columns={columns} lines={lines}>
      {groups.map(([name, rows]) => (
        <box key={name} flexDirection="column" flexShrink={0} marginBottom={1}>
          <Line attributes={ui.bold} width="100%">
            {name}
          </Line>
          {rows.map(([key, action]) => (
            <Line key={action} height={1} width="100%" truncate>
              <span fg={ui.accent}>{fit(key, keyColumn)}</span>
              <span>{action}</span>
            </Line>
          ))}
        </box>
      ))}
    </Overlay>
  );
}

/**
 * The question a system-changing action waits behind. It names the scope and
 * shows the exact line, so the reader confirms what will run rather than which
 * menu entry was selected.
 */
export function Confirm({
  command,
  config: c,
}: {
  command: LaneIntent;
  config: Config;
}) {
  return (
    <box
      position="absolute"
      top={3}
      left={4}
      right={4}
      zIndex={20}
      border
      borderStyle="rounded"
      borderColor={ui.danger}
      title=" Confirm "
      paddingX={2}
      paddingY={1}
      flexDirection="column"
      backgroundColor={ui.bg}
    >
      <Line wrapMode="word">
        <span attributes={ui.bold}>{`${command.action} `}</span>
        <span>{`${safe(command.scope)}?`}</span>
      </Line>
      <Line wrapMode="word" attributes={ui.dim}>
        {safe(command.text)}
      </Line>
      <Line height={1} truncate marginTop={1}>
        <span fg={ui.accent}>{keyLabel(c.keys.open)}</span>
        <span attributes={ui.dim}> confirms · any other key cancels</span>
      </Line>
    </box>
  );
}
