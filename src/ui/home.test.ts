import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import {
  emptySnapshot,
  everyCauseSnapshot,
  laneSnapshot,
} from "../test/fixture";
import { attention } from "./attention";
import { homeItems } from "./home";

test("Home lists every concern first, then the busiest agents, capped", () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  s.lanes = [
    ...s.lanes,
    ...Array.from({ length: 6 }, (_, i) =>
      laneSnapshot({ id: `x${i}`, name: `x${i}`, cpu: 100 + i }),
    ),
  ];
  const items = attention(s, c, ["/usr/bin"]);
  const rows = homeItems(items, s);
  expect(rows.slice(0, items.length).every((r) => r.kind === "concern")).toBe(
    true,
  );
  const agents = rows.slice(items.length);
  expect(agents.length).toBe(5);
  expect(agents.map((r) => (r.kind === "agent" ? r.lane.name : ""))).toEqual([
    "x5",
    "x4",
    "x3",
    "x2",
    "x1",
  ]);
  expect(homeItems([], emptySnapshot())).toEqual([]);
});
