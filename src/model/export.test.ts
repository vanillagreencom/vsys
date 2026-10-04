import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import { exportSnapshot, safe, summarySnapshot } from "./export";

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
test("JSON preserves evidence and display text removes terminal controls", () => {
  const s = emptySnapshot();
  expect(JSON.parse(exportSnapshot(s, "json"))).toEqual(s);
  expect(safe("a\u001b[2J\nb")).toBe("a [2J b");
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
