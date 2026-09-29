import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, groupSnapshot, processSnapshot } from "../test/fixture";
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
