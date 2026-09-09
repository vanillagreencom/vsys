import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import type { Snapshot } from "../model/types";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import { EventLog } from "./events";
import { History } from "./history";

const c = defaults();
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
    from: "app.slice",
    to: "agents.slice",
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
  expect(closed?.values.durationMs).toBe(4000);
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
  const firing = emptySnapshot(2000);
  firing.lanes = [laneSnapshot({ name: "escaped", unconfined: true })];
  history.add(firing);
  expect(history.events(2000, 10000).map((e) => e.kind)).toContain(
    "alert-open",
  );
  const changed = history.reconfigure({ ...c, refreshMs: 2000 });
  changed.add(emptySnapshot(6000));
  const closed = changed
    .events(6000, 10000)
    .find((e) => e.kind === "alert-close");
  expect(closed?.values.durationMs).toBe(4000);
  changed.close();
  history.close();
});
