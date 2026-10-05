import { expect, test } from "bun:test";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import { present } from "../test/present";
import { exportSnapshot } from "./export";

// A lane name reaches a cell of the Agents table, which a Markdown renderer's
// table parser reads: an unescaped `|` would split the cell, a newline would
// end the row, and the rest would render as inline Markdown or HTML.
const cells: [name: string, cell: string][] = [
  ["a|b", "a\\|b"],
  ["a&b", "a&amp;b"],
  ["<b>", "\\<b\\>"],
  ["a\\b", "a\\\\b"],
  ["*a*_b_", "\\*a\\*\\_b\\_"],
  ["`a`", "\\`a\\`"],
  ["![x](y)", "\\!\\[x\\]\\(y\\)"],
  ["#1+{2}.", "\\#1\\+\\{2\\}\\."],
  ["a\nb\u001b[2J", "a b \\[2J"],
];

test.each(cells)("the Markdown report escapes the cell %p", (name, cell) => {
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name })];
  const rows = exportSnapshot(s, "markdown").split("\n");
  const header = rows.findIndex((row) => row.startsWith("| Lane |"));
  expect(present(rows[header + 2], "the lane row")).toStartWith(`| ${cell} | `);
});

test("reports retain process threads and the exact memory cap", () => {
  const s = emptySnapshot();
  s.groups = [groupSnapshot({ max: 5242880 })];
  s.procs = [
    processSnapshot({
      pid: 4242,
      threads: 65,
      command: ["tool", "![payload](https://invalid)"],
    }),
  ];
  const report = exportSnapshot(s, "markdown");
  expect(
    report.split("\n").find((line) => line.startsWith("| agents")),
  ).toContain("| 5242880 |");
  expect(
    report.split("\n").find((line) => line.startsWith("| 4242 |")),
  ).toContain("| 65 |");
  expect(report).toContain("\\!\\[payload\\]");
  expect(report).not.toContain("![payload]");
});
test("the scratch table writes no age for a root it never read", () => {
  const s = emptySnapshot();
  s.storage.scratch = [
    {
      path: "/unread-root",
      bytes: null,
      age: null,
      modifiedAt: null,
      error: "ENOENT: no such file or directory",
      origin: "configured",
    },
  ];
  const report = exportSnapshot(s, "markdown");
  const row = report.split("\n").find((line) => line.includes("/unread-root"));
  expect(row).toContain("unavailable");
  expect(row).not.toMatch(/\|\s*0\s*\|/);
});
test("a lane with no member read exports its main process as unknown", () => {
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "led.scope", name: "led", mainPid: 4071 }),
    laneSnapshot({ id: "bare.scope", name: "bare", mainPid: 0, pids: [] }),
  ];
  const stored = JSON.parse(exportSnapshot(s, "json")) as {
    lanes: { mainPid: number | null }[];
  };
  expect(stored.lanes.map((lane) => lane.mainPid)).toEqual([4071, null]);
  const rows = exportSnapshot(s, "markdown").split("\n");
  const pid = (name: string) =>
    rows.find((row) => row.startsWith(`| ${name} |`))?.split(" | ")[5];
  expect([pid("led"), pid("bare")]).toEqual(["4071", "?"]);
});
