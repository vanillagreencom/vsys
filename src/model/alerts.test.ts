import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { EventLog } from "../store/events";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import { AlertEngine, notifiable } from "./alerts";
import type { Rule } from "./types";
import { causes, unjudged } from "./verdict";

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

test("a lane the warden warns for alerts once, crediting the warden, below vsys's own line", () => {
  const engine = new AlertEngine();
  const kernelPath = "/user.slice/agents.slice/a.scope";
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ mainPid: 4071 })];
  // Working memory half of memory.high: vsys alone would raise nothing.
  const warned = groupSnapshot({ kernelPath, memory: 50, high: 100 });
  // A group the warden does not warn for, past vsys's own line.
  const judged = groupSnapshot({
    path: "agents.slice/b.scope",
    kernelPath: "/user.slice/agents.slice/b.scope",
    name: "b.scope",
    memory: 95,
    high: 100,
  });
  s.groups = [warned, judged];
  s.wardenNearLimits = [{ kernelPath, near: ["tasks", "memory"] }];
  const c = { ...defaults(), notifications: ["memory-high"] };
  const own = (subject: string, name: string) => ({
    time: s.time,
    rule: "memory-high" as const,
    subject,
    message: `${name} is near memory.high`,
  });
  const alerts = engine.evaluate(s, c);
  expect(alerts).toEqual([
    {
      time: s.time,
      rule: "memory-high",
      subject: "agents.slice/a.scope",
      message:
        "The agent warden warns lane-a PID 4071 is near its memory limit",
      source: "warden",
    },
    own("agents.slice/b.scope", "b.scope"),
  ]);
  // The warden's own handoff sends its desktop notice; vsys sends only its own.
  expect(notifiable(alerts, c)).toEqual([
    own("agents.slice/b.scope", "b.scope"),
  ]);
  expect(engine.evaluate(s, c)).toEqual([]);
  // The warden's status goes stale with the lane past vsys's line: vsys's
  // own alert opens new and is sent.
  warned.memory = 95;
  delete s.wardenNearLimits;
  const handed = engine.evaluate(s, c);
  expect(notifiable(handed, c)).toEqual([
    own("agents.slice/a.scope", "a.scope"),
  ]);
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

test("scratch quota alerts retain incomplete lower bounds until measured recovery", () => {
  const c = {
    ...defaults(),
    scratchQuota: 100,
    pressureHoldSeconds: 2,
    refreshMs: 1000,
  };
  const path = "/scratch";
  const partial =
    "Partial scratch reading; unreadable entries:\n/scratch/agent-confine-123-456/locked: EACCES";
  const root = (
    time: number,
    bytes: number | null,
    error: string | null = null,
  ) => {
    const s = emptySnapshot(time);
    s.storage.scratch = [
      {
        path,
        bytes,
        age: 0,
        error,
        origin: "configured",
      },
    ];
    return s;
  };
  const rows: [
    string,
    number | null,
    string | null,
    "fired" | "absent" | "unjudged",
  ][] = [
    ["complete below", 0, null, "absent"],
    ["complete equal", 100, null, "absent"],
    ["complete above", 101, null, "fired"],
    ["unreadable root", null, "EACCES", "unjudged"],
    ["partial below", 0, partial, "unjudged"],
    ["partial equal", 100, partial, "unjudged"],
    ["partial above", 101, partial, "fired"],
  ];
  for (const [name, bytes, error, judged] of rows) {
    const s = root(0, bytes, error);
    expect({
      name,
      unread: unjudged(s, c).scratch,
      fired: causes(s, c)
        .filter((cause) => cause.id === "scratch")
        .flatMap((cause) => cause.paths),
      notifications: new AlertEngine().evaluate(s, c).map((a) => a.subject),
    }).toEqual({
      name,
      unread: judged === "unjudged" ? new Set([path]) : undefined,
      fired: judged === "fired" ? [path] : [],
      notifications: judged === "fired" ? [path] : [],
    });

    const engine = new AlertEngine();
    const log = new EventLog();
    const at = (
      time: number,
      bytes: number | null,
      error: string | null = null,
    ) => {
      const sample = root(time, bytes, error);
      return {
        name,
        events: log
          .advance(sample, c)
          .filter((event) => event.cause === "scratch")
          .map((event) => event.kind),
        notifications: engine.evaluate(sample, c).map((alert) => alert.subject),
      };
    };
    const quiet = { name, events: [], notifications: [] };
    expect(at(0, 101)).toEqual({ ...quiet, notifications: [path] });
    expect(at(1000, 101)).toEqual(quiet);
    expect(at(2000, 101)).toEqual({ ...quiet, events: ["alert-open"] });
    expect(at(3000, bytes, error)).toEqual(quiet);
    expect(at(4000, bytes, error)).toEqual({
      ...quiet,
      events: judged === "absent" ? ["alert-close"] : [],
    });
    expect(at(5000, 101)).toEqual({
      ...quiet,
      notifications: judged === "absent" ? [path] : [],
    });
    expect(at(6000, 101)).toEqual(quiet);
    expect(at(7000, 101)).toEqual({
      ...quiet,
      events: judged === "absent" ? ["alert-open"] : [],
    });
    expect(at(8000, 100)).toEqual(quiet);
    expect(at(9000, 100)).toEqual({ ...quiet, events: ["alert-close"] });
    expect(at(10000, 101)).toEqual({ ...quiet, notifications: [path] });
    expect(at(11000, 101)).toEqual(quiet);
    expect(at(12000, 101)).toEqual({ ...quiet, events: ["alert-open"] });
  }
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
