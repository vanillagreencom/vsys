import type { Config } from "../config/config";
import { safe } from "../model/export";
import { lanePressure } from "../model/lanes";
import type { Lane } from "../model/types";
import { bytes, laneValue, percent } from "./format";
import { themePalette } from "./theme";

const labels: Record<string, string> = {
  name: "Lane",
  account: "Account",
  cwd: "Worktree",
  branch: "Branch",
  tool: "Agent",
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
};
const columnWidth = (column: string) =>
  column === "cwd" ? 28 : column === "name" ? 22 : 14;

/** Fixed-height rows prevent wrapping and give selection sole ownership of vertical paging. */
export function Fleet({
  lanes,
  config: c,
  selected,
  height,
  width,
  detailed,
  onOpen,
  onSort,
}: {
  lanes: Lane[];
  config: Config;
  selected: number;
  height: number;
  width: number;
  detailed: boolean;
  onOpen: (index: number) => void;
  onSort: (column: string) => void;
}) {
  const palette = themePalette(c.theme);
  const count = Math.max(1, Math.floor((height - 4) / (detailed ? 1 : 3)));
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(count / 2), lanes.length - count),
  );
  const tableWidth = c.columns.reduce(
    (sum, column) => sum + columnWidth(column),
    0,
  );
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      minWidth={detailed ? tableWidth : 0}
    >
      <text
        height={1}
        flexShrink={0}
        truncate
        fg={palette.fg}
      >{`${lanes.length} lanes | sort: ${labels[c.sort] ?? c.sort} ${c.descending ? "descending" : "ascending"} | ${c.keys.details} ${detailed ? "summary" : "all columns"}`}</text>
      <text
        height={1}
        flexShrink={0}
        truncate
        fg={palette.fg}
      >{`Enter opens a lane. CPU wait means time stalled for CPU. ${c.keys.columns} choose columns.`}</text>
      {detailed && (
        <box height={1} flexShrink={0} flexDirection="row">
          {c.columns.map((column) => (
            <text
              key={column}
              width={columnWidth(column)}
              height={1}
              flexShrink={0}
              truncate
              fg={palette.fg}
              onMouseDown={() => onSort(column)}
            >
              {labels[column] ?? column}
            </text>
          ))}
        </box>
      )}
      {lanes.slice(start, start + count).map((lane, i) => {
        const index = start + i;
        const fg =
          lane.unconfined ||
          lane.dangerous ||
          (lanePressure(lane) ?? 0) > c.pressureRed
            ? palette.danger
            : (lanePressure(lane) ?? 0) > c.pressureAmber
              ? palette.warning
              : palette.fg;
        const attributes = selected === index ? palette.selection : undefined;
        const bg = selected === index ? palette.selected : undefined;
        return detailed ? (
          <box
            key={lane.id}
            flexDirection="row"
            height={1}
            flexShrink={0}
            onMouseDown={() => onOpen(index)}
          >
            {c.columns.map((column) => (
              <text
                key={column}
                height={1}
                width={columnWidth(column)}
                flexShrink={0}
                truncate
                fg={fg}
                bg={bg}
                attributes={attributes}
              >
                {safe(laneValue(lane, column, c))}
              </text>
            ))}
          </box>
        ) : (
          <box
            key={lane.id}
            height={3}
            flexShrink={0}
            flexDirection="column"
            onMouseDown={() => onOpen(index)}
          >
            <text
              height={1}
              flexShrink={0}
              truncate
              fg={fg}
              bg={bg}
              attributes={attributes}
            >
              {safe(
                `${selected === index ? ">" : " "} ${lane.name}  ${lane.tool || "processes"} | ${lane.dangerous ? "Low memory limit" : lane.unconfined ? "Outside agent slice" : lane.state}`,
              )}
            </text>
            <text
              height={1}
              flexShrink={0}
              truncate
              fg={fg}
            >{`  CPU ${percent(lane.cpu)} | Memory ${bytes(lane.rss, c)}${width >= 90 ? ` | Tasks ${lane.tasks}` : ""} | Wait ${percent(lane.pressure)}`}</text>
          </box>
        );
      })}
      <text height={1} flexShrink={0} truncate fg={palette.fg}>
        {lanes.length
          ? `Rows ${start + 1}-${Math.min(lanes.length, start + count)} of ${lanes.length} | up/down to select`
          : "No scopes or escaped agents in this sample"}
      </text>
    </box>
  );
}
