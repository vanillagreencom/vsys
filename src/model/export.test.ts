import { expect, test } from "bun:test";
import { emptySnapshot, groupSnapshot, processSnapshot } from "../test/fixture";
import { exportSnapshot, safe } from "./export";

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
