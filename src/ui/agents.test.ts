import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import type { Level } from "../model/verdict";
import { laneSnapshot } from "../test/fixture";
import { findLanes, laneBadge, laneLevel } from "./agents";

test("search matches every naming field, case-insensitively, in the sort order", () => {
  const c = defaults();
  const lanes = [
    laneSnapshot({ id: "a", name: "alpha", cpu: 1 }),
    laneSnapshot({ id: "b", name: "beta", account: "Work", cpu: 2 }),
    laneSnapshot({ id: "c", name: "gamma", pane: "%7", cpu: 3 }),
    laneSnapshot({ id: "d", name: "delta", title: "Kendex", cpu: 4 }),
    laneSnapshot({ id: "e", name: "eps", cwd: "/srv/acme", cpu: 5 }),
    laneSnapshot({ id: "f", name: "zeta", branch: "feat/x", cpu: 6 }),
    laneSnapshot({ id: "g", name: "eta", tool: "codex", cpu: 7 }),
  ];
  const rows: [string, string[]][] = [
    ["ALPHA", ["a"]],
    ["work", ["b"]],
    ["%7", ["c"]],
    ["kendex", ["d"]],
    ["acme", ["e"]],
    ["feat/", ["f"]],
    ["codex", ["g"]],
    ["", ["g", "f", "e", "d", "c", "b", "a"]],
    ["nothing", []],
  ];
  for (const [query, ids] of rows)
    expect(findLanes(lanes, query, c).map((l) => l.id)).toEqual(ids);
});

test("a lane's badge names the worst thing about it, and its level follows the thresholds", () => {
  const c = defaults();
  const plain = laneSnapshot();
  expect(laneBadge(plain)).toBeNull();
  expect(laneLevel(plain, c)).toBe("ok");
  const escaped = laneSnapshot({ unconfined: true, dangerous: true });
  expect(laneBadge(escaped)?.text).toBe("outside agent slice");
  expect(laneLevel(escaped, c)).toBe("danger");
  const capped = laneSnapshot({ dangerous: true });
  expect(laneBadge(capped)?.level).toBe("danger");
  const blocked = laneSnapshot({
    state: "blocked",
    blocked: 1,
    blockedOn: "memory",
  });
  expect(laneBadge(blocked)).toEqual({
    text: "blocked: 1 task waiting on memory",
    level: "warn",
  });
  const rows: [number, Level][] = [
    [c.pressureAmber, "ok"],
    [c.pressureAmber + 0.1, "warn"],
    [c.pressureRed, "warn"],
    [c.pressureRed + 0.1, "danger"],
  ];
  for (const [pressure, level] of rows)
    expect(laneLevel(laneSnapshot({ pressure }), c)).toBe(level);
});
