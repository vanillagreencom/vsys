import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "../config/config";
import {
  emptySnapshot,
  fixture,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import { History, Ring } from "./history";
import { normalizeSnapshot } from "./migrate";
import { point } from "./point";

const cleanup: (() => void)[] = [];

test("legacy snapshots lack process totals but retain cgroup measurements", () => {
  const s = emptySnapshot();
  s.groups = [groupSnapshot({ cpuPercent: 0, swap: 0, tasks: 0 })];
  s.lanes = [laneSnapshot({ builds: { rustc: 1 }, linkers: 0 })];
  const { processRead: _outcome, ...legacy } = s;
  const replay = normalizeSnapshot(JSON.parse(JSON.stringify(legacy)));
  expect(replay.processRead).toBe("unknown");
  const lane = replay.lanes[0];
  expect([
    lane?.rss,
    lane?.cpu,
    lane?.swap,
    lane?.tasks,
    lane?.builds,
    lane?.linkers,
  ]).toEqual([null, 0, 0, 0, null, null]);
  expect(normalizeSnapshot(replay)).toEqual(replay);
  expect(normalizeSnapshot(s)).toEqual(s);
});
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
test("ring wraps in chronological order and rejects zero capacity", () => {
  const ring = new Ring<number>(2);
  ring.push(1);
  ring.push(2);
  expect(ring.push(3)).toBe(1);
  expect(ring.all()).toEqual([2, 3]);
  expect(() => new Ring(0)).toThrow();
});
test("cursor gets the prior snapshot and keeps independent historical values", () => {
  const h = new History(defaults());
  cleanup.push(() => h.close());
  const s = emptySnapshot(1000);
  h.add(s);
  s.system.host = "changed";
  s.time = 2000;
  h.add(s);
  expect(h.at(999)).toBeNull();
  expect(h.at(1500)?.system.host).toBe("fixture");
  expect(h.at(2000)?.system.host).toBe("changed");
  expect(h.window(2000, 500).map((p) => p.time)).toEqual([2000]);
});
test("a sample stamped at or before the newest stored one is not stored", () => {
  const h = new History(defaults());
  cleanup.push(() => h.close());
  h.add(emptySnapshot(1_000_000));
  const back = emptySnapshot(998_000);
  back.system.host = "after the step";
  // The clock stepped back two seconds, then a sample repeats a stored time.
  expect(() => h.add(back)).not.toThrow();
  h.add({ ...back, time: 1_000_000 });
  expect(h.window(1_000_000, 10_000).map((p) => p.time)).toEqual([1_000_000]);
  expect(h.at(1_000_000)?.system.host).toBe("fixture");
  expect(h.at(998_000)).toBeNull();
  // The clock passed the newest stored time, so recording continues.
  h.add({ ...back, time: 1_000_001 });
  expect(h.window(1_000_001, 10_000).map((p) => p.time)).toEqual([
    1_000_000, 1_000_001,
  ]);
  expect(h.at(1_000_001)?.system.host).toBe("after the step");
});
test("a sample that is not stored changes no event state", () => {
  const h = new History(defaults());
  cleanup.push(() => h.close());
  const laned = (time: number) => {
    const s = emptySnapshot(time);
    s.lanes = [laneSnapshot()];
    return s;
  };
  h.add(laned(1_000_000));
  // The lane is gone only in the sample the clock step keeps out of history.
  h.add(emptySnapshot(998_000));
  h.add(laned(1_000_001));
  expect(h.events(1_000_001, 10_000)).toEqual([]);
});
test("a restart whose clock is behind the newest stored row stores nothing until the clock passes it", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  // The row a session wrote before the clock was set back a minute.
  const ahead = Date.now() + 60_000;
  const first = new History(f.config);
  first.add(emptySnapshot(ahead));
  first.close();
  const reopened = new History(f.config);
  const live = emptySnapshot(ahead - 60_000);
  live.system.host = "restarted";
  reopened.add(live);
  expect(reopened.window(ahead, 120_000).map((p) => p.time)).toEqual([ahead]);
  reopened.add({ ...live, time: ahead + 1 });
  expect(reopened.window(ahead + 1, 120_000).map((p) => p.time)).toEqual([
    ahead,
    ahead + 1,
  ]);
  expect(reopened.at(ahead + 1)?.system.host).toBe("restarted");
  reopened.close();
  const db = new Database(f.config.sqlitePath, { readonly: true });
  cleanup.push(() => db.close());
  expect(
    db
      .query<{ time: number }, []>("SELECT time FROM samples ORDER BY time")
      .all()
      .map((row) => row.time),
  ).toEqual([ahead, ahead + 1]);
});
test("SQLite reopens full process snapshots and alert history", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const now = Date.now();
  const first = new History(f.config);
  const s = emptySnapshot(now);
  s.alerts.push({
    time: now,
    rule: "btrfs-ro",
    subject: "/",
    message: "read only",
  });
  first.add(s);
  first.close();
  const reopened = new History(f.config);
  cleanup.push(() => reopened.close());
  expect(reopened.at(now)).toEqual(s);
  expect(reopened.alerts(now)).toEqual(s.alerts);
});
for (const resume of ["collision", "foreign append", "restart", "reconfigure"])
  test(`snapshot events follow the stored predecessor after ${resume}`, () => {
    const f = fixture();
    cleanup.push(f.cleanup);
    f.config.persistence = true;
    const first = new History(f.config);
    cleanup.push(() => first.close());
    const second = new History(f.config);
    cleanup.push(() => second.close());
    const time = Date.now();
    const original = emptySnapshot(time);
    original.lanes = [laneSnapshot()];
    original.procs = [processSnapshot({ group: "agents.slice/before.scope" })];
    second.add(emptySnapshot(time - 2));
    first.add(emptySnapshot(time - 1));
    first.add(original);
    if (resume === "collision") {
      const collision = emptySnapshot(time);
      collision.lanes = [laneSnapshot({ id: "collision.scope" })];
      expect(() => second.add(collision)).not.toThrow();
      expect(second.events(time, 10)).toEqual([]);
      expect(second.window(time, 10).map((p) => p.time)).toEqual([time - 2]);
    }
    const reader = new History(f.config);
    cleanup.push(() => reader.close());
    expect(reader.at(time)).toEqual(original);
    expect(reader.events(time, 10)).toEqual(first.events(time, 10));
    expect(second.at(time)).toEqual(original);
    const writer =
      resume === "restart"
        ? reader
        : resume === "reconfigure"
          ? second.reconfigure({ ...f.config, refreshMs: 2000 })
          : second;
    if (resume === "reconfigure") cleanup.push(() => writer.close());
    const stopped = emptySnapshot(time + 1);
    stopped.procs = [processSnapshot({ group: "agents.slice/after.scope" })];
    writer.add(stopped);
    const changes = writer.events(time + 1, 0);
    expect(changes.map((event) => event.kind)).toEqual([
      "lane-stop",
      "cgroup-move",
    ]);
    expect(changes.find((event) => event.kind === "lane-stop")?.subjectId).toBe(
      laneSnapshot().id,
    );
    expect(
      changes.find((event) => event.kind === "cgroup-move")?.names,
    ).toMatchObject({
      from: "agents.slice/before.scope",
      to: "agents.slice/after.scope",
    });
    const persisted = new History(f.config);
    cleanup.push(() => persisted.close());
    expect(persisted.events(time + 1, 0)).toEqual(changes);
    expect(persisted.window(time + 1, 10).map((p) => p.time)).toEqual([
      time - 2,
      time - 1,
      time,
      time + 1,
    ]);
  });
test("a stored lane written before this build's fields loads with unknown values", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const now = Date.now();
  const first = new History(f.config);
  const s = emptySnapshot(now);
  const written = laneSnapshot();
  s.lanes = [written];
  first.add(s);
  first.close();
  // What an older build wrote: a lane with none of the fields added since.
  const stored = {
    ...s,
    lanes: [{ id: written.id, name: "lane-a", mainPid: 40, pids: [40] }],
  };
  const db = new Database(f.config.sqlitePath);
  db.query("UPDATE samples SET data = ? WHERE time = ?").run(
    Bun.gzipSync(JSON.stringify(stored)),
    now,
  );
  db.close();
  const reopened = new History(f.config);
  cleanup.push(() => reopened.close());
  const lane = reopened.at(now)?.lanes[0];
  expect(lane?.name).toBe("lane-a");
  expect(lane?.builds).toBeNull();
  expect([lane?.memoryMaxKnown, lane?.blocked, lane?.blockedOn]).toEqual([
    false,
    0,
    null,
  ]);
});
test("a stored memberless lane written before unknown memory and age loads with neither", async () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const now = Date.now();
  const first = new History(f.config);
  const s = emptySnapshot(now);
  // What an older build wrote: a synthetic 0 for the memory and age of a lane
  // with no member read, beside a lane with members whose readings stand.
  const empty = laneSnapshot({
    id: "agents.slice/gone.scope",
    mainPid: 0,
    pids: [],
    rss: 0,
    age: 0,
  });
  const live = laneSnapshot({ rss: 2048, age: 30 });
  s.lanes = [empty, live];
  first.add(s);
  first.close();
  const reopened = new History(f.config);
  cleanup.push(() => reopened.close());
  expect(
    reopened.at(now)?.lanes.map((lane) => [lane.id, lane.rss, lane.age]),
  ).toEqual([
    [empty.id, null, null],
    [live.id, 2048, 30],
  ]);
  const series = await reopened.laneWindows([empty.id, live.id], now, 1000);
  expect([
    series.get(empty.id)?.map((x) => x.rss),
    series.get(live.id)?.map((x) => x.rss),
  ]).toEqual([[null], [2048]]);
});
test("a stored snapshot written before the capability probe loads with none", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const now = Date.now();
  const first = new History(f.config);
  const s = emptySnapshot(now);
  first.add(s);
  first.close();
  // What an older build wrote: a snapshot with no capabilities key at all.
  const { capabilities, ...stored } = s;
  expect(capabilities.length).toBeGreaterThan(0);
  const db = new Database(f.config.sqlitePath);
  db.query("UPDATE samples SET data = ? WHERE time = ?").run(
    Bun.gzipSync(JSON.stringify(stored)),
    now,
  );
  db.close();
  const reopened = new History(f.config);
  cleanup.push(() => reopened.close());
  expect(reopened.at(now)?.capabilities).toEqual([]);
});
test("stored group limits infer numeric readings and preserve recorded flags", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const now = Date.now();
  const first = new History(f.config);
  const s = emptySnapshot(now);
  const measured = groupSnapshot({
    high: 1048576,
    swapMax: 0,
    tasksMax: 512,
    highRead: true,
    swapMaxRead: false,
    tasksMaxRead: true,
  });
  s.groups = [measured];
  first.add(s);
  first.close();
  const rows = [
    { values: { high: null, swapMax: null, tasksMax: null }, known: false },
    { values: { high: 1048576, swapMax: 0, tasksMax: 512 }, known: true },
    { values: { high: 0, swapMax: 0, tasksMax: 0 }, known: true },
  ];
  const legacy = rows.map(({ values }) => {
    const { highRead, swapMaxRead, tasksMaxRead, ...group } =
      groupSnapshot(values);
    return group;
  });
  const unlimited = groupSnapshot({
    highRead: false,
    swapMaxRead: true,
    tasksMaxRead: false,
  });
  const stored = { ...s, groups: [...legacy, measured, unlimited] };
  const db = new Database(f.config.sqlitePath);
  db.query("UPDATE samples SET data = ? WHERE time = ?").run(
    Bun.gzipSync(JSON.stringify(stored)),
    now,
  );
  db.close();
  const reopened = new History(f.config);
  cleanup.push(() => reopened.close());
  expect(
    reopened
      .at(now)
      ?.groups.map((g) => [g.highRead, g.swapMaxRead, g.tasksMaxRead]),
  ).toEqual([
    ...rows.map(({ known }) => [known, known, known]),
    [true, false, true],
    [false, true, false],
  ]);
});

test("a stored scratch row written before root origins loads with an unknown origin", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const now = Date.now();
  const first = new History(f.config);
  const s = emptySnapshot(now);
  first.add(s);
  first.close();
  // What an older build wrote: a scratch row with no origin key at all.
  const stored = {
    ...s,
    storage: {
      ...s.storage,
      scratch: [{ path: "/scratch", bytes: 1, age: 0, error: null }],
    },
  };
  const db = new Database(f.config.sqlitePath);
  db.query("UPDATE samples SET data = ? WHERE time = ?").run(
    Bun.gzipSync(JSON.stringify(stored)),
    now,
  );
  db.close();
  const reopened = new History(f.config);
  cleanup.push(() => reopened.close());
  expect(reopened.at(now)?.storage.scratch).toEqual([
    { path: "/scratch", bytes: 1, age: 0, error: null, origin: null },
  ]);
});
test("a stored scratch row written before nullable age loads a failed root with no age", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const now = Date.now();
  const first = new History(f.config);
  const s = emptySnapshot(now);
  first.add(s);
  first.close();
  // What an older build wrote for a root it could not read: a synthetic
  // zero age beside the null size no successful reading ever leaves.
  const stored = {
    ...s,
    storage: {
      ...s.storage,
      scratch: [
        {
          path: "/gone",
          bytes: null,
          age: 0,
          error: "ENOENT",
          origin: "configured",
        },
      ],
    },
  };
  const db = new Database(f.config.sqlitePath);
  db.query("UPDATE samples SET data = ? WHERE time = ?").run(
    Bun.gzipSync(JSON.stringify(stored)),
    now,
  );
  db.close();
  const reopened = new History(f.config);
  cleanup.push(() => reopened.close());
  expect(reopened.at(now)?.storage.scratch).toEqual([
    {
      path: "/gone",
      bytes: null,
      age: null,
      error: "ENOENT",
      origin: "configured",
    },
  ]);
});
test("a stored device row written before lifetime-write sources loads with an unknown source", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const now = Date.now();
  const first = new History(f.config);
  const s = emptySnapshot(now);
  first.add(s);
  first.close();
  // What an older build wrote: a device row with no source key at all.
  const stored = {
    ...s,
    storage: {
      ...s.storage,
      devices: [
        { name: "sda", number: "8:0", model: null, lifetimeWritten: null },
      ],
    },
  };
  const db = new Database(f.config.sqlitePath);
  db.query("UPDATE samples SET data = ? WHERE time = ?").run(
    Bun.gzipSync(JSON.stringify(stored)),
    now,
  );
  db.close();
  const reopened = new History(f.config);
  cleanup.push(() => reopened.close());
  expect(reopened.at(now)?.storage.devices).toEqual([
    {
      name: "sda",
      number: "8:0",
      model: null,
      lifetimeWritten: null,
      source: null,
    },
  ]);
});
test("a stored cache reading written before the query outcome loads with no invented cause", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const now = Date.now();
  const first = new History(f.config);
  first.add(emptySnapshot(now));
  first.add(emptySnapshot(now + 1000));
  first.add(emptySnapshot(now + 2000));
  first.close();
  const delta = { hits: 3, misses: 1, windowMs: 1000 };
  const failed = {
    state: "failed" as const,
    hits: null,
    misses: null,
    sinceStart: null,
    recent: null,
  };
  // What an older build wrote: a flag for counters read, and no state.
  const rows = [
    {
      time: now,
      stored: {
        available: true,
        hits: 9,
        misses: 3,
        sinceStart: delta,
        recent: delta,
      },
      loaded: {
        state: "read" as const,
        hits: 9,
        misses: 3,
        sinceStart: delta,
        recent: delta,
      },
    },
    {
      // A missing program and a failed query both stored false, so neither
      // cause is claimed.
      time: now + 1000,
      stored: {
        available: false,
        hits: null,
        misses: null,
        sinceStart: null,
        recent: null,
      },
      loaded: undefined,
    },
    {
      // The current shape passes through unchanged.
      time: now + 2000,
      stored: failed,
      loaded: failed,
    },
  ];
  const db = new Database(f.config.sqlitePath);
  for (const row of rows)
    db.query("UPDATE samples SET data = ? WHERE time = ?").run(
      Bun.gzipSync(
        JSON.stringify({ ...emptySnapshot(row.time), sccache: row.stored }),
      ),
      row.time,
    );
  db.close();
  const reopened = new History(f.config);
  cleanup.push(() => reopened.close());
  for (const row of rows)
    expect(reopened.at(row.time)?.sccache).toEqual(row.loaded);
});
test("history refuses an existing database owned by another application", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const db = new Database(f.config.sqlitePath);
  db.exec("CREATE TABLE other_app (data TEXT); PRAGMA user_version=7");
  db.close();
  expect(() => new History(f.config)).toThrow();
  const check = new Database(f.config.sqlitePath, { readonly: true });
  try {
    expect(
      check.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version,
    ).toBe(7);
    expect(
      check
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table'",
        )
        .all(),
    ).toEqual([{ name: "other_app" }]);
  } finally {
    check.close();
  }
});
test("a database containing only a view still belongs to its existing application", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const db = new Database(f.config.sqlitePath);
  db.exec("CREATE VIEW report AS SELECT 1 AS value");
  db.close();
  expect(() => new History(f.config)).toThrow();
  const check = new Database(f.config.sqlitePath, { readonly: true });
  try {
    expect(
      check.query<{ name: string }, []>("SELECT name FROM sqlite_master").all(),
    ).toEqual([{ name: "report" }]);
  } finally {
    check.close();
  }
});
test("changing refresh preserves the retained incident and timeline", () => {
  const h = new History(defaults());
  cleanup.push(() => h.close());
  const s = emptySnapshot(1000);
  s.alerts = [
    { time: 1000, rule: "btrfs-ro", subject: "/", message: "read only" },
  ];
  h.add(s);
  h.add(emptySnapshot(2000));
  const changed = h.reconfigure({ ...defaults(), refreshMs: 10000 });
  cleanup.push(() => changed.close());
  expect(changed.at(1000)).toEqual(s);
  expect(changed.window(2000, 2000).map((p) => p.time)).toEqual([1000, 2000]);
  expect(changed.alerts(2000)).toEqual(s.alerts);
});
test("enabling persistence saves the history already held in memory", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  const h = new History(f.config);
  const now = Date.now();
  const s = emptySnapshot(now);
  h.add(s);
  const changed = h.reconfigure({ ...f.config, persistence: true });
  h.close();
  changed.close();
  const reopened = new History({ ...f.config, persistence: true });
  cleanup.push(() => reopened.close());
  expect(reopened.at(now)).toEqual(s);
});
test("expired snapshots cannot be replayed after a sampling gap", () => {
  const c = { ...defaults(), historyHours: 1 };
  const h = new History(c);
  cleanup.push(() => h.close());
  h.add(emptySnapshot(1000));
  h.add(emptySnapshot(7200000));
  expect(h.at(1000)).toBeNull();
  expect(h.at(7200000)?.time).toBe(7200000);
});
test("a destination database keeps its intervening samples when history is merged", async () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  const now = Date.now();
  const id = laneSnapshot().id;
  const laned = (time: number) => {
    const s = emptySnapshot(time);
    s.lanes = [laneSnapshot()];
    return s;
  };
  const target = new History({ ...f.config, persistence: true });
  target.add(laned(now + 1000));
  target.close();
  const source = new History(f.config);
  cleanup.push(() => source.close());
  source.add(laned(now));
  source.add(laned(now + 2000));
  const merged = source.reconfigure({ ...f.config, persistence: true });
  cleanup.push(() => merged.close());
  expect(merged.at(now + 1500)?.time).toBe(now + 1000);
  expect(merged.window(now + 2000, 3000).map((p) => p.time)).toEqual([
    now,
    now + 1000,
    now + 2000,
  ]);
  const series = (await merged.laneWindows([id], now + 2000, 3000)).get(id);
  expect(series?.map((sample) => sample.time)).toEqual([
    now,
    now + 1000,
    now + 2000,
  ]);
});
test("a different destination database keeps its pre-existing row in lane series", async () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  const now = Date.now();
  const id = laneSnapshot().id;
  const laned = (time: number) => {
    const s = emptySnapshot(time);
    s.lanes = [laneSnapshot()];
    return s;
  };
  const otherPath = f.config.sqlitePath.replace(/history\.db$/, "other.db");
  const target = new History({
    ...f.config,
    persistence: true,
    sqlitePath: otherPath,
  });
  target.add(laned(now + 1000));
  target.close();
  const source = new History({ ...f.config, persistence: true });
  cleanup.push(() => source.close());
  source.add(laned(now));
  source.add(laned(now + 2000));
  const merged = source.reconfigure({
    ...f.config,
    persistence: true,
    sqlitePath: otherPath,
  });
  cleanup.push(() => merged.close());
  expect(merged.window(now + 2000, 3000).map((p) => p.time)).toEqual([
    now,
    now + 1000,
    now + 2000,
  ]);
  const series = (await merged.laneWindows([id], now + 2000, 3000)).get(id);
  expect(series?.map((sample) => sample.time)).toEqual([
    now,
    now + 1000,
    now + 2000,
  ]);
});
test("a same-path reconfigure does not re-read the retained window from disk", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  const h = new History({ ...f.config, persistence: true });
  cleanup.push(() => h.close());
  const now = Date.now();
  for (let i = 0; i < 50; i++) h.add(emptySnapshot(now + i * 1000));
  const spy = spyOn(Bun, "gunzipSync");
  cleanup.push(() => spy.mockRestore());
  spy.mockClear();
  const changed = h.reconfigure({
    ...f.config,
    persistence: true,
    refreshMs: 2000,
  });
  cleanup.push(() => changed.close());
  expect(spy).not.toHaveBeenCalled();
  expect(changed.window(now + 49000, 60000)).toHaveLength(50);
});
test("persisted snapshots and their sidecars stay readable only by the owner", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const modes = () =>
    ["", "-wal", "-shm"]
      .map((suffix) => f.config.sqlitePath + suffix)
      .filter((path) => existsSync(path))
      .map((path) => statSync(path).mode & 0o777);
  const first = new History(f.config);
  first.add(emptySnapshot(Date.now()));
  expect(modes()).toEqual([0o600, 0o600, 0o600]);
  first.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = f.config.sqlitePath + suffix;
    if (existsSync(path)) chmodSync(path, 0o644);
  }
  const reopened = new History(f.config);
  cleanup.push(() => reopened.close());
  expect(modes()).toEqual(Array(modes().length).fill(0o600));
});

/**
 * Another dashboard, on its own thread, that takes the write lock on the
 * history database at `path` with a row of its own. It holds the lock until
 * this thread calls `start`, then for `holdMs` more on its own thread, or
 * until this thread calls `release`, and then commits. It waits on shared
 * memory rather than on a timer or a message, so how late either thread is
 * scheduled never shortens the hold.
 */
async function otherDashboard(
  root: string,
  path: string,
  time: number,
  holdMs: number,
) {
  const script = join(root, "other-dashboard.ts");
  writeFileSync(
    script,
    `import { Database } from "bun:sqlite";
declare const self: Worker;
self.onmessage = (event) => {
  const { path, snapshot, recorded, holdMs, signal } = event.data;
  const flags = new Int32Array(signal);
  const db = new Database(path);
  db.exec("BEGIN IMMEDIATE");
  db.query("INSERT INTO samples VALUES (?, ?, ?)").run(
    snapshot.time, Bun.gzipSync(JSON.stringify(snapshot)), JSON.stringify(recorded),
  );
  postMessage("locked");
  Atomics.wait(flags, 0, 0);
  Atomics.wait(flags, 1, 0, holdMs);
  db.exec("COMMIT");
  db.close();
  postMessage("released");
};
`,
  );
  const worker = new Worker(script);
  cleanup.push(() => worker.terminate());
  const next = () =>
    new Promise<string>((resolve) => {
      worker.addEventListener("message", (e) => resolve(e.data), {
        once: true,
      });
    });
  const flags = new Int32Array(new SharedArrayBuffer(8));
  const signal = (index: number) => {
    Atomics.store(flags, index, 1);
    Atomics.notify(flags, index);
  };
  const locked = next();
  const snapshot = emptySnapshot(time);
  worker.postMessage({
    path,
    snapshot,
    recorded: point(snapshot, defaults()),
    holdMs,
    signal: flags.buffer,
  });
  expect(await locked).toBe("locked");
  const released = next();
  return {
    start: () => signal(0),
    release: () => signal(1),
    released,
  };
}

/** A History on SQLite in its own scratch directory, with a connection that reads it back. */
function sharedHistory(busyTimeoutMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "vsys-history-lock-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = { ...defaults(), persistence: true };
  config.sqlitePath = join(root, "history.db");
  const h = new History(config, busyTimeoutMs);
  cleanup.push(() => h.close());
  const probe = new Database(config.sqlitePath);
  cleanup.push(() => probe.close());
  const stored = () =>
    probe
      .query<{ time: number }, []>("SELECT time FROM samples ORDER BY time")
      .all()
      .map((row) => row.time);
  return { root, path: config.sqlitePath, config, h, probe, stored };
}

// A margin for the rows below. Two start a worker thread, and one commits 132
// samples as synced SQLite transactions, the workload the lane-series suite
// records failing on time inside the full suite. A loaded host can stretch
// either past the runner's default; no row's verdict rests on the timeout.
const slowRowMs = 30_000;

/** The SQLite error code `run` throws, or null when it returns. */
function thrownCode(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : undefined;
  }
  return null;
}

test(
  "a write that overlaps another connection's write lock waits and succeeds",
  async () => {
    // This History waits ten seconds, so the other dashboard's thread commits
    // inside the wait however long a loaded host leaves it unscheduled.
    const { root, path, h, probe, stored } = sharedHistory(10_000);
    // The other dashboard's row is a second older than this one's, inside the
    // window, so this write's retention delete keeps it.
    const time = Date.now();
    // It keeps the lock 100 ms past `start`, far longer than this thread
    // takes from there to its own write, so the write meets the lock.
    const other = await otherDashboard(root, path, time - 1000, 100);
    // The lock is really held: a connection that does not wait is refused.
    expect(thrownCode(() => probe.exec("BEGIN IMMEDIATE"))).toBe("SQLITE_BUSY");
    other.start();
    expect(() => h.add(emptySnapshot(time))).not.toThrow();
    expect(await other.released).toBe("released");
    expect(stored()).toEqual([time - 1000, time]);
  },
  slowRowMs,
);

test(
  "a write that another connection's write lock outlasts fails within the dashboard's wait",
  async () => {
    const { root, path, h, stored } = sharedHistory();
    const time = Date.now();
    // The other dashboard keeps the lock for two seconds, forty times the
    // dashboard's wait, unless this thread releases it first. A write that
    // waits out the hold succeeds, so the refusal shows the wait ended inside
    // it; this thread releases the lock only once the write has returned.
    const other = await otherDashboard(root, path, time - 1000, 2000);
    other.start();
    // The wait is read on the real clock because SQLite's busy handler sleeps
    // through its VFS, which takes no injected clock. The floor is half the
    // dashboard's 50 ms wait: a write that never waits refuses at once and
    // falls under it, and a loaded host only lengthens a wait, never shortens it.
    const began = performance.now();
    expect(thrownCode(() => h.add(emptySnapshot(time)))).toBe("SQLITE_BUSY");
    expect(performance.now() - began).toBeGreaterThanOrEqual(25);
    other.release();
    expect(await other.released).toBe("released");
    expect(stored()).toEqual([time - 1000]);
  },
  slowRowMs,
);

test(
  "a lane read that yields leaves the next write free to wait for another dashboard",
  async () => {
    const { config, h: other, stored } = sharedHistory();
    const id = laneSnapshot().id;
    const sample = (time: number) => {
      const s = emptySnapshot(time);
      s.lanes = [laneSnapshot()];
      return s;
    };
    // More rows than one page of the stored pass, so the read yields with rows
    // still to read, and those rows are older than anything this dashboard
    // holds in memory, so the read takes them from the database.
    const first = Date.now() - 200_000;
    for (let i = 0; i < 130; i++) other.add(sample(first + i * 1000));
    const h = new History(config);
    cleanup.push(() => h.close());
    const last = first + 129_000;
    const sleep = spyOn(Bun, "sleep");
    cleanup.push(() => sleep.mockRestore());
    const read = h.laneWindows([id], last, 3_600_000);
    // The first page runs inside the call and ends at the read's yield, so the
    // read is out before the writes below and not merely unsettled.
    expect(sleep).toHaveBeenCalled();
    // The read is out, between two pages. The other dashboard commits, and
    // this one then writes its own sample on the connection the read uses.
    other.add(sample(last + 1000));
    expect(() => h.add(sample(last + 2000))).not.toThrow();
    expect((await read).get(id)).toHaveLength(130);
    expect(stored().slice(-2)).toEqual([last + 1000, last + 2000]);
  },
  slowRowMs,
);

test("reading recent history costs the same whether or not there is much to read", () => {
  const c = {
    ...defaults(),
    refreshMs: 100,
    historyHours: 24,
    persistence: false,
  };
  const held = 2000;
  /** One history of `held` points carrying `changes` lane starts. */
  const filled = (changes: number) => {
    const h = new History(c);
    // Lanes accumulate, so each marked sample is one lane start and nothing
    // stops: a lane that appeared and vanished would be two changes, not one.
    // The first sample records no change, so the marks start past it.
    const every = changes ? Math.floor(held / (changes + 1)) : held + 1;
    const lanes = [];
    for (let i = 0; i < held; i++) {
      const s = emptySnapshot(1000 + i * 100);
      if (changes && i > 0 && i % every === 0 && i / every <= changes)
        lanes.push(laneSnapshot({ id: `l${i}.scope`, name: `l${i}` }));
      s.lanes = [...lanes];
      h.add(s);
    }
    return h;
  };
  /**
   * Count what a read touches rather than how long it takes: a timing
   * assertion here would be a check that cannot fail.
   */
  const cost = (h: History, end: number) => {
    let materialised = 0;
    let touched = 0;
    const all = Ring.prototype.all;
    const get = Ring.prototype.get;
    Ring.prototype.all = function counted(this: Ring<unknown>) {
      const out = all.call(this);
      materialised += out.length;
      return out;
    };
    Ring.prototype.get = function counted(this: Ring<unknown>, index: number) {
      touched += 1;
      return get.call(this, index);
    };
    try {
      // What Home reads on every render, and what the alert count reads on
      // every sample.
      const recent = h.recentEvents(end, 3);
      const after = h.eventsAfter(end - 100, end);
      return { recent, after, materialised, touched };
    } finally {
      Ring.prototype.all = all;
      Ring.prototype.get = get;
    }
  };
  const now = 1000 + (held - 1) * 100;
  // None at all, fewer than Home asks for, then plenty. The sparse cases come
  // first because they are the ones a walk cannot cut short, and they are the
  // ordinary state of a quiet machine — which is what Home's own "nothing has
  // changed" message describes.
  for (const changes of [0, 2, 4]) {
    const { recent, after, materialised, touched } = cost(filled(changes), now);
    expect({ changes, found: recent.length }).toEqual({
      changes,
      found: Math.min(changes, 3),
    });
    expect({ changes, after }).toEqual({ changes, after: [] });
    // Nothing is copied out of the ring, and the reads cost a handful of
    // lookups rather than a pass over the retained window.
    expect({ changes, materialised }).toEqual({ changes, materialised: 0 });
    expect({ changes, bounded: touched < 20 }).toEqual({
      changes,
      bounded: true,
    });
  }
});

test("a change aged out by a push leaves the index with its point", () => {
  // A full ring whose oldest point is still retained grows rather than
  // wrapping, so the push evicts nothing. It evicts only once a sampling gap
  // has carried that point past the retention cutoff, which is when `push`
  // returns the casualty and is the case this covers.
  const c = {
    ...defaults(),
    refreshMs: 3600000,
    historyHours: 3,
    persistence: false,
  };
  const hours = 3600000;
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const running = emptySnapshot(2000);
  running.lanes = [laneSnapshot({ id: "l1.scope", name: "l1" })];
  h.add(running);
  h.add(emptySnapshot(3000));
  expect(h.recentEvents(3000, 3).map((e) => e.time)).toEqual([3000, 2000]);
  // The gap. The first push past it drops the oldest point, which carried no
  // change; the second drops the point that carried one.
  h.add(emptySnapshot(3 * hours + 2000));
  h.add(emptySnapshot(3 * hours + 3000));
  const indexed = h.recentEvents(3 * hours + 3000, 3);
  const walked = h.events(3 * hours + 3000, c.historyHours * hours);
  // A row Home offers has to be a row the Timeline can still land on, so the
  // index cannot hold a change whose point has gone.
  expect(indexed.some((e) => e.time === 2000)).toBe(false);
  expect(indexed).toEqual(walked.slice(0, 3));
});

test("a stored event is decoded only where the record proves it held a unit", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  f.config.persistence = true;
  const now = Date.now();
  const first = new History(f.config);
  const s = emptySnapshot(now);
  first.add(s);
  first.close();
  const unit = "agent-confine-854045-20986.scope";
  // Four records an older build could have written. The first is the case the
  // migration exists for. The rest are what a suffix cannot tell apart from
  // it: a lane named after a branch, a lane subject on an alert, and a mount.
  const events = [
    {
      time: now,
      kind: "alert-open",
      subject: unit,
      subjectId: `app.slice/${unit}`,
      cause: "desktop-swap",
      names: { level: "danger" },
      values: {},
    },
    {
      time: now,
      kind: "lane-start",
      subject: "release.scope",
      subjectId: "agents.slice/release.scope",
      cause: "",
      names: { account: "default", slice: "agents.slice", tool: "claude" },
      values: {},
    },
    {
      time: now,
      kind: "alert-open",
      subject: "release.scope",
      subjectId: "agents.slice/agent-claude-77.scope",
      cause: "stalls",
      names: { level: "warn" },
      values: {},
    },
    {
      time: now,
      kind: "alert-open",
      subject: "/mnt/cache.scope",
      subjectId: "/mnt/cache.scope",
      cause: "free-space",
      names: { level: "danger" },
      values: {},
    },
  ];
  // What the fixture has to hold, asserted before the load rather than assumed:
  // every subject ends in a unit suffix and not one carries a unit. A migration
  // reading the shape of the string sees four identical records here.
  expect(
    events.map((e) => {
      const names: Record<string, string | undefined> = e.names;
      return e.subject.endsWith(".scope") && names.unit === undefined;
    }),
  ).toEqual([true, true, true, true]);
  const db = new Database(f.config.sqlitePath);
  const row = db
    .query<{ point: string }, [number]>(
      "SELECT point FROM samples WHERE time = ?",
    )
    .get(now);
  const stored = {
    ...(JSON.parse(row?.point ?? "{}") as Record<string, unknown>),
    events,
  };
  db.query("UPDATE samples SET point = ? WHERE time = ?").run(
    JSON.stringify(stored),
    now,
  );
  db.close();
  const reopened = new History(f.config);
  cleanup.push(() => reopened.close());
  // Only the record whose subject is the last segment of its own cgroup path,
  // on a kind that carries a cgroup at all, is decoded. Rewriting either of
  // the lane records would rename a lane a reader chose the name of, and
  // rewriting the mount would rename a directory.
  expect(
    reopened
      .events(now, 3600000)
      .map((e) => `${e.subject} | ${e.names.unit ?? ""}`),
  ).toEqual([
    `agent 854045 | ${unit}`,
    "release.scope | ",
    "release.scope | ",
    "/mnt/cache.scope | ",
  ]);
});
