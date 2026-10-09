// Cloud defect review 8, findings: the memory meter warns with no desktop slice, and
// alerts close and notify again after one unread reading (scratch, memory-cap, pressure).
// Run from the repository root: bun test review/tests/model-unread.test.ts
import { expect, test } from "bun:test";
import { defaults } from "../../src/config/config";
import { AlertEngine } from "../../src/model/alerts";
import { causes, meters, unjudged } from "../../src/model/verdict";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
} from "../../src/test/fixture";

function healthy() {
  const s = emptySnapshot();
  s.system.pressure = {
    cpu: { some: 1, full: 0, total: 0 },
    memory: { some: 0, full: 0, total: 0 },
    io: { some: 1, full: 0, total: 0 },
  };
  return s;
}

test("memory meter agrees with desktop-swap cause when the desktop slice is absent", () => {
  const c = defaults();
  const s = healthy();
  s.groups = [
    groupSnapshot({ path: "agents.slice", name: "agents.slice", swap: 0 }),
  ];
  // The cause and unjudged() both say an absent slice has nothing to judge.
  expect(causes(s, c).map((x) => x.id)).not.toContain("desktop-swap");
  expect(unjudged(s, c)["desktop-swap"]).toBeUndefined();
  const memory = meters(s, c).find((m) => m.id === "memory");
  expect(memory?.level).toBe("ok");
});

test("scratch notification does not repeat after one failed scan", () => {
  const c = defaults();
  const engine = new AlertEngine();
  const root = (bytes: number | null, time: number) => {
    const s = emptySnapshot(time);
    s.storage.scratch = [
      {
        path: "/scratch",
        bytes,
        age: 0,
        error: bytes === null ? "ENOENT" : null,
        origin: "configured",
      },
    ];
    return s;
  };
  const over = c.scratchQuota + 1;
  expect(engine.evaluate(root(over, 1000), c).map((a) => a.rule)).toEqual([
    "scratch",
  ]);
  const u = unjudged(root(null, 2000), c).scratch;
  expect(u !== undefined && u !== "all" && u.has("/scratch")).toBe(true);
  expect(engine.evaluate(root(null, 2000), c)).toEqual([]);
  // still over quota: no second desktop notification
  expect(engine.evaluate(root(over, 3000), c)).toEqual([]);
});

test("memory-cap notification does not repeat after one failed memory.max read", () => {
  const c = defaults();
  const engine = new AlertEngine();
  const at = (known: boolean, time: number) => {
    const s = emptySnapshot(time);
    s.lanes = [
      laneSnapshot({
        dangerous: known,
        memoryMaxKnown: known,
        memoryMax: known ? 1 : null,
      }),
    ];
    return s;
  };
  expect(engine.evaluate(at(true, 1000), c).map((a) => a.rule)).toEqual([
    "memory-cap",
  ]);
  expect(unjudged(at(false, 2000), c)["memory-cap"]).toBeDefined();
  expect(engine.evaluate(at(false, 2000), c)).toEqual([]);
  expect(engine.evaluate(at(true, 3000), c)).toEqual([]);
});

test("pressure notification keeps its hold through one unread pressure file", () => {
  const c = { ...defaults(), pressureHoldSeconds: 5 };
  const engine = new AlertEngine();
  const group = groupSnapshot({ pressure: { cpu: { some: 15, full: 0, total: 1 } } });
  const at = (time: number, read: boolean) => {
    const s = emptySnapshot(time);
    s.groups = [{ ...group, pressure: read ? group.pressure : {} }];
    return s;
  };
  expect(engine.evaluate(at(0, true), c)).toEqual([]);
  expect(engine.evaluate(at(5000, true), c).map((a) => a.rule)).toEqual(["pressure"]);
  expect(engine.evaluate(at(6000, false), c)).toEqual([]);
  // still above amber the whole time: no second notification
  expect(engine.evaluate(at(11000, true), c)).toEqual([]);
  expect(engine.evaluate(at(16000, true), c)).toEqual([]);
});
