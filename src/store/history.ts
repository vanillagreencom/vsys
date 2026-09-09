import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config/config";
import type { Alert, Snapshot } from "../model/types";
import { Archive } from "./archive";
import type { LaneSample } from "./lane-series";
import { normalizeSnapshot } from "./migrate";
import { type Point, point } from "./point";

/** Snapshots hold command lines and environment values, so only the owner may read them. */
function restrict(sqlitePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const path = sqlitePath + suffix;
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}

interface CachedLane {
  start: number;
  through: number;
  samples: LaneSample[];
  cancelled: boolean;
}

/** Fixed-capacity ring replaces its oldest element without shifting the array. */
export class Ring<T> {
  private values: (T | undefined)[];
  private head = 0;
  size = 0;
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0)
      throw new Error("Ring capacity must be a positive integer");
    this.values = new Array(capacity);
  }
  push(value: T): T | undefined {
    const old = this.values[this.head];
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
    return old;
  }
  all(): T[] {
    return Array.from({ length: this.size }, (_, i) => this.get(i) as T);
  }
  get(index: number): T | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.size)
      return undefined;
    return this.values[
      (this.head - this.size + index + this.capacity) % this.capacity
    ];
  }
  shift(): T | undefined {
    if (!this.size) return undefined;
    const index = (this.head - this.size + this.capacity) % this.capacity;
    const value = this.values[index];
    this.values[index] = undefined;
    this.size--;
    return value;
  }
}

/** Compressed samples preserve historical process identity and metadata. */
export class History {
  private archive = new Archive();
  private points: Ring<Point>;
  private db?: Database;
  private laneCache = new Map<string, CachedLane>();
  private laneLoads = new Map<string, Promise<void>>();
  get retentionWarning(): string | null {
    return this.archive.shortened && !this.db
      ? "Process replay reached the memory limit. Enable SQLite to retain the full history window."
      : null;
  }
  constructor(private c: Config) {
    const capacity = Math.ceil((c.historyHours * 3600000) / c.refreshMs);
    this.points = new Ring(capacity);
    if (c.persistence) {
      mkdirSync(dirname(c.sqlitePath), { recursive: true });
      const fresh = !existsSync(c.sqlitePath);
      this.db = new Database(c.sqlitePath, { create: true, strict: true });
      try {
        if (fresh) restrict(c.sqlitePath);
        const application = this.db
          .query<{ application_id: number }, []>("PRAGMA application_id")
          .get()?.application_id;
        const version = this.db
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get()?.user_version;
        const schema = this.db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master")
          .all();
        if (application === 0 && version === 0 && schema.length === 0) {
          this.db.exec(
            "BEGIN; PRAGMA application_id=0x56535953; PRAGMA user_version=1; CREATE TABLE samples (time INTEGER PRIMARY KEY, data BLOB NOT NULL, point TEXT NOT NULL); COMMIT",
          );
        } else if (application !== 0x56535953 || version !== 1) {
          throw new Error(
            "SQLite path is not a supported vsys-view history database",
          );
        }
        this.db.exec("PRAGMA journal_mode=WAL");
        restrict(c.sqlitePath);
        const cutoff = Date.now() - c.historyHours * 3600000;
        const rows = this.db
          .query<{ point: string }, [number]>(
            "SELECT point FROM samples WHERE time >= ? ORDER BY time",
          )
          .all(cutoff);
        if (rows.length > this.points.capacity)
          this.points = new Ring(rows.length);
        for (const row of rows)
          this.points.push(JSON.parse(row.point) as Point);
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
  }
  add(s: Snapshot): void {
    const p = point(s, this.c);
    const json = JSON.stringify(s);
    const cutoff = s.time - this.c.historyHours * 3600000;
    this.archive.prune(cutoff);
    this.archive.add(s.time, json);
    if (this.db) {
      const data = Bun.gzipSync(json);
      this.db.transaction(() => {
        this.db
          ?.query("INSERT OR REPLACE INTO samples VALUES (?, ?, ?)")
          .run(s.time, data, JSON.stringify(p));
        this.db
          ?.query("DELETE FROM samples WHERE time < ?")
          .run(s.time - this.c.historyHours * 3600000);
      })();
    }
    if (
      this.points.size === this.points.capacity &&
      (this.points.get(0)?.time ?? 0) >= cutoff
    ) {
      const expanded = new Ring<Point>(this.points.capacity * 2);
      for (const point of this.points.all()) expanded.push(point);
      this.points = expanded;
    }
    this.points.push(p);
    while ((this.points.get(0)?.time ?? cutoff) < cutoff) this.points.shift();
  }
  /** Copy retained evidence before the scheduler commits new settings. */
  reconfigure(c: Config): History {
    const next = new History(c);
    try {
      const end = Math.max(
        this.points.get(this.points.size - 1)?.time ?? 0,
        next.points.get(next.points.size - 1)?.time ?? 0,
      );
      const cutoff = end - c.historyHours * 3600000;
      const points = new Map(
        [...next.points.all(), ...this.points.all()]
          .filter((p) => p.time >= cutoff)
          .map((p) => [p.time, p]),
      );
      const capacity = Math.max(next.points.capacity, points.size);
      next.points = new Ring(capacity);
      next.archive = this.archive.copy(cutoff);
      for (const p of [...points.values()].sort((a, b) => a.time - b.time))
        next.points.push(p);
      const copy = (row: { time: number; data: Uint8Array; point: string }) => {
        if (next.db && (!this.db || c.sqlitePath !== this.c.sqlitePath))
          next.db
            .query("INSERT OR REPLACE INTO samples VALUES (?, ?, ?)")
            .run(row.time, row.data, row.point);
        if (!next.db)
          next.archive.add(
            row.time,
            new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(row.data))),
          );
      };
      if (this.db && (!next.db || c.sqlitePath !== this.c.sqlitePath)) {
        if (!next.db) next.archive = new Archive();
        const transfer = () => {
          for (const row of this.db
            ?.query<
              { time: number; data: Uint8Array; point: string },
              [number]
            >(
              "SELECT time, data, point FROM samples WHERE time >= ? ORDER BY time",
            )
            .iterate(cutoff) ?? [])
            copy(row);
        };
        if (next.db && c.sqlitePath !== this.c.sqlitePath)
          next.db.transaction(transfer)();
        else transfer();
      } else if (!this.db && next.db) {
        const transfer = () => {
          for (const row of this.archive.rows(cutoff)) {
            const p = points.get(row.time);
            if (!p) throw new Error("Retained snapshot has no timeline point");
            copy({
              time: row.time,
              data: Bun.gzipSync(row.json),
              point: JSON.stringify(p),
            });
          }
        };
        if (next.db) next.db.transaction(transfer)();
        else transfer();
      }
      return next;
    } catch (error) {
      next.close();
      throw error;
    }
  }
  /** Display and rule preferences affect new points without discarding old ones. */
  configure(c: Config): void {
    this.c = c;
  }
  window(end: number, durationMs: number): Point[] {
    return this.points
      .all()
      .filter((p) => p.time <= end && p.time >= end - durationMs);
  }
  at(time: number): Snapshot | null {
    const cutoff =
      (this.points.get(this.points.size - 1)?.time ?? Date.now()) -
      this.c.historyHours * 3600000;
    if (time < cutoff) return null;
    const cached = this.archive.at(time);
    const row = this.db
      ?.query<{ time: number; data: Uint8Array }, [number, number]>(
        "SELECT time, data FROM samples WHERE time <= ? AND time >= ? ORDER BY time DESC LIMIT 1",
      )
      .get(time, cutoff);
    if (cached && cached.time >= cutoff && (!row || cached.time >= row.time))
      return normalizeSnapshot(cached);
    const data = row?.data;
    // Rows an older build wrote lack the fields this build reads.
    return data
      ? normalizeSnapshot(
          JSON.parse(
            new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(data))),
          ) as Snapshot,
        )
      : null;
  }
  alerts(end: number): Alert[] {
    return this.window(end, this.c.historyHours * 3600000).flatMap(
      (p) => p.alerts,
    );
  }
  /** Older persisted rows load cooperatively; the live archive supplies new rows. */
  async laneWindow(
    id: string,
    end: number,
    durationMs: number,
  ): Promise<LaneSample[]> {
    const pending = this.laneLoads.get(id);
    if (pending) {
      await pending;
      return this.laneWindow(id, end, durationMs);
    }
    const start = Math.max(
      end - durationMs,
      (this.points.get(this.points.size - 1)?.time ?? end) -
        this.c.historyHours * 3600000,
    );
    const fromMemory = this.archive.laneWindow(id, start, end);
    const diskEnd = Math.min(end, (this.archive.firstTime ?? end + 1) - 1);
    const db = this.db;
    if (!db || diskEnd < start) return fromMemory;
    let cached = this.laneCache.get(id);
    if (!cached || cached.start > start) {
      if (this.laneCache.size >= 2) {
        const oldest = this.laneCache.keys().next().value;
        if (oldest !== undefined) {
          const old = this.laneCache.get(oldest);
          if (old) old.cancelled = true;
          this.laneCache.delete(oldest);
        }
      }
      cached = { start, through: start - 1, samples: [], cancelled: false };
      this.laneCache.set(id, cached);
    }
    if (cached.through < diskEnd) {
      const target = cached;
      const load = async () => {
        const rows = db
          .query<{ time: number; data: Uint8Array }, [number, number]>(
            "SELECT time, data FROM samples WHERE time >= ? AND time <= ? ORDER BY time",
          )
          .iterate(Math.max(start, target.through + 1), diskEnd);
        let count = 0;
        for (const row of rows) {
          if (target.cancelled) return;
          const s = JSON.parse(
            new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(row.data))),
          ) as Snapshot;
          const lane = s.lanes.find((l) => l.id === id);
          const group = s.groups.find((g) => g.path === id);
          target.samples.push({
            time: row.time,
            cpu: lane?.cpu ?? null,
            rss: lane?.rss ?? null,
            pressure: group?.pressure.cpu?.some ?? lane?.pressure ?? null,
            memoryPressure:
              group?.pressure.memory?.some ?? lane?.memoryPressure ?? null,
            ioPressure: group?.pressure.io?.some ?? lane?.ioPressure ?? null,
          });
          target.through = row.time;
          if (++count % 64 === 0) await Bun.sleep(0);
        }
        target.through = diskEnd;
      };
      const job = load();
      this.laneLoads.set(id, job);
      try {
        await job;
      } finally {
        this.laneLoads.delete(id);
      }
    }
    return [
      ...cached.samples.filter((s) => s.time >= start && s.time <= diskEnd),
      ...fromMemory,
    ];
  }
  close(): void {
    for (const cached of this.laneCache.values()) cached.cancelled = true;
    this.db?.close();
  }
}
