import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config/config";
import { memberless } from "../model/lanes";
import type { Alert, Snapshot } from "../model/types";
import { Archive } from "./archive";
import { EventLog, type TimelineEvent } from "./events";
import type { LaneSample } from "./lane-series";
import { normalizePoint, normalizeSnapshot } from "./migrate";
import { type Point, point } from "./point";

/** Snapshots hold command lines and environment values, so only the owner may read them. */
function restrict(sqlitePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const path = sqlitePath + suffix;
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}

/**
 * How long a history write waits for another connection's write lock before
 * failing. Two dashboards may share one database, and write-ahead logging lets
 * only one of them write at a time. The wait runs on the dashboard thread and
 * adds to the history write budget rather than fitting inside it:
 * docs/architecture/history.md states the choice and what it costs a refresh.
 */
const BUSY_TIMEOUT_MS = 50;

/**
 * Lane series read back from SQLite. Every lane it holds has a sample for each
 * stored row from `start` through `through`, so one pass over the rows past
 * `through` brings all of them up to date at once.
 */
interface StoredLanes {
  start: number;
  through: number;
  lanes: Map<string, LaneSample[]>;
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

/**
 * The retained points, and the newest changes among them kept as they arrive.
 *
 * Finding the newest few by scanning stops early only when there are enough to
 * find. A quiet machine holds fewer changes than a screen asks for, and there
 * the scan reaches the oldest retained point every time — at a hundred
 * milliseconds over a day that is 864,000 reads per render, on the machine
 * least likely to have anyone watching for the cause.
 *
 * Eviction is oldest first, so every change outside the index is older than
 * every change in it and can never be promoted into it. Dropping an evicted
 * point's changes is the whole of what eviction has to do, and no path here
 * ever rescans.
 */
class Points {
  /** Headroom over what any screen asks for, so the index answers every call. */
  static readonly indexed = 8;
  private ring: Ring<Point>;
  private newest: TimelineEvent[] = [];
  constructor(capacity: number) {
    this.ring = new Ring(capacity);
  }
  get size(): number {
    return this.ring.size;
  }
  get capacity(): number {
    return this.ring.capacity;
  }
  get(index: number): Point | undefined {
    return this.ring.get(index);
  }
  all(): Point[] {
    return this.ring.all();
  }
  push(p: Point): void {
    // A full ring evicts its oldest point on a push and hands it back. That is
    // the same eviction `shift` performs and it drops the same changes, so
    // both go through `drop`: keeping an evicted point's change in the index
    // put a change outside retention on Home, where opening it landed on no
    // Timeline row at all.
    const evicted = this.ring.push(p);
    const events = p.events ?? [];
    if (events.length)
      // Newest point first, and a point's own changes in the order it recorded
      // them, which is the order every reader of this list already expects.
      this.newest = [...events, ...this.newest].slice(0, Points.indexed);
    this.drop(evicted);
  }
  shift(): Point | undefined {
    const gone = this.ring.shift();
    this.drop(gone);
    return gone;
  }
  /** A point has left retention, so the changes it carried leave the index. */
  private drop(gone: Point | undefined): void {
    if (gone?.events?.length)
      this.newest = this.newest.filter((e) => e.time !== gone.time);
  }
  /**
   * The newest changes at or before `end`, newest first. The index answers
   * whenever `end` is at or past the newest retained point, which is what a
   * live screen asks; an older `end` is a historical read and walks.
   */
  recent(end: number, limit: number): TimelineEvent[] {
    if (limit <= 0) return [];
    const latest = this.ring.get(this.ring.size - 1)?.time;
    if (limit <= Points.indexed && latest !== undefined && end >= latest)
      return this.newest.slice(0, limit);
    const out: TimelineEvent[] = [];
    for (let i = this.ring.size - 1; i >= 0 && out.length < limit; i--) {
      const p = this.ring.get(i);
      if (!p || p.time > end) continue;
      for (const event of p.events ?? []) {
        out.push(event);
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}

/** Compressed samples preserve historical process identity and metadata. */
export class History {
  private archive = new Archive();
  private eventLog = new EventLog();
  private points: Points;
  private db?: Database;
  private stored?: StoredLanes;
  /** The one pass over stored rows in flight; a second waits rather than repeating it. */
  private storedLoad?: Promise<void>;
  /** Set by `close`, so a stored pass still out stops before the next row. */
  private closed = false;
  get retentionWarning(): string | null {
    return this.archive.shortened && !this.db
      ? "Process replay reached the memory limit. Enable SQLite to retain the full history window."
      : null;
  }
  /**
   * `busyTimeoutMs` is how long a write waits for another connection's write
   * lock. The dashboard always takes the default; a caller passes another
   * value only to stage that wait without racing it.
   */
  constructor(
    private c: Config,
    private busyTimeoutMs = BUSY_TIMEOUT_MS,
  ) {
    const capacity = Math.ceil((c.historyHours * 3600000) / c.refreshMs);
    this.points = new Points(capacity);
    if (c.persistence) {
      mkdirSync(dirname(c.sqlitePath), { recursive: true });
      const fresh = !existsSync(c.sqlitePath);
      this.db = new Database(c.sqlitePath, { create: true, strict: true });
      try {
        this.db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
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
            "SQLite path is not a supported vsys history database",
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
          this.points = new Points(rows.length);
        // A stored point was written by whichever build was running then, so
        // it reaches the ring through the same normalising step a stored
        // snapshot does.
        for (const row of rows)
          this.points.push(normalizePoint(JSON.parse(row.point) as Point));
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
  }
  add(s: Snapshot): void {
    // A clock stepped back, or a restart behind the newest stored row, hands
    // over a sample at or before one already kept. It is not stored: a stored
    // time stays the clock's reading when the sample was taken, so the gap
    // until the clock passes the newest stored time is a gap and never a
    // wrong time.
    const newest = this.points.get(this.points.size - 1)?.time;
    if (newest !== undefined && s.time <= newest) return;
    const p = point(s, this.c, this.eventLog.advance(s, this.c));
    const json = JSON.stringify(s);
    const cutoff = s.time - this.c.historyHours * 3600000;
    this.archive.prune(cutoff);
    this.archive.add(s.time, json);
    // A stored series is kept only while its lane lives, for the reason the
    // archive keeps its projections that long.
    if (this.stored?.lanes.size) {
      const live = new Set(s.lanes.map((lane) => lane.id));
      for (const id of this.stored.lanes.keys())
        if (!live.has(id)) this.stored.lanes.delete(id);
    }
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
      const expanded = new Points(this.points.capacity * 2);
      for (const point of this.points.all()) expanded.push(point);
      this.points = expanded;
    }
    this.points.push(p);
    while ((this.points.get(0)?.time ?? cutoff) < cutoff) this.points.shift();
  }
  /** Copy retained evidence before the scheduler commits new settings. */
  reconfigure(c: Config): History {
    const next = new History(c, this.busyTimeoutMs);
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
      next.points = new Points(capacity);
      // A database that is neither new nor swapped for another already
      // agrees with the source archive, so copying it forward is enough;
      // the rebuild below replaces this whole copy wherever `next.db` can
      // hold rows the source never had, and doing both would decompress a
      // full retained window on every plain settings change.
      const rebuildsFromDb =
        next.db !== undefined &&
        (this.db === undefined || c.sqlitePath !== this.c.sqlitePath);
      if (!rebuildsFromDb) next.archive = this.archive.copy(cutoff);
      // Derivation continues across a settings change, so an alert that opened
      // before it still closes with its full duration.
      next.eventLog = this.eventLog;
      for (const p of [...points.values()].sort((a, b) => a.time - b.time))
        next.points.push(p);
      const copy = (row: { time: number; data: Uint8Array; point: string }) => {
        if (next.db && (!this.db || c.sqlitePath !== this.c.sqlitePath))
          next.db
            .query("INSERT OR REPLACE INTO samples VALUES (?, ?, ?)")
            .run(row.time, row.data, row.point);
        if (!next.db) next.archive.add(row.time, History.decodeRow(row.data));
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
      // A copied source archive carries only what the source held, so a
      // destination that already had its own rows would leave them out of
      // the archive while `next.db` kept them — the gap `laneWindows` cannot
      // see, because it trusts the archive to be complete from its first
      // time onward. Rebuilding from `next.db` itself, now that the transfer
      // above has settled its final content, keeps that promise.
      if (next.db && rebuildsFromDb)
        next.archive = History.loadArchive(next.db, cutoff);
      return next;
    } catch (error) {
      next.close();
      throw error;
    }
  }
  /** One snapshot's JSON, inflated from the compressed blob a row stores it as. */
  private static decodeRow(data: Uint8Array): string {
    return new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(data)));
  }
  /** The archive built from a database's own rows, so the two agree on coverage. */
  private static loadArchive(db: Database, cutoff: number): Archive {
    const archive = new Archive();
    for (const row of db
      .query<{ time: number; data: Uint8Array }, [number]>(
        "SELECT time, data FROM samples WHERE time >= ? ORDER BY time",
      )
      .iterate(cutoff))
      archive.add(row.time, History.decodeRow(row.data));
    return archive;
  }
  /** Display and rule preferences affect new points without discarding old ones. */
  configure(c: Config): void {
    this.c = c;
  }
  /**
   * Points in a window, oldest first. The walk starts at the newest and stops
   * when it leaves the window, so it touches the points in that window rather
   * than materialising every retained point and filtering. At a hundred
   * milliseconds over a day the ring holds 864,000 of them, and this is read
   * on every sample by every screen that charts anything.
   */
  window(end: number, durationMs: number): Point[] {
    const out: Point[] = [];
    for (let i = this.points.size - 1; i >= 0; i--) {
      const p = this.points.get(i);
      if (!p || p.time > end) continue;
      if (p.time < end - durationMs) break;
      out.push(p);
    }
    return out.reverse();
  }
  /**
   * Changes newer than `since`, newest first. The walk stops at the first
   * point that is not, so a caller asking on every sample touches the points
   * that arrived since it last asked rather than the whole retained window.
   */
  eventsAfter(since: number, end: number): TimelineEvent[] {
    const out: TimelineEvent[] = [];
    for (let i = this.points.size - 1; i >= 0; i--) {
      const p = this.points.get(i);
      if (!p || p.time > end) continue;
      if (p.time <= since) break;
      out.push(...(p.events ?? []));
    }
    return out;
  }
  /**
   * The newest changes, newest first, stopping as soon as `limit` are found.
   * Home shows three, and finding them costs neither a scan nor a copy: the
   * index behind this is kept as points arrive.
   */
  recentEvents(end: number, limit: number): TimelineEvent[] {
    return this.points.recent(end, limit);
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
      ? normalizeSnapshot(JSON.parse(History.decodeRow(data)) as Snapshot)
      : null;
  }
  /** Recorded changes in the window, newest first. */
  events(end: number, durationMs: number): TimelineEvent[] {
    // Rows persisted before events existed carry none.
    return [...this.window(end, durationMs)]
      .reverse()
      .flatMap((p) => p.events ?? []);
  }
  alerts(end: number): Alert[] {
    return this.window(end, this.c.historyHours * 3600000).flatMap(
      (p) => p.alerts,
    );
  }
  /**
   * Lane series for every id in one read. Older persisted rows load
   * cooperatively and the live archive supplies new rows; either way a row is
   * decompressed once for all the lanes asked for, not once per lane.
   */
  async laneWindows(
    ids: readonly string[],
    end: number,
    durationMs: number,
  ): Promise<Map<string, LaneSample[]>> {
    for (;;) {
      const start = Math.max(
        end - durationMs,
        (this.points.get(this.points.size - 1)?.time ?? end) -
          this.c.historyHours * 3600000,
      );
      const diskEnd = Math.min(end, (this.archive.firstTime ?? end + 1) - 1);
      const db = this.db;
      if (!db || diskEnd < start) {
        // The window no longer reaches a stored row, so the stored series
        // answer nothing; a longer window that does reach them reads them again.
        if (!this.storedLoad) this.stored = undefined;
        return this.archive.laneWindows(ids, start, end);
      }
      // One pass at a time: a second read waiting on the first finds the lanes
      // it shares already read, where two passes would decompress every row
      // twice. The window is worked out again after the wait, because samples
      // may have moved the archive's first row meanwhile.
      if (this.storedLoad) {
        await this.storedLoad;
        continue;
      }
      return await this.readStored(db, [...new Set(ids)], start, end, diskEnd);
    }
  }
  private async readStored(
    db: Database,
    ids: string[],
    start: number,
    end: number,
    diskEnd: number,
  ): Promise<Map<string, LaneSample[]>> {
    // Read before the pass: samples landing while it is out can move the
    // archive's first row past `diskEnd`, and the rows between would be lost.
    const fromMemory = this.archive.laneWindows(ids, start, end);
    // The held span grows to meet a read that touches or adjoins it. A read
    // clear of it on either side would need every row in the gap, so it starts
    // over instead.
    const kept = this.stored;
    const reuse =
      kept !== undefined &&
      start <= kept.through + 1 &&
      diskEnd >= kept.start - 1;
    const held = reuse ? kept.lanes : new Map<string, LaneSample[]>();
    const heldStart = reuse ? kept.start : start;
    const heldThrough = reuse ? kept.through : start - 1;
    const added = ids.filter((id) => !held.has(id));
    // Rows before the window are let go once they outnumber the rows inside
    // it, or when a lane is added and the span is walked anyway. Trimming on
    // every read would move every held series each time one lane is read.
    const trim =
      heldStart < start &&
      (added.length > 0 || start - heldStart > heldThrough - start);
    const spanStart = trim ? start : heldStart;
    const spanThrough = Math.max(heldThrough, spanStart - 1);
    const every = [...added, ...held.keys()];
    // A lane new to the cache needs every row of the span. The lanes already
    // held need only the rows the span grows by, before it and after it, so
    // each row is decompressed once for all of them.
    const before = new Map<string, LaneSample[]>();
    const after = new Map<string, LaneSample[]>();
    const passes: {
      from: number;
      to: number;
      lanes: string[];
      into: Map<string, LaneSample[]>;
    }[] = [];
    if (start < spanStart)
      passes.push({
        from: start,
        to: spanStart - 1,
        lanes: every,
        into: before,
      });
    if (added.length && spanStart <= spanThrough)
      passes.push({
        from: spanStart,
        to: spanThrough,
        lanes: added,
        into: after,
      });
    if (diskEnd > spanThrough)
      passes.push({
        from: spanThrough + 1,
        to: diskEnd,
        lanes: every,
        into: after,
      });
    // The held series this read answers from, taken before the pass: a lane
    // that ends while the pass is out leaves the cache, and its series is still
    // the answer to this read.
    const prior = new Map(
      ids.map((id): [string, LaneSample[]] => [id, held.get(id) ?? []]),
    );
    if (passes.length) {
      // The pass reads a page of rows at a time and yields only between pages,
      // when no statement is open. A statement left open across a yield would
      // keep its read snapshot, and a sample written on this connection during
      // the yield, after another dashboard has committed, would then fail at
      // once with `database is locked`, without waiting.
      const page = 64;
      const load = async () => {
        for (const pass of passes) {
          const lists = pass.lanes.map((id): [string, LaneSample[]] => {
            const list = pass.into.get(id) ?? [];
            pass.into.set(id, list);
            return [id, list];
          });
          let after = pass.from - 1;
          for (;;) {
            if (this.closed)
              throw new Error("History closed while a lane read was out");
            const rows = db
              .query<
                { time: number; data: Uint8Array },
                [number, number, number]
              >(
                "SELECT time, data FROM samples WHERE time > ? AND time <= ? ORDER BY time LIMIT ?",
              )
              .all(after, pass.to, page);
            for (const row of rows) {
              const s = JSON.parse(History.decodeRow(row.data)) as Snapshot;
              const lanes = new Map(s.lanes.map((l) => [l.id, l]));
              const groups = new Map(s.groups.map((g) => [g.path, g]));
              for (const [id, samples] of lists) {
                const lane = lanes.get(id);
                const group = groups.get(id);
                samples.push({
                  time: row.time,
                  cpu: lane?.cpu ?? null,
                  rss:
                    lane === undefined || memberless(lane.mainPid)
                      ? null
                      : (lane.rss ?? null),
                  pressure: group?.pressure.cpu?.some ?? lane?.pressure ?? null,
                  memoryPressure:
                    group?.pressure.memory?.some ??
                    lane?.memoryPressure ??
                    null,
                  ioPressure:
                    group?.pressure.io?.some ?? lane?.ioPressure ?? null,
                });
              }
            }
            const last = rows.at(-1);
            if (!last || rows.length < page) break;
            after = last.time;
            await Bun.sleep(0);
          }
        }
      };
      const job = load();
      this.storedLoad = job;
      try {
        await job;
      } finally {
        this.storedLoad = undefined;
      }
    }
    const inside = (samples: LaneSample[]) =>
      samples.filter((s) => s.time >= start && s.time <= diskEnd);
    const answer = new Map(
      ids.map((id): [string, LaneSample[]] => {
        const recent = fromMemory.get(id);
        if (!recent)
          throw new Error(
            "The archive answered without a lane it was asked for",
          );
        return [
          id,
          [
            ...inside(before.get(id) ?? []),
            ...inside(prior.get(id) ?? []),
            ...inside(after.get(id) ?? []),
            ...recent,
          ],
        ];
      }),
    );
    // Nothing above wrote to the cache, so a pass that failed or was stopped
    // left it as it was. From here every pass has finished, and a held lane
    // that gained no rows is not touched.
    if (!passes.length && !trim) return answer;
    const stored: StoredLanes = reuse
      ? kept
      : { start, through: start - 1, lanes: held };
    this.stored = stored;
    if (trim)
      for (const samples of stored.lanes.values()) {
        const first = samples.findIndex((s) => s.time >= start);
        samples.splice(0, first < 0 ? samples.length : first);
      }
    for (const id of held.keys()) {
      const samples = stored.lanes.get(id);
      // A held lane that ended while the pass was out stays out.
      if (!samples) continue;
      const earlier = before.get(id) ?? [];
      const later = after.get(id) ?? [];
      if (earlier.length) stored.lanes.set(id, earlier.concat(samples, later));
      else for (const sample of later) samples.push(sample);
    }
    for (const id of added)
      stored.lanes.set(id, [
        ...(before.get(id) ?? []),
        ...(after.get(id) ?? []),
      ]);
    stored.start = Math.min(spanStart, start);
    stored.through = Math.max(spanThrough, diskEnd);
    return answer;
  }
  close(): void {
    this.closed = true;
    this.db?.close();
  }
}
