import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { EventLog } from "../store/events";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import { AlertEngine } from "./alerts";
import type { Rule } from "./types";
import { unjudged } from "./verdict";

test("memory-high alerts survive failed reads and rearm only after measured recovery", () => {
  for (const quiet of [
    { high: null, memory: null },
    { high: 100, memory: 50 },
  ]) {
    const c = { ...defaults(), pressureHoldSeconds: 2, refreshMs: 1000 };
    const engine = new AlertEngine();
    const log = new EventLog();
    const group = groupSnapshot({ memory: 95, high: 100 });
    const at = (time: number, reading: Partial<typeof group>) => {
      Object.assign(group, reading);
      const s = emptySnapshot(time);
      s.groups = [group];
      const unread = unjudged(s, c)["memory-high"];
      return {
        unread: unread === "all" || (unread?.has(group.path) ?? false),
        events: log
          .advance(s, c)
          .filter(
            (event) =>
              event.cause === "memory-high" && event.kind.startsWith("alert-"),
          )
          .map((event) => event.kind),
        notifications: engine
          .evaluate(s, c)
          .filter((alert) => alert.rule === "memory-high")
          .map((alert) => alert.subject),
      };
    };
    expect(at(0, {}).notifications).toEqual([group.path]);
    expect(at(1000, {}).events).toEqual([]);
    expect(at(2000, {}).events).toEqual(["alert-open"]);
    // Reader.limit supplies highRead=false when memory.high cannot be read.
    for (const time of [3000, 4000, 5000])
      expect(at(time, { high: null, highRead: false })).toEqual({
        unread: true,
        events: [],
        notifications: [],
      });
    expect(at(6000, { high: 100, highRead: true })).toEqual({
      unread: false,
      events: [],
      notifications: [],
    });
    expect(at(7000, quiet)).toEqual({
      unread: false,
      events: [],
      notifications: [],
    });
    expect(at(8000, quiet)).toEqual({
      unread: false,
      events: ["alert-close"],
      notifications: [],
    });
    expect(at(9000, quiet)).toEqual({
      unread: false,
      events: [],
      notifications: [],
    });
    expect(at(10000, { high: 100, memory: 95 }).notifications).toEqual([
      group.path,
    ]);
    expect(at(11000, {}).events).toEqual([]);
    expect(at(12000, {}).events).toEqual(["alert-open"]);
  }
});

test("each alert condition emits its own rule and clears before rearming", () => {
  const cases: [Rule, (s: ReturnType<typeof emptySnapshot>) => void][] = [
    [
      "unconfined",
      (s) => {
        s.lanes = [laneSnapshot({ unconfined: true })];
        s.procs = [processSnapshot({ group: "/app.slice/session.scope" })];
      },
    ],
    [
      "memory-cap",
      (s) => {
        s.lanes = [laneSnapshot({ dangerous: true })];
      },
    ],
    [
      "memory-high",
      (s) => {
        s.groups = [groupSnapshot({ memory: 95, high: 100 })];
      },
    ],
    [
      "btrfs-ro",
      (s) => {
        s.storage.volumes = [
          {
            mount: "/data",
            device: "/dev/a",
            fsid: "f",
            readOnly: true,
            options: [],
            free: 1,
            total: 2,
            errors: {},
            delta: {},
            sinceStart: {},
          },
        ];
      },
    ],
    [
      "btrfs-errors",
      (s) => {
        s.storage.volumes = [
          {
            mount: "/data",
            device: "/dev/a",
            fsid: "f",
            readOnly: false,
            options: [],
            free: 1,
            total: 2,
            errors: {},
            delta: { corruption: 1 },
            sinceStart: {},
          },
        ];
      },
    ],
    [
      "scrub",
      (s) => {
        s.storage.scrubs = [{ path: "/scrub", text: "aborted", problem: true }];
      },
    ],
    [
      "scratch",
      (s) => {
        s.storage.scratch = [
          {
            path: "/scratch",
            bytes: defaults().scratchQuota + 1,
            age: 0,
            error: null,
            origin: "configured",
          },
        ];
      },
    ],
  ];
  for (const [rule, plant] of cases) {
    const engine = new AlertEngine();
    const s = emptySnapshot();
    expect(engine.evaluate(s, defaults())).toEqual([]);
    plant(s);
    expect(engine.evaluate(s, defaults()).map((a) => a.rule)).toEqual([rule]);
    expect(engine.evaluate(s, defaults()).map((a) => a.rule)).toEqual(
      rule === "btrfs-errors" ? [rule] : [],
    );
    expect(engine.evaluate(emptySnapshot(), defaults())).toEqual([]);
    expect(engine.evaluate(s, defaults()).map((a) => a.rule)).toEqual([rule]);
  }
  // Two capped lanes with one name read as two in the alert text.
  const twins = emptySnapshot();
  twins.lanes = [4071, 9152].map((mainPid) =>
    laneSnapshot({ id: `${mainPid}`, name: "ken", mainPid, dangerous: true }),
  );
  const said = new AlertEngine().evaluate(twins, defaults());
  expect(said.map((a) => a.message.split(" has ")[0])).toEqual([
    "ken PID 4071",
    "ken PID 9152",
  ]);
});
test("pressure holds for elapsed seconds and resets when samples recover", () => {
  const engine = new AlertEngine();
  const c = defaults();
  c.pressureHoldSeconds = 5;
  const s = emptySnapshot(1000);
  const group = groupSnapshot({
    pressure: { cpu: { some: 15, full: 0, total: 1 } },
  });
  s.groups = [group];
  expect(engine.evaluate(s, c)).toEqual([]);
  s.time = 5999;
  expect(engine.evaluate(s, c)).toEqual([]);
  s.time = 6000;
  expect(engine.evaluate(s, c).map((a) => a.rule)).toEqual(["pressure"]);
  group.pressure.cpu = { some: 0, full: 0, total: 1 };
  s.time = 7000;
  expect(engine.evaluate(s, c)).toEqual([]);
  group.pressure.cpu = { some: 15, full: 0, total: 1 };
  s.time = 8000;
  expect(engine.evaluate(s, c)).toEqual([]);
});
test("each new escaped agent is reported even in an already alarmed scope", () => {
  const c = defaults();
  const engine = new AlertEngine();
  const s = emptySnapshot();
  s.procs = [processSnapshot({ group: "/app.slice/session.scope" })];
  s.lanes = [laneSnapshot({ unconfined: true })];
  expect(
    engine.evaluate(s, c).filter((a) => a.rule === "unconfined"),
  ).toHaveLength(1);
  s.time += 1000;
  s.procs.push(processSnapshot({ pid: 41, group: "/app.slice/session.scope" }));
  expect(
    engine
      .evaluate(s, c)
      .filter((a) => a.rule === "unconfined")
      .map((a) => a.subject),
  ).toEqual(["41:100:claude"]);
  expect(engine.evaluate(s, c).filter((a) => a.rule === "unconfined")).toEqual(
    [],
  );
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
  const at = (time: number, read: boolean) => {
    const s = emptySnapshot(time);
    s.groups = [
      groupSnapshot({
        pressure: { cpu: read ? { some: 15, full: 0, total: 1 } : null },
      }),
    ];
    return s;
  };
  expect(engine.evaluate(at(0, true), c)).toEqual([]);
  expect(engine.evaluate(at(3000, false), c)).toEqual([]);
  // The hold kept its start through the unread sample.
  expect(engine.evaluate(at(5000, true), c).map((a) => a.rule)).toEqual([
    "pressure",
  ]);
  expect(engine.evaluate(at(6000, false), c)).toEqual([]);
  expect(engine.evaluate(at(11000, true), c)).toEqual([]);
  expect(engine.evaluate(at(16000, true), c)).toEqual([]);
});
