import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, groupSnapshot, serviceSnapshot } from "../test/fixture";
import { exportJson, safe, summarySnapshot } from "./export";

test("JSON preserves evidence and display text removes terminal controls", () => {
  const s = emptySnapshot();
  expect(JSON.parse(exportJson(s))).toEqual(s);
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
