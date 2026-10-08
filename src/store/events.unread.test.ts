import { afterEach, expect, spyOn, test } from "bun:test";
import type { Snapshot } from "../model/types";
import {
  emptySnapshot,
  fixture,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import { EventLog } from "./events";
import { History } from "./history";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});
function persisted() {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const open = () => {
    const h = new History(f.config);
    cleanup.push(() => h.close());
    return h;
  };
  return { config: f.config, open };
}
/** A sample that read processes and holds the one lane, or does not. */
const read = (time: number, lane: boolean): Snapshot => ({
  ...emptySnapshot(time),
  lanes: lane ? [laneSnapshot()] : [],
});
/** A sample whose process read missed its deadline. */
const unread = (time: number): Snapshot => ({
  ...emptySnapshot(time),
  processRead: "unknown",
});
const laneEvents = (h: History, end: number) =>
  h
    .events(end, 60_000)
    .filter((e) => e.kind === "lane-start" || e.kind === "lane-stop")
    .map((e) => [e.kind, e.time] as const)
    .sort((a, b) => a[1] - b[1]);

test("a restart after an unread sample does not start a lane that never stopped", () => {
  const { open } = persisted();
  const t = Date.now();
  const before = open();
  before.add(read(t, true));
  before.add(unread(t + 1000));
  before.close();
  const after = open();
  after.add(read(t + 2000, true));
  expect(laneEvents(after, t + 2000)).toEqual([]);
});

test("a lane another dashboard saw gone starts again when it returns", () => {
  const { open } = persisted();
  const t = Date.now();
  const first = open();
  const second = open();
  first.add(read(t, true));
  first.add(unread(t + 1000));
  second.add(read(t + 2000, false));
  first.add(read(t + 3000, true));
  expect(laneEvents(first, t + 3000)).toEqual([
    ["lane-stop", t + 2000],
    ["lane-start", t + 3000],
  ]);
});

test("a process that moved slice while its read was out is a move when it is read again", () => {
  const { config } = persisted();
  const log = new EventLog();
  const at = (time: number, group: string): Snapshot => ({
    ...emptySnapshot(time),
    procs: [processSnapshot({ group })],
  });
  log.advance(at(1000, "/agents.slice/a.scope"), config);
  expect(log.advance(unread(2000), config)).toEqual([]);
  const moved = log.advance(at(3000, "/app.slice/b.scope"), config);
  expect(
    moved
      .filter((e) => e.kind === "cgroup-move")
      .map((e) => [e.subjectId, e.names.from, e.names.to]),
  ).toEqual([["40:100", "/agents.slice/a.scope", "/app.slice/b.scope"]]);
});

test("a write after many unread samples inflates the predecessor and the marked read, no more", () => {
  const { open } = persisted();
  const t = Date.now();
  const first = open();
  const second = open();
  first.add(read(t, true));
  for (let i = 1; i <= 60; i++) first.add(unread(t + i * 1000));
  const gunzip = spyOn(Bun, "gunzipSync");
  try {
    // Two dashboards alternating: each write reads its predecessor from the
    // database, because the other one wrote it.
    for (let i = 61; i <= 64; i++) {
      gunzip.mockClear();
      (i % 2 ? second : first).add(unread(t + i * 1000));
      expect(gunzip.mock.calls.length).toBeLessThanOrEqual(2);
    }
    gunzip.mockClear();
    second.add(read(t + 65_000, true));
    expect(gunzip.mock.calls.length).toBeLessThanOrEqual(2);
  } finally {
    gunzip.mockRestore();
  }
  // The marked read is the predecessor: the lane never stopped.
  expect(laneEvents(second, t + 65_000)).toEqual([]);
});

test("an unconfirmed tool's alert neither closes nor opens again across an unread sample", () => {
  const { config } = persisted();
  const log = new EventLog();
  const hold = config.pressureHoldSeconds * 1000;
  const at = (time: number): Snapshot => ({
    ...emptySnapshot(time),
    procs: [
      processSnapshot({
        unconfirmedTool: "pi",
        unconfirmedPath: "/opt/pi/bin/pi",
        unconfirmedMatch: "name",
      }),
    ],
  });
  log.advance(at(1000), config);
  const opened = log.advance(at(1000 + hold), config);
  expect(opened.map((e) => [e.kind, e.cause])).toContainEqual([
    "alert-open",
    "unconfirmed-tool",
  ]);
  const alerts = (events: { kind: string }[]) =>
    events.filter((e) => e.kind === "alert-open" || e.kind === "alert-close");
  expect(alerts(log.advance(unread(2000 + hold), config))).toEqual([]);
  expect(alerts(log.advance(unread(3000 + 3 * hold), config))).toEqual([]);
  expect(alerts(log.advance(at(4000 + 3 * hold), config))).toEqual([]);
});
