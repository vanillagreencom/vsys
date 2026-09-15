import type { Snapshot } from "../model/types";
import type { LaneSample } from "./lane-series";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type Change =
  | { kind: "replace"; value: Json }
  | { kind: "add"; value: number }
  | { kind: "shift"; value: number; entries?: [number, number][] }
  | { kind: "array"; length: number; entries: [number, Change][] }
  | { kind: "object"; entries: [string, Change][]; removed: string[] };

function object(value: Json): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Column layout lets clocks and counters share one exact delta across rows. */
function encode(json: string): ObjectValue {
  const value = JSON.parse(json) as ObjectValue;
  for (const key of ["procs", "groups", "lanes"]) {
    const rows = value[key];
    if (!Array.isArray(rows) || !rows.every(object))
      throw new Error(`Invalid snapshot table: ${key}`);
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    value[key] = {
      length: rows.length,
      columns: Object.fromEntries(
        keys.map((field) => [field, rows.map((row) => row[field] ?? null)]),
      ),
      missing: Object.fromEntries(
        keys.flatMap((field) => {
          const indices = rows.flatMap((row, i) =>
            Object.hasOwn(row, field) ? [] : [i],
          );
          return indices.length ? [[field, indices]] : [];
        }),
      ),
    };
  }
  return value;
}

function decode(encoded: Json): Snapshot {
  // Callers can edit an exported snapshot without changing the replay cache.
  const value = structuredClone(encoded) as ObjectValue;
  for (const key of ["procs", "groups", "lanes"]) {
    const table = value[key];
    if (
      !object(table) ||
      !object(table.columns) ||
      !object(table.missing) ||
      typeof table.length !== "number"
    )
      throw new Error(`Invalid archived table: ${key}`);
    const columns = Object.entries(table.columns);
    const missing = new Map(
      Object.entries(table.missing).map(([field, indices]) => [
        field,
        new Set(indices as number[]),
      ]),
    );
    value[key] = Array.from({ length: table.length }, (_, i) =>
      Object.fromEntries(
        columns.flatMap(([field, values]) =>
          missing.get(field)?.has(i) ? [] : [[field, (values as Json[])[i]]],
        ),
      ),
    );
  }
  return value as unknown as Snapshot;
}

function difference(before: Json | undefined, after: Json): Change | undefined {
  if (before === after) return undefined;
  if (typeof before === "number" && typeof after === "number") {
    const delta = after - before;
    if (Number.isFinite(delta) && before + delta === after)
      return { kind: "add", value: delta };
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (
      before.length === after.length &&
      typeof before[0] === "number" &&
      typeof after[0] === "number"
    ) {
      for (const index of [0, Math.floor(after.length / 2)]) {
        if (
          typeof before[index] !== "number" ||
          typeof after[index] !== "number"
        )
          continue;
        const delta = (after[index] as number) - (before[index] as number);
        if (!Number.isFinite(delta)) continue;
        const entries: [number, number][] = [];
        let numeric = true;
        for (let i = 0; i < after.length; i++) {
          if (typeof before[i] !== "number" || typeof after[i] !== "number") {
            numeric = false;
            break;
          }
          if ((before[i] as number) + delta !== after[i])
            entries.push([i, after[i] as number]);
        }
        if (numeric && entries.length === 0)
          return delta === 0 ? undefined : { kind: "shift", value: delta };
        if (numeric && entries.length < after.length / 2)
          return { kind: "shift", value: delta, entries };
      }
    }
    const entries: [number, Change][] = [];
    for (let i = 0; i < after.length; i++) {
      const change = difference(before[i], after[i]);
      if (change) entries.push([i, change]);
    }
    return entries.length || before.length !== after.length
      ? { kind: "array", length: after.length, entries }
      : undefined;
  }
  if (before !== undefined && object(before) && object(after)) {
    const entries: [string, Change][] = [];
    for (const [key, value] of Object.entries(after)) {
      const change = difference(before[key], value);
      if (change) entries.push([key, change]);
    }
    const removed = Object.keys(before).filter(
      (key) => !Object.hasOwn(after, key),
    );
    return entries.length || removed.length
      ? { kind: "object", entries, removed }
      : undefined;
  }
  return { kind: "replace", value: after };
}

function apply(before: Json | undefined, change: Change): Json {
  switch (change.kind) {
    case "replace":
      return change.value;
    case "add": {
      if (typeof before !== "number")
        throw new Error("Archive numeric delta has no base");
      return before + change.value;
    }
    case "shift": {
      if (!Array.isArray(before) || !before.every((n) => typeof n === "number"))
        throw new Error("Archive vector delta has no base");
      const result = before.map((n) => (n as number) + change.value);
      for (const [index, value] of change.entries ?? []) result[index] = value;
      return result;
    }
    case "array": {
      if (!Array.isArray(before))
        throw new Error("Archive array delta has no base");
      const result = before.slice(0, change.length);
      result.length = change.length;
      for (const [index, value] of change.entries)
        result[index] = apply(before[index], value);
      return result;
    }
    case "object": {
      if (before === undefined || !object(before))
        throw new Error("Archive object delta has no base");
      const result = Object.fromEntries(
        Object.entries(before).filter(([key]) => !change.removed.includes(key)),
      );
      for (const [key, value] of change.entries)
        Object.defineProperty(result, key, {
          value: apply(before[key], value),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      return result;
    }
  }
}

/** One immutable run of lines, compressed once when the run was sealed. */
interface Segment {
  data: Uint8Array;
  count: number;
}
/**
 * A checkpoint holds a base snapshot and one delta line per later sample.
 * Lines arrive in `open` and move into a `Segment` once, so no append ever
 * compresses a line a previous append already compressed.
 */
interface Chunk {
  times: number[];
  segments: Segment[];
  sealedBytes: number;
  open: string[];
  openLength: number;
  length: number;
}
interface Active {
  chunk: Chunk;
  previous: Json;
}
interface Cursor {
  reader: Reader;
  index: number;
  value: Json;
}
interface LaneCursor {
  index: number;
  table: Json;
  samples: LaneSample[];
}

/** Samples per checkpoint, after which a fresh base replaces the delta chain. */
const chunkSamples = 300;
/** Checkpoint text, the other rollover bound, in UTF-16 code units. */
const chunkLimit = 16 * 1024 * 1024;
/**
 * Text a checkpoint may hold unsealed, in UTF-16 code units. A run seals once
 * it reaches this, so it holds the limit plus the one line that crossed it,
 * and that whole run is the input of one seal and of nothing else.
 */
const openLimit = 1024 * 1024;

const decoder = new TextDecoder();

function chunkBytes(chunk: Chunk): number {
  // An open line is text, so it is charged at the two bytes a UTF-16 code
  // unit costs, not at the bytes it would take once compressed.
  return chunk.sealedBytes + chunk.openLength * 2;
}

/** Compress the open run once. The lines it held are never compressed again. */
function seal(chunk: Chunk): void {
  if (!chunk.open.length) return;
  const data = Bun.gzipSync(chunk.open.join("\n"));
  chunk.segments.push({ data, count: chunk.open.length });
  chunk.sealedBytes += data.byteLength;
  chunk.open = [];
  chunk.openLength = 0;
}

function append(chunk: Chunk, time: number, line: string): void {
  if (chunk.openLength >= openLimit) seal(chunk);
  chunk.open.push(line);
  chunk.openLength += line.length + 1;
  chunk.length += line.length + 1;
  chunk.times.push(time);
}

/**
 * Reads one checkpoint's lines by line number. A sealed segment is inflated
 * when a line inside it is read and is dropped when a line outside it is, so
 * a walk through a checkpoint inflates each segment once and never holds more
 * than one segment's text. The open lines are read from the checkpoint itself
 * and cost nothing to reach, which is where every live sample reads.
 */
class Reader {
  /** Sealed lines when this reader was made, and where the open run starts. */
  private readonly sealed: number;
  private readonly segments: number;
  /** The one inflated segment, and the line number its first line carries. */
  private first = 0;
  private lines: string[] = [];
  constructor(readonly chunk: Chunk) {
    this.segments = chunk.segments.length;
    this.sealed = chunk.segments.reduce((n, s) => n + s.count, 0);
  }
  /**
   * A seal moves open lines into a segment, which moves where the open run
   * starts, so a reader made before one cannot place a line after it.
   */
  get current(): boolean {
    return this.chunk.segments.length === this.segments;
  }
  line(index: number): string {
    if (index >= this.sealed) return this.chunk.open[index - this.sealed];
    if (index < this.first || index >= this.first + this.lines.length) {
      let start = 0;
      let at = 0;
      for (const segment of this.chunk.segments) {
        if (index < start + segment.count) break;
        start += segment.count;
        at++;
      }
      this.first = start;
      this.lines = decoder
        .decode(Bun.gunzipSync(new Uint8Array(this.chunk.segments[at].data)))
        .split("\n");
    }
    return this.lines[index - this.first];
  }
}

/** Bounded checkpoints retain exact snapshots without repeating static fields. */
export class Archive {
  private chunks: Chunk[] = [];
  private active?: Active;
  private cursor?: Cursor;
  private bytes = 0;
  private laneCache = new Map<string, Map<Chunk, LaneCursor>>();
  shortened = false;
  constructor(private maxBytes = 128 * 1024 * 1024) {}
  add(time: number, json: string): void {
    const last = this.chunks.at(-1)?.times.at(-1);
    if (last !== undefined && time <= last)
      throw new Error("Snapshot times must increase");
    const value = encode(json);
    if (
      !this.active ||
      this.active.chunk.times.length >= chunkSamples ||
      this.active.chunk.length >= chunkLimit
    ) {
      // The checkpoint that was last takes no further lines, so its open run
      // is compressed now and that checkpoint never allocates again. It is
      // read from the list rather than from `active`, because a copy carries
      // an unsealed run that it never appended to and never would seal.
      const previous = this.chunks.at(-1);
      if (previous) {
        this.bytes -= chunkBytes(previous);
        seal(previous);
        this.bytes += chunkBytes(previous);
      }
      const base = JSON.stringify(value);
      const chunk: Chunk = {
        times: [],
        segments: [],
        sealedBytes: 0,
        open: [],
        openLength: 0,
        length: 0,
      };
      append(chunk, time, base);
      this.chunks.push(chunk);
      this.bytes += chunkBytes(chunk);
      this.active = { chunk, previous: value };
    } else {
      const a = this.active;
      const change = JSON.stringify(difference(a.previous, value) ?? null);
      a.previous = value;
      this.bytes -= chunkBytes(a.chunk);
      append(a.chunk, time, change);
      this.bytes += chunkBytes(a.chunk);
    }
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const old = this.chunks.shift();
      if (!old) throw new Error("Archive has no oldest checkpoint");
      this.bytes -= chunkBytes(old);
      this.shortened = true;
      if (this.cursor?.reader.chunk === old) this.cursor = undefined;
      for (const cache of this.laneCache.values()) cache.delete(old);
    }
    if (this.bytes > this.maxBytes)
      throw new Error("A history checkpoint exceeds the memory budget");
  }
  prune(cutoff: number): void {
    while (
      this.chunks.length &&
      (this.chunks[0].times.at(-1) ?? cutoff) < cutoff
    ) {
      const old = this.chunks.shift();
      if (!old) throw new Error("Archive has no expired checkpoint");
      this.bytes -= chunkBytes(old);
      if (this.active?.chunk === old) this.active = undefined;
      if (this.cursor?.reader.chunk === old) this.cursor = undefined;
      for (const cache of this.laneCache.values()) cache.delete(old);
    }
  }
  at(time: number): Snapshot | null {
    const chunk = this.chunks.findLast((c) => c.times[0] <= time);
    if (!chunk) return null;
    const index = chunk.times.findLastIndex((t) => t <= time);
    // The cursor carries the snapshot it last rebuilt and the reader that
    // inflated the lines it walked. Keeping the reader is what makes a walk
    // forward through a checkpoint inflate each sealed segment once rather
    // than once per sample, which is the whole cost of `rows`.
    const cursor =
      this.cursor?.reader.chunk === chunk &&
      this.cursor.reader.current &&
      this.cursor.index <= index
        ? this.cursor
        : undefined;
    const reader = cursor?.reader ?? new Reader(chunk);
    const applied = cursor?.index ?? 0;
    let value = cursor ? cursor.value : (JSON.parse(reader.line(0)) as Json);
    for (let i = applied + 1; i <= index; i++) {
      const change = JSON.parse(reader.line(i)) as Change | null;
      if (change) value = apply(value, change);
    }
    this.cursor = { reader, index, value };
    return decode(value);
  }
  copy(cutoff: number): Archive {
    const copy = new Archive(this.maxBytes);
    // The copy owns its own arrays: the original keeps appending to its open
    // run and sealing into its segment list, and neither may reach the copy.
    copy.chunks = this.chunks
      .filter((c) => (c.times.at(-1) ?? cutoff) >= cutoff)
      .map((c) => ({
        times: [...c.times],
        segments: [...c.segments],
        sealedBytes: c.sealedBytes,
        open: [...c.open],
        openLength: c.openLength,
        length: c.length,
      }));
    copy.bytes = copy.chunks.reduce((sum, c) => sum + chunkBytes(c), 0);
    copy.shortened = this.shortened;
    return copy;
  }
  get firstTime(): number | undefined {
    return this.chunks[0]?.times[0];
  }
  /** Project lane columns without reconstructing every process at every time. */
  laneWindow(id: string, start: number, end: number): LaneSample[] {
    let cache = this.laneCache.get(id);
    if (!cache) {
      if (this.laneCache.size >= 2) {
        const oldest = this.laneCache.keys().next().value;
        if (oldest !== undefined) this.laneCache.delete(oldest);
      }
      cache = new Map();
      this.laneCache.set(id, cache);
    }
    const result: LaneSample[] = [];
    for (const chunk of this.chunks) {
      if (chunk.times[0] > end || (chunk.times.at(-1) ?? start) < start)
        continue;
      let saved = cache.get(chunk);
      if (!saved || saved.index < chunk.times.length - 1) {
        const first = (saved?.index ?? -1) + 1;
        const reader = new Reader(chunk);
        let table: Json =
          saved?.table ?? (JSON.parse(reader.line(0)) as ObjectValue).lanes;
        const samples = saved?.samples ?? [];
        for (let i = first; i < chunk.times.length; i++) {
          if (i > 0) {
            const change = JSON.parse(reader.line(i)) as Change | null;
            if (change?.kind === "replace") {
              if (!object(change.value))
                throw new Error("Archived snapshot is not an object");
              table = change.value.lanes;
            } else if (change?.kind === "object") {
              const laneChange = change.entries.find(
                ([key]) => key === "lanes",
              )?.[1];
              if (laneChange) table = apply(table, laneChange);
            } else if (change)
              throw new Error("Invalid archived snapshot change");
          }
          if (!object(table) || !object(table.columns))
            throw new Error("Invalid archived lane columns");
          const columns = table.columns;
          const index = Array.isArray(columns.id) ? columns.id.indexOf(id) : -1;
          const metric = (key: string): number | null => {
            const column = columns[key];
            const value =
              index >= 0 && Array.isArray(column) ? column[index] : null;
            return typeof value === "number" ? value : null;
          };
          samples.push({
            time: chunk.times[i],
            cpu: metric("cpu"),
            rss: metric("rss"),
            pressure: metric("pressure"),
            memoryPressure: metric("memoryPressure"),
            ioPressure: metric("ioPressure"),
          });
        }
        saved = { index: chunk.times.length - 1, table, samples };
        cache.set(chunk, saved);
      }
      for (const sample of saved.samples)
        if (sample.time >= start && sample.time <= end)
          result.push({ ...sample });
    }
    return result;
  }
  *rows(cutoff: number): Generator<{ time: number; json: string }> {
    for (const chunk of this.chunks)
      for (const time of chunk.times) {
        if (time < cutoff) continue;
        const snapshot = this.at(time);
        if (!snapshot) throw new Error("Archived snapshot is missing");
        yield { time, json: JSON.stringify(snapshot) };
      }
  }
}
