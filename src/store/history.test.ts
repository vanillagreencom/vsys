import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, statSync } from "node:fs";
import { defaults } from "../config/config";
import { emptySnapshot, fixture, laneSnapshot } from "../test/fixture";
import { History, Ring } from "./history";

const cleanup: (() => void)[] = [];
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
  expect(lane?.builds).toEqual({});
  expect([lane?.memoryMaxKnown, lane?.blocked, lane?.blockedOn]).toEqual([
    false,
    0,
    null,
  ]);
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
