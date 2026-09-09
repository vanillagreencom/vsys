import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, laneSnapshot } from "../test/fixture";
import { attention } from "./overview";

test("overview promotes active problems and does not call past events current", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.alerts = [
    { rule: "memory-cap", subject: "old", message: "past event", time: 0 },
  ];
  expect(attention(s, c)).toEqual([]);
  s.lanes = [laneSnapshot({ dangerous: true })];
  const problems = attention(s, c);
  expect(problems).toHaveLength(1);
  expect(problems[0].laneId).toBe(s.lanes[0].id);
  expect(problems[0].danger).toBe(true);
  s.lanes = [];
  s.errors = [{ source: "/proc/1", message: "permission denied" }];
  expect(attention(s, c).map((item) => item.view)).toEqual(["Alerts"]);
});
