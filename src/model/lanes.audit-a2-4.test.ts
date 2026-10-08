import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { groupSnapshot, processSnapshot } from "../test/fixture";
import { present } from "../test/present";
import { lanes } from "./lanes";

test("A2-4 lane age stays unknown when an older reported member is unreadable", () => {
  const c = defaults();
  const group = groupSnapshot({ pids: [40, 41] });
  const older = processSnapshot({ pid: 40, age: 1000 });
  const younger = processSnapshot({ pid: 41, age: 10 });
  expect(
    present(lanes([group], [older, younger], c)[0], "complete lane").age,
  ).toBe(1000);
  const lane = present(
    lanes([group], [younger], c, 0, undefined, [], "incomplete")[0],
    "incomplete lane",
  );
  expect(lane.rss).toBeNull();
  expect(lane.age).toBeNull();
});
