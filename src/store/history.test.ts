import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, statSync } from "node:fs";
import { defaults } from "../config/config";
import { emptySnapshot, fixture } from "../test/fixture";
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
test("a destination database keeps its intervening samples when history is merged", () => {
  const f = fixture();
  cleanup.push(f.cleanup);
  const now = Date.now();
  const target = new History({ ...f.config, persistence: true });
  target.add(emptySnapshot(now + 1000));
  target.close();
  const source = new History(f.config);
  cleanup.push(() => source.close());
  source.add(emptySnapshot(now));
  source.add(emptySnapshot(now + 2000));
  const merged = source.reconfigure({ ...f.config, persistence: true });
  cleanup.push(() => merged.close());
  expect(merged.at(now + 1500)?.time).toBe(now + 1000);
  expect(merged.window(now + 2000, 3000).map((p) => p.time)).toEqual([
    now,
    now + 1000,
    now + 2000,
  ]);
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
