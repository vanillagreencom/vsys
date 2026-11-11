import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { causeOrder } from "../model/verdict";
import {
  emptySnapshot,
  everyCauseSnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
  serviceSnapshot,
} from "../test/fixture";
import { present } from "../test/present";
import { attention } from "./attention";
import { exportSnapshot, summarySnapshot } from "./export";

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
test("summary subjects never use navigation-only targets", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.system.pressure.memory = { some: c.pressureRed + 1, full: 0, total: 0 };
  s.groups = [
    groupSnapshot({
      path: "app.slice",
      name: c.desktopSlice,
      swap: c.swapFloor + 1,
    }),
    groupSnapshot({
      path: "app.slice/shell.scope",
      name: "shell.scope",
      swap: c.swapFloor + 1,
    }),
  ];
  const summary = summarySnapshot(s, c);
  expect(
    summary.verdict.find((cause) => cause.cause === "system-memory"),
  ).toMatchObject({
    level: "warn",
    subject: null,
  });
  expect(
    summary.verdict.find((cause) => cause.cause === "desktop-swap"),
  ).toMatchObject({
    level: "danger",
    subject: "app.slice/shell.scope",
  });
});

test("summary meters keep unknown readings null and graded warn", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.system.pressure = {};
  s.system.memory = {};
  // A running desktop slice whose swap could not be read.
  s.groups = [
    groupSnapshot({ path: c.desktopSlice, name: c.desktopSlice, swap: null }),
  ];
  const summary = summarySnapshot(s, c);
  expect(summary.meters).toContainEqual({
    id: "cpu",
    value: null,
    max: 100,
    level: "warn",
  });
  expect(summary.meters).toContainEqual({
    id: "memory",
    value: null,
    max: null,
    level: "warn",
  });
  expect(summary.meters).toContainEqual({
    id: "disk",
    value: null,
    max: 100,
    level: "warn",
  });
});

test("summary keeps service-cpu unmeasured until a unit has an hour average", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.services = [serviceSnapshot({ cpuHourPercent: null })];
  expect(summarySnapshot(s, c).verdict).toContainEqual({
    cause: "service-cpu",
    level: null,
    subject: null,
  });
  // A failed unit listing is unmeasured too.
  s.services = null;
  expect(summarySnapshot(s, c).verdict).toContainEqual({
    cause: "service-cpu",
    level: null,
    subject: null,
  });
  s.services = [serviceSnapshot({ cpuHourPercent: 0 })];
  expect(
    summarySnapshot(s, c).verdict.some((v) => v.cause === "service-cpu"),
  ).toBe(false);
});

test("each raised cause carries its card's title and the processes it names", () => {
  const c = defaults();
  // The every-cause snapshot fires every host pressure, so a host card owns
  // each stalling lane there; a quiet host with one stalling lane raises the
  // one cause it cannot.
  const quiet = emptySnapshot();
  quiet.system.pressure = {
    cpu: { some: 1, full: 0, total: 0 },
    memory: { some: 0, full: 0, total: 0 },
    io: { some: 1, full: 0, total: 0 },
  };
  quiet.lanes = [laneSnapshot({ pressure: c.pressureRed + 1 })];
  const seen = new Set<string>();
  for (const s of [everyCauseSnapshot(c), quiet]) {
    const cards = attention(s, c);
    for (const entry of summarySnapshot(s, c).verdict) {
      if (entry.level === null) continue;
      seen.add(entry.cause);
      const card = present(
        cards.find((item) => item.id === entry.cause),
        `the ${entry.cause} card`,
      );
      expect({ cause: entry.cause, title: entry.title }).toEqual({
        cause: entry.cause,
        title: card.title,
      });
      expect({ cause: entry.cause, open: entry.open }).toEqual({
        cause: entry.cause,
        open: [],
      });
      // Only an unconfirmed tool is about processes that joined no lane.
      expect({ cause: entry.cause, processes: entry.processes }).toEqual({
        cause: entry.cause,
        processes:
          entry.cause === "unconfirmed-tool" ? [{ pid: 2, name: "pi" }] : [],
      });
    }
  }
  expect([...seen].sort()).toEqual(Object.keys(causeOrder).sort());
});
