import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import type { Lane, Snapshot } from "../model/types";
import { type Cause, type CauseId, causes } from "../model/verdict";
import {
  emptySnapshot,
  everyCauseSnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
  volumeSnapshot,
} from "../test/fixture";
import { present } from "../test/present";
import { EventLog, subjects } from "./events";
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
  expect(start[0]?.subject).toBe("lane-a PID 40");
  expect(start[0]?.names).toMatchObject({
    account: "work",
    slice: "agents.slice",
  });
  // The slice comes from the charged cgroup, and an unread account stays empty.
  expect(start[1]?.names).toMatchObject({ account: "", slice: "other.slice" });
  const stop = log
    .advance(emptySnapshot(3000), c)
    .filter((e) => e.kind === "lane-stop");
  expect(stop).toHaveLength(2);
  expect(stop[0]?.subject).toBe("lane-a PID 40");
  expect(stop[0]?.names.slice).toBe("agents.slice");
  expect(stop[0]?.values.age).toBe(30);
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
  expect(move[0]?.subject).toBe("claude PID 40");
  expect(move[0]?.names).toMatchObject({
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
test("only an agent leaving the agent slice carries the cause of the move", () => {
  const probe = (s: Snapshot, failure: "absent" | null) => {
    s.capabilities = s.capabilities.map((cap) =>
      cap.id === "agent-slice"
        ? { ...cap, available: failure === null, failure }
        : cap,
    );
  };
  const rows: [
    string,
    "absent" | null,
    "absent" | null,
    string | null,
    string,
    string,
    CauseId | "",
  ][] = [
    [
      "left the slice",
      null,
      null,
      "claude",
      "agents.slice/a.scope",
      "app.slice/a.scope",
      "unconfined",
    ],
    // A process that was no agent before the move, such as a shell that exec'd
    // one, was never confined, so the move changed no confinement.
    [
      "became an agent",
      null,
      null,
      null,
      "agents.slice/a.scope",
      "app.slice/a.scope",
      "",
    ],
    // Where the probe finds no agent slice, a move is a move and nothing more.
    [
      "no slice",
      null,
      "absent",
      "claude",
      "agents.slice/a.scope",
      "app.slice/a.scope",
      "",
    ],
    // Both ends are judged against the later sample's probe: a slice that
    // appears between the two samples is not a move out of it.
    [
      "slice appeared",
      "absent",
      null,
      "claude",
      "app.slice/a.scope",
      "background.slice/a.scope",
      "",
    ],
  ];
  for (const [name, before, after, tool, from, to, cause] of rows) {
    const first = emptySnapshot(1000);
    probe(first, before);
    first.procs = [processSnapshot({ group: from, tool })];
    const log = started(first);
    const moved = emptySnapshot(2000);
    probe(moved, after);
    moved.procs = [processSnapshot({ group: to })];
    const move = log.advance(moved, c).find((e) => e.kind === "cgroup-move");
    expect({ name, cause: move?.cause }).toEqual({ name, cause });
  }
});
test("an alert closes with the time it stayed open", () => {
  const log = started();
  const firing = emptySnapshot(2000);
  firing.lanes = [laneSnapshot({ name: "escaped", unconfined: true })];
  const opened = log.advance(firing, c).find((e) => e.kind === "alert-open");
  expect(opened?.cause).toBe("unconfined");
  expect(opened?.subject).toBe("escaped PID 40");
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
    {
      path: "/scratch",
      bytes: c.scratchQuota + 1,
      age: 0,
      error: null,
      origin: "configured",
    },
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
  expect(opened?.subject).toBe("agent-b PID 40");
  expect(closed?.subject).toBe("agent-a PID 40");
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
test("a device error increment seen for one sample opens an alert", () => {
  const held = defaults();
  // The increment must be gone well inside the hold, or this proves nothing.
  expect(held.pressureHoldSeconds * 1000).toBeGreaterThan(held.refreshMs);
  const sample = (time: number, delta: Record<string, number>) => {
    const s = emptySnapshot(time);
    s.storage.volumes = [volumeSnapshot("/data", { delta })];
    return s;
  };
  const log = new EventLog();
  log.advance(sample(1000, {}), held);
  // A counter delta is non-zero for exactly the sample after the increment.
  const opened = log
    .advance(sample(2000, { "x/write_io_errs": 1 }), held)
    .filter((e) => e.kind === "alert-open");
  expect(opened.map((e) => [e.cause, e.subjectId])).toEqual([
    ["device-errors", "/data"],
  ]);
  // The delta is back to zero, and the alert still waits out its close.
  const next = log.advance(sample(3000, { "x/write_io_errs": 0 }), held);
  expect(next.filter((e) => e.kind === "alert-close")).toEqual([]);
});
test("two lanes escaping at once are two alerts, not one", () => {
  const log = started();
  const both = emptySnapshot(2000);
  const staying = laneSnapshot({
    id: "a.scope",
    name: "agent-a",
    unconfined: true,
  });
  both.lanes = [
    staying,
    laneSnapshot({ id: "b.scope", name: "agent-b", unconfined: true }),
  ];
  const opened = log
    .advance(both, c)
    .filter((e) => e.kind === "alert-open" && e.cause === "unconfined");
  expect(opened.map((e) => e.subject).sort()).toEqual([
    "agent-a PID 40",
    "agent-b PID 40",
  ]);
  const gone = emptySnapshot(3000);
  gone.lanes = [staying];
  const closed = log.advance(gone, c).filter((e) => e.kind === "alert-close");
  expect(closed.map((e) => e.subject)).toEqual(["agent-b PID 40"]);
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
    {
      path: "/small",
      bytes: c.scratchQuota + 1,
      age: 0,
      error: null,
      origin: "configured",
    },
    {
      path: "/big",
      bytes: c.scratchQuota + 9999,
      age: 0,
      error: null,
      origin: "configured",
    },
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
    laneSnapshot({ id: "a.scope", name: "kendex", mainPid: 4071 }),
    laneSnapshot({ id: "b.scope", name: "kendex", mainPid: 9152 }),
  ];
  // A change row is text with no id column, so each subject names its process
  // when the lane starts and when it stops.
  const named = ["kendex PID 4071", "kendex PID 9152"];
  const started2 = log.advance(twins, c).filter((e) => e.kind === "lane-start");
  expect(started2.map((e) => e.subject)).toEqual(named);
  expect(started2.map((e) => e.subjectId)).toEqual(["a.scope", "b.scope"]);
  const stopped = log
    .advance(emptySnapshot(3000), c)
    .filter((e) => e.kind === "lane-stop");
  expect(stopped.map((e) => e.subject)).toEqual(named);
});

test("host CPU pressure is one host alert while the busiest lane changes", () => {
  const held = defaults();
  // The busiest lane must change inside the hold, or this proves nothing.
  expect(held.pressureHoldSeconds * 1000).toBeGreaterThan(held.refreshMs);
  // Namesakes whose main PID could not be read, and two lanes told apart by
  // their PID. Neither the shared name nor the lane id decides the alert.
  for (const pids of [
    [0, 0],
    [4071, 9152],
  ]) {
    const log = new EventLog();
    const alerts: [string, string][] = [];
    for (let i = 0; i < 60; i++) {
      const s = emptySnapshot(1000 + i * held.refreshMs);
      s.system.pressure = {
        cpu: { some: held.pressureRed + 1, full: 0, total: 0 },
      };
      // No lane stalls on CPU, and the two trade the busiest spot each sample.
      s.lanes = ["a.scope", "b.scope"].map((id, n) =>
        laneSnapshot({
          id,
          name: "kendex",
          mainPid: pids[n],
          cpu: n === i % 2 ? 90 : 89,
        }),
      );
      for (const e of log.advance(s, held))
        if (e.cause === "system-cpu" && e.kind.startsWith("alert-"))
          alerts.push([e.kind, e.subjectId]);
    }
    expect(alerts).toEqual([["alert-open", ""]]);
  }
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

test("a change about a cgroup names it the way a card does, and keeps the unit", () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const log = new EventLog();
  const quiet = everyCauseSnapshot(c);
  quiet.groups = quiet.groups.map((g) =>
    g.name === "gnome.scope"
      ? { ...g, name: "app-Hyprland-ghostty-b95bd288.scope" }
      : g,
  );
  log.advance(quiet, c);
  const events = log.advance({ ...quiet, time: quiet.time + 1000 }, c);
  const swap = events.find((e) => e.cause === "desktop-swap");
  if (!swap) throw new Error("expected a desktop-swap alert");
  // systemd's own name is not a name; the reader gets the one the cards use.
  expect(swap.subject).toBe("ghostty");
  expect(swap.subject).not.toContain(".scope");
  expect(swap.subject).not.toContain("app-");
  // The raw unit stays reachable, for a reader who needs the handle.
  expect(swap.names.unit).toBe("app-Hyprland-ghostty-b95bd288.scope");
  // A lane subject already reads as a name and carries no unit of its own.
  const lane = events.find((e) => e.cause === "memory-cap");
  expect(lane?.subject).toBe("capped PID 40");
  expect(lane?.names.unit ?? "").toBe("");
});

test("host memory pressure with no lane stalled under it is one host alert", () => {
  const log = started();
  const s = emptySnapshot(2000);
  s.system.pressure = { memory: { some: 80, full: 0, total: 0 } };
  // A desktop scope holding swap, and no lane waiting on memory. The cause
  // has nothing of its own to name, so it falls back to one subject.
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
  // Still exactly one alert. `at` is where to look, not a subject, and using
  // it here changes what the one subject is rather than how many there are.
  expect(opened.length).toBe(1);
  // The subject is the host, not the scope `at` points at: a holder change
  // mid-episode must not read as a different identity. The holder's name
  // still shows as the open's display name, with no unit, since it is not
  // the handle this alert's identity carries.
  expect(opened[0]?.subjectId).toBe("");
  expect(opened[0]?.subject).toBe("gnome");
  expect(present(opened[0], "the open").names.unit ?? "").toBe("");
});
test("host memory pressure is one host alert while the swap holder changes", () => {
  const held = defaults();
  // The holder must change inside the hold, or this proves nothing.
  expect(held.pressureHoldSeconds * 1000).toBeGreaterThan(held.refreshMs);
  const log = new EventLog();
  const alerts: [string, string][] = [];
  for (let i = 0; i < 60; i++) {
    const s = emptySnapshot(1000 + i * held.refreshMs);
    s.system.pressure = {
      memory: { some: held.pressureRed + 1, full: 0, total: 0 },
    };
    // No lane stalls on memory, and the swap holder changes identity
    // partway through: group a holds swap through sample 29, group b from 30.
    s.groups = [
      groupSnapshot({
        path: i < 30 ? "app.slice/a.scope" : "app.slice/b.scope",
        name: i < 30 ? "a.scope" : "b.scope",
        swap: 992,
      }),
    ];
    for (const e of log.advance(s, held))
      if (e.cause === "system-memory" && e.kind.startsWith("alert-"))
        alerts.push([e.kind, e.subjectId]);
  }
  // One continuous host alert, not a closed-and-reopened pair fragmented by
  // the holder change.
  expect(alerts).toEqual([["alert-open", ""]]);
});
test("host memory pressure holds one alert while two scopes trade the top swap spot", () => {
  const held = defaults();
  expect(held.pressureHoldSeconds * 1000).toBeGreaterThan(held.refreshMs);
  const log = new EventLog();
  const alerts: [string, string][] = [];
  for (let i = 0; i < 60; i++) {
    const s = emptySnapshot(1000 + i * held.refreshMs);
    s.system.pressure = {
      memory: { some: held.pressureRed + 1, full: 0, total: 0 },
    };
    // Two scopes trade the top swap spot every sample.
    s.groups = [
      groupSnapshot({
        path: "app.slice/a.scope",
        name: "a.scope",
        swap: i % 2 === 0 ? 992 : 900,
      }),
      groupSnapshot({
        path: "app.slice/b.scope",
        name: "b.scope",
        swap: i % 2 === 0 ? 900 : 992,
      }),
    ];
    for (const e of log.advance(s, held))
      if (e.cause === "system-memory" && e.kind.startsWith("alert-"))
        alerts.push([e.kind, e.subjectId]);
  }
  expect(alerts).toEqual([["alert-open", ""]]);
});

test("a cause that names one thing twice opens one alert carrying its unit", () => {
  const log = started();
  const s = emptySnapshot(2000);
  s.system.pressure = { io: { some: 80, full: 0, total: 0 } };
  // The top writer is a scope that is also an agent lane, so `disk` lists it
  // as both on purpose: the lane knows the reader's name, the group knows the
  // systemd unit. Two entries for one identity meant the first created the
  // watch and the second could not add the unit to it.
  s.groups = [
    groupSnapshot({
      path: "agents.slice/a.scope",
      name: "a.scope",
      writeRate: 209715200,
    }),
  ];
  s.lanes = [
    laneSnapshot({ id: "agents.slice/a.scope", name: "lane-a", pids: [40] }),
  ];
  s.procs = [processSnapshot({ pid: 40, build: "ld.mold" })];
  const opened = log
    .advance(s, c)
    .filter((e) => e.kind === "alert-open" && e.cause === "disk");
  expect(opened.length).toBe(1);
  expect(opened[0]?.subjectId).toBe("agents.slice/a.scope");
  expect(opened[0]?.names.unit).toBe("a.scope");
});

test("a verdict led by a cgroup names the unit behind its subject", () => {
  const log = started();
  const s = emptySnapshot(2000);
  // The desktop swapped out is a cgroup-led cause and speaks for the machine,
  // so the verdict it wins names a scope rather than a lane or a path. A group
  // near its memory threshold is housekeeping and never the verdict.
  s.groups = [
    groupSnapshot({
      path: "app.slice",
      name: "app.slice",
      swap: c.swapFloor + 1,
    }),
    groupSnapshot({
      path: "app.slice/gnome.scope",
      name: "gnome.scope",
      swap: 992,
    }),
  ];
  const events = log.advance(s, c);
  const opened = events.find(
    (e) => e.kind === "alert-open" && e.cause === "desktop-swap",
  );
  expect(opened?.names.unit).toBe("gnome.scope");
  const verdict = events.find((e) => e.kind === "verdict");
  expect(verdict).toBeDefined();
  expect(verdict?.subjectId).toBe("app.slice/gnome.scope");
  // The verdict row is a change like any other, so its raw scope handle is
  // reachable from it too.
  expect(verdict?.names.unit).toBe("gnome.scope");
});

test("a scope that becomes a lane while its alert waits opens under one name", () => {
  // A real hold, since the whole defect lives inside it.
  const held = { ...defaults(), pressureHoldSeconds: 10 };
  const unit = "agent-confine-854045-20986.scope";
  const path = `app.slice/${unit}`;
  /** The desktop slice over its swap floor, held by one scope. */
  const swapping = (time: number, lanes: boolean): Snapshot => {
    const s = emptySnapshot(time);
    // The slice total is the sum over its roots, and the holder is the scope
    // under it with the most swap.
    s.groups = [
      groupSnapshot({
        path: "app.slice",
        name: held.desktopSlice,
        swap: held.swapFloor + 1,
      }),
      groupSnapshot({ path, parent: "app.slice", name: unit, swap: 992 }),
    ];
    if (lanes) s.lanes = [laneSnapshot({ id: path, name: "confine" })];
    return s;
  };
  const named = (s: Snapshot) => {
    const cause = causes(s, held).find((x) => x.id === "desktop-swap");
    expect(cause).toBeDefined();
    return subjects(cause as Cause, s).map((x) => `${x.id} ${x.name}`);
  };
  const anonymous = swapping(0, false);
  const renamed = swapping(5000, true);
  // What the fixture has to move, read before and against: one subject, one
  // identity, two names. A plant cannot catch a fixture where the scope never
  // becomes a lane, so the rename is asserted rather than assumed.
  expect(named(anonymous)).toEqual([`${path} agent 854045`]);
  expect(named(renamed)).toEqual([`${path} confine PID 40`]);

  const log = new EventLog();
  const out: ReturnType<EventLog["advance"]>[] = [];
  log.advance(anonymous, held);
  out.push(log.advance(renamed, held));
  // Past the hold, so the alert opens under the name the sample that opened it
  // read, and the verdict opens with it.
  out.push(log.advance(swapping(15000, true), held));
  // The swap goes. The close waits out its own hold and then names the alert
  // the way its open did.
  const quiet = emptySnapshot(30000);
  quiet.lanes = [laneSnapshot({ id: path, name: "confine" })];
  out.push(log.advance(quiet, held));
  const events = out
    .flat()
    .filter((x) => x.cause === "desktop-swap")
    .map((x) => `${x.kind} ${x.subject} ${x.names.unit}`);
  // One alert under one name from open to close, and the verdict that follows
  // it says the same. Under the frozen name these read `agent 854045`, which
  // is a scope the reader can no longer find: it is a lane now.
  expect(events).toEqual([
    `alert-open confine PID 40 ${unit}`,
    `verdict confine PID 40 ${unit}`,
    `alert-close confine PID 40 ${unit}`,
  ]);
});

test("a lane that starts writing the most while its alert waits keeps its handle", () => {
  const held = { ...defaults(), pressureHoldSeconds: 10 };
  const id = "agents.slice/l.scope";
  /** Disk pressure with one lane stalling on it, and one scope writing most. */
  const stalling = (time: number, laneWrites: boolean): Snapshot => {
    const s = emptySnapshot(time);
    s.system.pressure.io = { some: held.pressureAmber + 1, full: 0, total: 0 };
    s.lanes = [laneSnapshot({ id, name: "worker", ioPressure: 90 })];
    s.groups = [
      groupSnapshot({ path: "other.scope", name: "other.scope", writeRate: 2 }),
      groupSnapshot({
        path: id,
        parent: "agents.slice",
        name: "l.scope",
        writeRate: laneWrites ? 9 : 1,
      }),
    ];
    return s;
  };
  const handles = (s: Snapshot) => {
    const cause = causes(s, held).find((x) => x.id === "disk");
    expect(cause).toBeDefined();
    return subjects(cause as Cause, s)
      .filter((x) => x.id === id)
      .map((x) => `${x.name} ${x.unit ?? ""}`);
  };
  // What the fixture has to move. The lane is a subject of this cause either
  // way; what changes is whether the cause also names it as the writing scope,
  // which is where the raw handle comes from.
  expect(handles(stalling(0, false))).toEqual(["worker PID 40 "]);
  expect(handles(stalling(5000, true))).toEqual(["worker PID 40 l.scope"]);

  const log = new EventLog();
  log.advance(stalling(0, false), held);
  log.advance(stalling(5000, true), held);
  const opened = log
    .advance(stalling(15000, true), held)
    .filter((e) => e.kind === "alert-open" && e.subjectId === id)
    .map((e) => e.names.unit);
  // Frozen at the first sample of the hold, the alert opens with no handle at
  // all, so the selected row cannot show the scope the reader would run
  // `systemctl` against.
  expect(opened).toEqual(["l.scope"]);
});

/** A row of the unread-input tests: one cause on one subject, sample by sample. */
interface Unread {
  name: string;
  cause: CauseId;
  subjectId: string;
  /** The input read over its threshold. */
  firing: (s: Snapshot) => void;
  /** The input read under it, or the subject gone, by row. */
  quiet: (s: Snapshot) => void;
}
const held = defaults();
const hold = held.pressureHoldSeconds * 1000;
const lane = (pressure: number | null, o: Partial<Lane> = {}) =>
  laneSnapshot({
    id: "agents.slice/l.scope",
    name: "worker",
    pressure,
    memoryPressure: pressure,
    ioPressure: pressure,
    ...o,
  });
/** The desktop slice as the cgroup root itself, holding `swap`. */
const desktopRoot = (swap: number | null) =>
  groupSnapshot({ path: ".", name: held.desktopSlice, swap });
/** Host CPU pressure at `some`. */
const hostCpu = (s: Snapshot, some: number) => {
  s.system.pressure = { cpu: { some, full: 0, total: 0 } };
};
/** Opens the row's alert and returns the log with the time it last fired. */
function opened(row: Unread): { log: EventLog; last: number } {
  const log = new EventLog();
  const at = (time: number) => {
    const s = emptySnapshot(time);
    row.firing(s);
    return log.advance(s, held);
  };
  at(1000);
  const open = at(1000 + hold).filter(
    (e) => e.kind === "alert-open" && e.cause === row.cause,
  );
  expect({ name: row.name, open: open.map((e) => e.subjectId) }).toEqual({
    name: row.name,
    open: [row.subjectId],
  });
  return { log, last: 1000 + hold };
}
test("an open alert stays open while its input cannot be read", () => {
  // The unread run must outlast the hold several times over, or a close the
  // hold would have issued never comes due.
  expect(hold).toBeGreaterThan(held.refreshMs);
  const rows: (Unread & { unread: (s: Snapshot) => void })[] = [
    {
      name: "host CPU",
      cause: "system-cpu",
      subjectId: "",
      firing: (s) => {
        s.system.pressure = {
          cpu: { some: held.pressureRed + 1, full: 0, total: 0 },
        };
      },
      unread: (s) => {
        s.system.pressure = {};
      },
      quiet: () => {},
    },
    {
      name: "lane stall",
      cause: "stalls",
      subjectId: "agents.slice/l.scope",
      firing: (s) => {
        s.lanes = [lane(held.pressureRed + 1)];
      },
      unread: (s) => {
        s.lanes = [lane(null)];
      },
      quiet: (s) => {
        s.lanes = [lane(0)];
      },
    },
    // Only the resource that crossed goes unread; the others read low.
    {
      name: "lane stall on one resource",
      cause: "stalls",
      subjectId: "agents.slice/l.scope",
      firing: (s) => {
        s.lanes = [lane(0, { pressure: held.pressureRed + 1 })];
      },
      unread: (s) => {
        s.lanes = [lane(0, { pressure: null })];
      },
      quiet: (s) => {
        s.lanes = [lane(0)];
      },
    },
    // The cgroup root points at the desktop slice, so its root sits at ".".
    {
      name: "desktop swap on a root at the cgroup root",
      cause: "desktop-swap",
      subjectId: "",
      firing: (s) => {
        s.groups = [desktopRoot(held.swapFloor + 1)];
      },
      unread: (s) => {
        s.groups = [desktopRoot(null)];
      },
      quiet: (s) => {
        s.groups = [desktopRoot(0)];
      },
    },
  ];
  for (const row of rows) {
    const { log, last } = opened(row);
    const changes: string[] = [];
    const at = (time: number, fill: (s: Snapshot) => void) => {
      const s = emptySnapshot(time);
      fill(s);
      for (const e of log.advance(s, held))
        if (e.kind === "verdict" || e.cause === row.cause)
          changes.push(`${time} ${e.kind}`);
    };
    const samples = 3 * (hold / held.refreshMs);
    for (let i = 1; i <= samples; i++)
      at(last + i * held.refreshMs, row.unread);
    // Unread past the hold: no close, and the verdict does not move.
    expect({ name: row.name, changes }).toEqual({
      name: row.name,
      changes: [],
    });
    // Read again below the threshold: the close waits a full hold from the
    // last sample that could not judge it, then reports the observed time.
    const unreadUntil = last + samples * held.refreshMs;
    at(unreadUntil + held.refreshMs, row.quiet);
    at(unreadUntil + hold - 1, row.quiet);
    expect({ name: row.name, changes }).toEqual({
      name: row.name,
      changes: [],
    });
    const close = emptySnapshot(unreadUntil + hold);
    row.quiet(close);
    const out = log.advance(close, held);
    expect({
      name: row.name,
      kinds: out.map((e) => e.kind).sort(),
      duration: out.find((e) => e.kind === "alert-close")?.values.durationMs,
    }).toEqual({
      name: row.name,
      kinds: ["alert-close", "verdict"],
      duration: hold,
    });
  }
});
test("a pending alert on an unread sample ends, as on a gap", () => {
  const log = new EventLog();
  const at = (time: number, pressure: number | null) => {
    const s = emptySnapshot(time);
    s.lanes = [lane(pressure)];
    return log
      .advance(s, held)
      .filter((e) => e.cause === "stalls" && e.kind.startsWith("alert-"));
  };
  at(1000, held.pressureRed + 1);
  at(1000 + held.refreshMs, null);
  // Fired for the hold counted from the first sample, but an unread sample
  // broke it, so nothing opens until the hold runs again from the return.
  expect(at(1000 + hold, held.pressureRed + 1)).toEqual([]);
  expect(at(1000 + 2 * hold, held.pressureRed + 1).map((e) => e.kind)).toEqual([
    "alert-open",
  ]);
});
test("an alert whose subject the sample no longer holds closes after the hold", () => {
  const path = "/scratch";
  const group = "agents.slice/h.scope";
  const rows: Unread[] = [
    {
      name: "lane gone",
      cause: "stalls",
      subjectId: "agents.slice/l.scope",
      firing: (s) => {
        s.lanes = [lane(held.pressureRed + 1)];
      },
      quiet: () => {},
    },
    {
      name: "scratch path gone",
      cause: "scratch",
      subjectId: path,
      firing: (s) => {
        s.storage.scratch = [
          {
            path,
            bytes: held.scratchQuota + 1,
            age: 0,
            error: null,
            origin: "configured",
          },
        ];
      },
      quiet: () => {},
    },
    {
      name: "group gone",
      cause: "memory-high",
      subjectId: group,
      firing: (s) => {
        s.groups = [
          groupSnapshot({
            path: group,
            name: "h.scope",
            memory: 100,
            high: 100,
          }),
        ];
      },
      quiet: () => {},
    },
    // A host reading that fails does not hold an alert on a lane that left.
    {
      name: "lane gone while host CPU is unread",
      cause: "system-cpu",
      subjectId: "agents.slice/l.scope",
      firing: (s) => {
        hostCpu(s, held.pressureRed + 1);
        s.lanes = [lane(0, { pressure: held.pressureAmber + 1 })];
      },
      quiet: (s) => {
        s.system.pressure = {};
      },
    },
    {
      name: "desktop slice gone",
      cause: "desktop-swap",
      subjectId: "",
      firing: (s) => {
        s.groups = [
          groupSnapshot({
            path: "app.slice",
            name: held.desktopSlice,
            swap: held.swapFloor + 1,
          }),
        ];
      },
      quiet: () => {},
    },
  ];
  for (const row of rows) {
    const { log, last } = opened(row);
    const closes = (time: number) => {
      const s = emptySnapshot(time);
      row.quiet(s);
      return log
        .advance(s, held)
        .filter((e) => e.kind === "alert-close" && e.cause === row.cause)
        .map((e) => e.subjectId);
    };
    expect({ name: row.name, early: closes(last + hold - 1) }).toEqual({
      name: row.name,
      early: [],
    });
    expect({ name: row.name, due: closes(last + hold) }).toEqual({
      name: row.name,
      due: [row.subjectId],
    });
  }
});
test("an unread lane holds its own alert and closes another lane's on time", () => {
  const a = "agents.slice/a.scope";
  const b = "agents.slice/b.scope";
  const log = new EventLog();
  const at = (time: number, left: number | null, right: number | null) => {
    const s = emptySnapshot(time);
    s.lanes = [
      lane(left, { id: a, name: "a" }),
      lane(right, { id: b, name: "b" }),
    ];
    return log
      .advance(s, held)
      .filter((e) => e.cause === "stalls" && e.kind.startsWith("alert-"))
      .map((e) => `${e.kind} ${e.subjectId}`);
  };
  const red = held.pressureRed + 1;
  at(1000, red, red);
  expect(at(1000 + hold, red, red)).toEqual([
    `alert-open ${a}`,
    `alert-open ${b}`,
  ]);
  // Lane a goes unread and lane b reads zero: b closes after the hold, and a
  // stays open however long its reading stays away.
  const last = 1000 + hold;
  const seen: string[] = [];
  for (let t = last + held.refreshMs; t <= last + 3 * hold; t += held.refreshMs)
    for (const e of at(t, null, 0)) seen.push(`${t - last} ${e}`);
  expect(seen).toEqual([`${hold} alert-close ${b}`]);
});
