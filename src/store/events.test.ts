import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import type { Snapshot } from "../model/types";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
  volumeSnapshot,
} from "../test/fixture";
import { EventLog } from "./events";
import { History } from "./history";

/** A zero hold isolates the derivation from the flap suppression below. */
const c = { ...defaults(), pressureHoldSeconds: 0 };
/** Every test starts from a sample the log has already seen. */
function started(first: Snapshot = emptySnapshot(1000)): EventLog {
  const log = new EventLog();
  log.advance(first, c);
  return log;
}
test("the first sample reports the state it observes as no change", () => {
  const s = emptySnapshot(1000);
  s.lanes = [laneSnapshot({ unconfined: true })];
  expect(new EventLog().advance(s, c)).toEqual([]);
});
test("a lane start and stop name the account and the slice", () => {
  const log = started();
  const running = emptySnapshot(2000);
  running.lanes = [
    laneSnapshot({
      id: "agents.slice/a.scope",
      name: "lane-a",
      account: "work",
      age: 30,
    }),
  ];
  running.lanes.push(
    laneSnapshot({
      id: "escaped-42",
      name: "lane-b",
      account: null,
      cgroup: "other.slice/b.scope",
    }),
  );
  const start = log.advance(running, c).filter((e) => e.kind === "lane-start");
  expect(start).toHaveLength(2);
  expect(start[0].subject).toBe("lane-a");
  expect(start[0].names).toMatchObject({
    account: "work",
    slice: "agents.slice",
  });
  // The slice comes from the charged cgroup, and an unread account stays empty.
  expect(start[1].names).toMatchObject({ account: "", slice: "other.slice" });
  const stop = log
    .advance(emptySnapshot(3000), c)
    .filter((e) => e.kind === "lane-stop");
  expect(stop).toHaveLength(2);
  expect(stop[0].subject).toBe("lane-a");
  expect(stop[0].names.slice).toBe("agents.slice");
  expect(stop[0].values.age).toBe(30);
});
test("a process changing cgroup is one move, and a reused PID is not", () => {
  const first = emptySnapshot(1000);
  first.procs = [
    processSnapshot({ pid: 40, start: 100, group: "app.slice/x.scope" }),
    processSnapshot({ pid: 41, start: 100, group: "app.slice/x.scope" }),
  ];
  const log = started(first);
  const moved = emptySnapshot(2000);
  moved.procs = [
    processSnapshot({ pid: 40, start: 100, group: "agents.slice/x.scope" }),
    processSnapshot({ pid: 41, start: 100, group: "app.slice/x.scope" }),
  ];
  const move = log.advance(moved, c).filter((e) => e.kind === "cgroup-move");
  expect(move).toHaveLength(1);
  expect(move[0].subject).toBe("claude PID 40");
  expect(move[0].names).toMatchObject({
    from: "app.slice/x.scope",
    to: "agents.slice/x.scope",
    fromSlice: "app.slice",
    toSlice: "agents.slice",
  });
  const reused = emptySnapshot(3000);
  reused.procs = [
    processSnapshot({ pid: 40, start: 900, group: "app.slice/y.scope" }),
  ];
  expect(
    log.advance(reused, c).filter((e) => e.kind === "cgroup-move"),
  ).toEqual([]);
});
test("an agent leaving the agent slice carries the cause of the move", () => {
  const first = emptySnapshot(1000);
  first.procs = [processSnapshot({ group: "agents.slice/a.scope" })];
  const log = started(first);
  const escaped = emptySnapshot(2000);
  escaped.procs = [processSnapshot({ group: "app.slice/a.scope" })];
  const move = log.advance(escaped, c).find((e) => e.kind === "cgroup-move");
  expect(move?.cause).toBe("unconfined");
});
test("an alert closes with the time it stayed open", () => {
  const log = started();
  const firing = emptySnapshot(2000);
  firing.lanes = [laneSnapshot({ name: "escaped", unconfined: true })];
  const opened = log.advance(firing, c).find((e) => e.kind === "alert-open");
  expect(opened?.cause).toBe("unconfined");
  expect(opened?.subject).toBe("escaped");
  expect(opened?.names.level).toBe("danger");
  const repeat = emptySnapshot(3000);
  repeat.lanes = firing.lanes;
  expect(log.advance(repeat, c)).toEqual([]);
  const closed = log
    .advance(emptySnapshot(6000), c)
    .find((e) => e.kind === "alert-close");
  expect(closed?.cause).toBe("unconfined");
  expect(closed?.values.durationMs).toBe(1000);
});
test("desktop swap crossing the floor opens and closes one event", () => {
  const log = started();
  const swapped = emptySnapshot(2000);
  swapped.groups = [
    groupSnapshot({
      path: "app.slice",
      name: c.desktopSlice,
      swap: c.swapFloor + 4096,
    }),
  ];
  const open = log.advance(swapped, c).find((e) => e.cause === "desktop-swap");
  expect(open?.kind).toBe("alert-open");
  expect(open?.values.swap).toBe(c.swapFloor + 4096);
  const back = emptySnapshot(3000);
  back.groups = [
    groupSnapshot({ path: "app.slice", name: c.desktopSlice, swap: 0 }),
  ];
  const close = log
    .advance(back, c)
    .filter((e) => e.cause === "desktop-swap" && e.kind === "alert-close");
  expect(close).toHaveLength(1);
});
test("a verdict change names the cause it replaces", () => {
  const log = started();
  const firing = emptySnapshot(2000);
  firing.lanes = [laneSnapshot({ name: "escaped", unconfined: true })];
  const first = log.advance(firing, c).find((e) => e.kind === "verdict");
  expect(first?.cause).toBe("unconfined");
  expect(first?.names.previous).toBe("");
  const cleared = log
    .advance(emptySnapshot(3000), c)
    .find((e) => e.kind === "verdict");
  expect(cleared?.cause).toBe("");
  expect(cleared?.names.previous).toBe("unconfined");
});
test("a housekeeping cause is an event but never a verdict change", () => {
  const log = started();
  const large = emptySnapshot(2000);
  large.storage.scratch = [
    { path: "/scratch", bytes: c.scratchQuota + 1, age: 0, error: null },
  ];
  const out = log.advance(large, c);
  expect(out.find((e) => e.cause === "scratch")?.kind).toBe("alert-open");
  expect(out.filter((e) => e.kind === "verdict")).toEqual([]);
});
test("history records the derived events and keeps an alert open across settings", () => {
  const history = new History(c);
  history.add(emptySnapshot(1000));
  const lanes = [laneSnapshot({ name: "escaped", unconfined: true })];
  for (const time of [2000, 3000]) {
    const firing = emptySnapshot(time);
    firing.lanes = lanes;
    history.add(firing);
  }
  expect(history.events(3000, 10000).map((e) => e.kind)).toContain(
    "alert-open",
  );
  const changed = history.reconfigure({ ...c, refreshMs: 2000 });
  changed.add(emptySnapshot(6000));
  const closed = changed
    .events(6000, 10000)
    .find((e) => e.kind === "alert-close");
  expect(closed?.values.durationMs).toBe(1000);
  changed.close();
  history.close();
});
test("a second subject on one cause opens and closes on its own", () => {
  const log = started();
  const first = emptySnapshot(2000);
  first.lanes = [
    laneSnapshot({ id: "a.scope", name: "agent-a", unconfined: true }),
  ];
  log.advance(first, c);
  const second = emptySnapshot(3000);
  second.lanes = [
    laneSnapshot({ id: "b.scope", name: "agent-b", unconfined: true }),
  ];
  const out = log.advance(second, c);
  const opened = out.find((e) => e.kind === "alert-open");
  const closed = out.find((e) => e.kind === "alert-close");
  expect(opened?.subject).toBe("agent-b");
  expect(closed?.subject).toBe("agent-a");
  expect(closed?.cause).toBe("unconfined");
});
/** Counts the alert transitions over a run of samples driven by `pressure`. */
function run(
  held: typeof c,
  samples: number,
  pressure: (i: number) => number,
): { opens: number; closes: number } {
  const log = new EventLog();
  let opens = 0;
  let closes = 0;
  for (let i = 0; i < samples; i++) {
    const s = emptySnapshot(1000 + i * held.refreshMs);
    s.lanes = [laneSnapshot({ pressure: pressure(i) })];
    for (const e of log.advance(s, held)) {
      if (e.kind === "alert-open") opens++;
      if (e.kind === "alert-close") closes++;
    }
  }
  return { opens, closes };
}
test("a cause must hold without a gap to open", () => {
  const held = defaults();
  const over = held.pressureAmber + 1;
  // Alternating either side of the threshold never holds, so nothing opens.
  expect(run(held, 100, (i) => (i % 2 ? over : 0))).toEqual({
    opens: 0,
    closes: 0,
  });
  // The same value held through the wait opens once and stays open.
  expect(run(held, 100, () => over)).toEqual({ opens: 1, closes: 0 });
});
test("two lanes escaping at once are two alerts, not one", () => {
  const log = started();
  const both = emptySnapshot(2000);
  both.lanes = [
    laneSnapshot({ id: "a.scope", name: "agent-a", unconfined: true }),
    laneSnapshot({ id: "b.scope", name: "agent-b", unconfined: true }),
  ];
  const opened = log
    .advance(both, c)
    .filter((e) => e.kind === "alert-open" && e.cause === "unconfined");
  expect(opened.map((e) => e.subject).sort()).toEqual(["agent-a", "agent-b"]);
  const gone = emptySnapshot(3000);
  gone.lanes = [both.lanes[0]];
  const closed = log.advance(gone, c).filter((e) => e.kind === "alert-close");
  expect(closed.map((e) => e.subject)).toEqual(["agent-b"]);
});
test("the verdict holds while its alert waits out the close", () => {
  const held = defaults();
  const log = new EventLog();
  const firing = (time: number) => {
    const s = emptySnapshot(time);
    s.lanes = [laneSnapshot({ name: "escaped", unconfined: true })];
    return s;
  };
  const hold = held.pressureHoldSeconds * 1000;
  log.advance(firing(1000), held);
  expect(log.advance(firing(1000 + hold), held).map((e) => e.kind)).toContain(
    "verdict",
  );
  // Absent for one sample: the alert is waiting, so the verdict must not move.
  const waiting = log.advance(emptySnapshot(1000 + hold + 1000), held);
  expect(waiting.map((e) => e.kind)).toEqual(["lane-stop"]);
  const out = log.advance(emptySnapshot(1000 + hold * 2 + 1000), held);
  expect(out.map((e) => e.kind).sort()).toEqual(["alert-close", "verdict"]);
  expect(out.find((e) => e.kind === "verdict")?.names.previous).toBe(
    "unconfined",
  );
});
test("a move between two slices outside the agent slice is not a confinement change", () => {
  const first = emptySnapshot(1000);
  first.procs = [processSnapshot({ group: "app.slice/a.scope" })];
  const log = started(first);
  const moved = emptySnapshot(2000);
  moved.procs = [processSnapshot({ group: "other.slice/a.scope" })];
  const move = log.advance(moved, c).find((e) => e.kind === "cgroup-move");
  expect(move?.names).toMatchObject({
    from: "app.slice/a.scope",
    to: "other.slice/a.scope",
    fromSlice: "app.slice",
    toSlice: "other.slice",
  });
  expect(move?.cause).toBe("");
});
test("an alert waiting to close still outranks a cause of equal severity", () => {
  const held = defaults();
  const hold = held.pressureHoldSeconds * 1000;
  const log = new EventLog();
  // The full filesystem is seen first; the escaped lane arrives later and
  // outranks it, so the order cannot come from either one's first sighting.
  const sample = (time: number, escapedLane: boolean): Snapshot => {
    const s = emptySnapshot(time);
    s.storage.volumes = [volumeSnapshot("/full", { free: 5, total: 100 })];
    if (escapedLane)
      s.lanes = [laneSnapshot({ name: "escaped", unconfined: true })];
    return s;
  };
  log.advance(sample(1000, false), held);
  const first = log.advance(sample(1000 + hold, false), held);
  expect(first.find((e) => e.kind === "verdict")?.cause).toBe("free-space");
  log.advance(sample(2000 + hold, true), held);
  const second = log.advance(sample(2000 + hold * 2, true), held);
  expect(second.find((e) => e.kind === "verdict")?.cause).toBe("unconfined");
  // The lane leaves: its alert waits out the close and keeps the verdict.
  const waiting = log.advance(sample(3000 + hold * 2, false), held);
  expect(waiting.filter((e) => e.kind === "verdict")).toEqual([]);
  const after = log.advance(sample(3000 + hold * 3, false), held);
  expect(after.find((e) => e.kind === "verdict")?.cause).toBe("free-space");
});
test("a cause turning from a warning to danger is a new verdict", () => {
  const held = defaults();
  const hold = held.pressureHoldSeconds * 1000;
  const log = new EventLog();
  const stalling = (time: number, pressure: number): Snapshot => {
    const s = emptySnapshot(time);
    s.lanes = [laneSnapshot({ name: "busy", pressure })];
    return s;
  };
  const warn = held.pressureAmber + 1;
  const danger = held.pressureRed + 1;
  log.advance(stalling(1000, warn), held);
  const opened = log.advance(stalling(1000 + hold, warn), held);
  expect(opened.find((e) => e.kind === "verdict")?.names.level).toBe("warn");
  const raised = log
    .advance(stalling(2000 + hold, danger), held)
    .find((e) => e.kind === "verdict");
  expect(raised?.cause).toBe("stalls");
  expect(raised?.names).toMatchObject({
    previous: "stalls",
    previousLevel: "warn",
    level: "danger",
  });
});
test("each over-quota path reports its own size, not the largest", () => {
  const log = started();
  const large = emptySnapshot(2000);
  large.storage.scratch = [
    { path: "/small", bytes: c.scratchQuota + 1, age: 0, error: null },
    { path: "/big", bytes: c.scratchQuota + 9999, age: 0, error: null },
  ];
  const opened = log
    .advance(large, c)
    .filter((e) => e.kind === "alert-open" && e.cause === "scratch");
  expect(opened.map((e) => [e.subject, e.values.bytes])).toEqual([
    ["/small", c.scratchQuota + 1],
    ["/big", c.scratchQuota + 9999],
  ]);
});
test("each stalling lane reports its own stall share", () => {
  const log = started();
  const stalling = emptySnapshot(2000);
  stalling.lanes = [
    laneSnapshot({ id: "a.scope", name: "lane-a", pressure: 12 }),
    laneSnapshot({ id: "b.scope", name: "lane-b", pressure: 40 }),
  ];
  const opened = log
    .advance(stalling, c)
    .filter((e) => e.kind === "alert-open" && e.cause === "stalls");
  expect(opened.map((e) => e.values.worst)).toEqual([12, 40]);
});
test("two lanes sharing a display name keep separate identities", () => {
  const log = started();
  const twins = emptySnapshot(2000);
  twins.lanes = [
    laneSnapshot({ id: "a.scope", name: "kendex" }),
    laneSnapshot({ id: "b.scope", name: "kendex" }),
  ];
  const started2 = log.advance(twins, c).filter((e) => e.kind === "lane-start");
  expect(started2.map((e) => e.subject)).toEqual(["kendex", "kendex"]);
  expect(started2.map((e) => e.subjectId)).toEqual(["a.scope", "b.scope"]);
});

test("memory reclaim alerts one per stalled lane, not one for the scope it points at", () => {
  const log = started();
  const s = emptySnapshot(2000);
  s.system.pressure = { memory: { some: 80, full: 0, total: 0 } };
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", memoryPressure: 40 }),
    laneSnapshot({ id: "b", name: "lane-b", memoryPressure: 30 }),
  ];
  // A desktop scope holding swap. The reclaim cause names it as where to
  // look; it is not one of the things that stalled.
  s.groups = [
    groupSnapshot({
      path: "app.slice/gnome.scope",
      name: "gnome.scope",
      swap: 992,
    }),
  ];
  const opened = log
    .advance(s, c)
    .filter((e) => e.kind === "alert-open" && e.cause === "system-memory");
  // One alert per lane waiting on memory, and none for the scope. An alert
  // for it would raise the counts the reader watches on Home and on Timeline
  // for something that had not itself gone wrong, and would churn them every
  // time the top holder changed.
  expect(opened.map((e) => e.subjectId).sort()).toEqual(["a", "b"]);
});
