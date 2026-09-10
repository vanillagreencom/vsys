import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import type { TimelineEvent } from "../store/events";
import {
  emptySnapshot,
  everyCauseSnapshot,
  laneSnapshot,
} from "../test/fixture";
import { attention } from "./attention";
import { homeItems, homeTarget, recentChanges } from "./home";

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

test("Home lists the newest changes first, and each opens the moment it names", () => {
  const s = emptySnapshot();
  s.lanes = [laneSnapshot()];
  // The Timeline hands its list newest first, and Home takes the head of it.
  const changes: TimelineEvent[] = [5, 4, 3, 2, 1].map((n) => ({
    time: n * 1000,
    kind: "lane-start" as const,
    subject: `lane-${n}`,
    subjectId: `lane-${n}`,
    cause: "" as const,
    names: {},
    values: {},
  }));
  const rows = homeItems([], s, 5, changes);
  const listed = rows.flatMap((row) =>
    row.kind === "change" ? [row.event.time] : [],
  );
  expect(listed).toEqual([5000, 4000, 3000]);
  expect(listed.length).toBe(recentChanges);
  // Concerns come first, then the changes, then the agents.
  expect(rows.map((row) => row.kind)).toEqual([
    "change",
    "change",
    "change",
    "agent",
  ]);
  // Opening one asks for that moment, not for a screen with a loose cursor.
  const first = rows[0];
  expect(homeTarget(first)).toEqual({ kind: "time", at: 5000 });
  expect(homeTarget(rows[3])).toEqual({ kind: "lane", id: s.lanes[0].id });
  // With no changes recorded, the section lists none rather than inventing one.
  expect(homeItems([], s, 5).some((row) => row.kind === "change")).toBe(false);
});
