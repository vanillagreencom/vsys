import type { Snapshot } from "../model/types";
import type { LaneSample } from "./lane-series";
import { normalizeLaneReadings } from "./migrate";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type Change =
  | { kind: "replace"; value: Json }
  | { kind: "add"; value: number }
  | { kind: "shift"; value: number; entries?: [number, number][] }
  | { kind: "array"; length: number; entries: [number, Change][] }
  | { kind: "object"; entries: [string, Change][]; removed: string[] };

/**
 * The refusals a caller or a test tells apart. `errorText()` in
 * `src/ui/refusals.ts` writes what the reader sees.
 */
export type ArchiveRefusal =
  | { kind: "invalid-column"; table: string; field: string }
  | { kind: "short-column"; table: string; field: string; row: number }
  | { kind: "missing-line"; line: number }
  | { kind: "over-budget" };

export class ArchiveError extends Error {
  constructor(readonly refusal: ArchiveRefusal) {
    super(refusal.kind);
  }
}

function object(value: Json | undefined): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function projectionContext(value: ObjectValue): ObjectValue {
  const context: ObjectValue = {};
  for (const key of ["lanes", "groups", "processRead"]) {
    const field = value[key];
    if (field !== undefined) context[key] = field;
  }
  return context;
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
    const columns = Object.entries(table.columns).map(
      ([field, values]): [string, Json[]] => {
        if (!Array.isArray(values))
          throw new ArchiveError({ kind: "invalid-column", table: key, field });
        return [field, values];
      },
    );
    const missing = new Map(
      Object.entries(table.missing).map(([field, indices]) => [
        field,
        new Set(indices as number[]),
      ]),
    );
    value[key] = Array.from({ length: table.length }, (_, i) =>
      Object.fromEntries(
        columns.flatMap(([field, values]) => {
          if (missing.get(field)?.has(i)) return [];
          const cell = values[i];
          if (cell === undefined)
            throw new ArchiveError({
              kind: "short-column",
              table: key,
              field,
              row: i,
            });
          return [[field, cell]];
        }),
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
    for (const [i, value] of after.entries()) {
      const change = difference(before[i], value);
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
/**
 * Lane columns projected out of one checkpoint. Every lane it holds has a
 * sample for each line up to `index`. The context retains lane columns and
 * the process-read and cgroup evidence needed to normalize legacy readings.
 */
interface LaneProjection {
  index: number;
  context: ObjectValue;
  lanes: Map<string, LaneSample[]>;
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

/** A checkpoint is made with its base line, so it always has a first time. */
function chunkStart(chunk: Chunk): number {
  const [first] = chunk.times;
  if (first === undefined) throw new Error("Archive checkpoint has no sample");
  return first;
}

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
    const line =
      index >= this.sealed
        ? this.chunk.open[index - this.sealed]
        : this.sealedLine(index);
    if (line === undefined)
      throw new ArchiveError({ kind: "missing-line", line: index });
    return line;
  }
  private sealedLine(index: number): string | undefined {
    if (index < this.first || index >= this.first + this.lines.length) {
      let start = 0;
      let at = 0;
      for (const segment of this.chunk.segments) {
        if (index < start + segment.count) break;
        start += segment.count;
        at++;
      }
      const segment = this.chunk.segments[at];
      if (!segment) return undefined;
      this.first = start;
      this.lines = decoder
        .decode(Bun.gunzipSync(new Uint8Array(segment.data)))
        .split("\n");
    }
    return this.lines[index - this.first];
  }
}

/** One lane's readings at one line, unknown where that line holds no such lane. */
function laneSample(
  columns: ObjectValue,
  index: number | undefined,
  time: number,
  processRead: Json | undefined,
  groupCpu: Map<Json, number | null>,
): LaneSample {
  const metric = (key: string): number | null => {
    const column = columns[key];
    const value =
      index !== undefined && Array.isArray(column) ? column[index] : null;
    return typeof value === "number" ? value : null;
  };
  const cgroups = columns.cgroup;
  const cgroup =
    index !== undefined && Array.isArray(cgroups) ? cgroups[index] : null;
  const readings = normalizeLaneReadings(
    { cpu: metric("cpu"), rss: metric("rss"), mainPid: metric("mainPid") ?? 0 },
    processRead,
    groupCpu.get(cgroup ?? null) ?? null,
  );
  return {
    time,
    ...readings,
    pressure: metric("pressure"),
    memoryPressure: metric("memoryPressure"),
    ioPressure: metric("ioPressure"),
  };
}

/** Bounded checkpoints retain exact snapshots without repeating static fields. */
export class Archive {
  private chunks: Chunk[] = [];
  private active?: Active;
  private cursor?: Cursor;
  private bytes = 0;
  private projections = new Map<Chunk, LaneProjection>();
  /** Every lane any projection holds, so a sample checks them and not each checkpoint. */
  private projected = new Set<string>();
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
      this.projections.delete(old);
    }
    if (this.bytes > this.maxBytes)
      throw new ArchiveError({ kind: "over-budget" });
    // A projection keeps a lane only while the lane lives. A lane that ended
    // leaves the list that asked for it, and holding its samples until its
    // checkpoints expire would keep every lane that ran inside the window.
    if (this.projected.size) {
      const columns = object(value.lanes) ? value.lanes.columns : null;
      const live = new Set(
        object(columns) && Array.isArray(columns.id) ? columns.id : [],
      );
      for (const id of this.projected) {
        if (live.has(id)) continue;
        this.projected.delete(id);
        for (const projection of this.projections.values())
          projection.lanes.delete(id);
      }
    }
  }
  prune(cutoff: number): void {
    while ((this.chunks[0]?.times.at(-1) ?? cutoff) < cutoff) {
      const old = this.chunks.shift();
      if (!old) throw new Error("Archive has no expired checkpoint");
      this.bytes -= chunkBytes(old);
      if (this.active?.chunk === old) this.active = undefined;
      if (this.cursor?.reader.chunk === old) this.cursor = undefined;
      this.projections.delete(old);
    }
  }
  at(time: number): Snapshot | null {
    const chunk = this.chunks.findLast((c) => chunkStart(c) <= time);
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
  /**
   * Lane series without reconstructing every process at every time. Every lane
   * one call asks for is read in the same walk of each checkpoint, so a list
   * of many lanes inflates a segment once rather than once per lane.
   */
  laneWindows(
    ids: readonly string[],
    start: number,
    end: number,
  ): Map<string, LaneSample[]> {
    const wanted = [...new Set(ids)];
    const result = new Map(
      wanted.map((id): [string, LaneSample[]] => [id, []]),
    );
    if (!wanted.length) return result;
    for (const chunk of this.chunks) {
      if (chunkStart(chunk) > end || (chunk.times.at(-1) ?? start) < start)
        continue;
      const { lanes } = this.project(chunk, wanted);
      for (const [id, out] of result) {
        const samples = lanes.get(id);
        if (!samples)
          throw new Error(
            "A lane projection is missing a lane it was asked for",
          );
        for (const sample of samples)
          if (sample.time >= start && sample.time <= end)
            out.push({ ...sample });
      }
    }
    // A checkpoint the window has moved past is let go, the rule the stored
    // series in `History` follow. A reader whose window starts a little
    // earlier walks that one checkpoint again rather than every reader
    // holding every checkpoint it ever read until the lane ends.
    for (const chunk of this.projections.keys())
      if ((chunk.times.at(-1) ?? start) < start) this.projections.delete(chunk);
    return result;
  }
  /**
   * Bring one checkpoint's projection to its newest line for every lane it
   * holds and every lane in `ids`, in one walk. A lane new to the checkpoint
   * needs every line from the base, so that walk starts there and the lanes
   * already held take only the lines past the index they reached.
   */
  private project(chunk: Chunk, ids: string[]): LaneProjection {
    const last = chunk.times.length - 1;
    const saved = this.projections.get(chunk);
    const fresh = ids.filter((id) => !saved?.lanes.has(id));
    if (saved && !fresh.length && saved.index === last) return saved;
    const added = fresh.map((id): [string, LaneSample[]] => [id, []]);
    const held = saved ? [...saved.lanes] : [];
    const every = [...added, ...held];
    const reached = saved?.index ?? -1;
    const first = !saved || fresh.length ? 0 : saved.index + 1;
    const reader = new Reader(chunk);
    try {
      const base =
        first === 0 || !saved
          ? (JSON.parse(reader.line(0)) as ObjectValue)
          : saved.context;
      let context = projectionContext(base);
      for (const [i, time] of chunk.times.entries()) {
        if (i < first) continue;
        if (i > 0) {
          const change = JSON.parse(reader.line(i)) as Change | null;
          if (change?.kind === "replace") {
            if (!object(change.value))
              throw new Error("Archived snapshot is not an object");
            context = projectionContext(change.value);
          } else if (change?.kind === "object") {
            for (const key of ["lanes", "groups", "processRead"]) {
              const entry = change.entries.find(([name]) => name === key)?.[1];
              if (entry) context[key] = apply(context[key], entry);
              if (change.removed.includes(key)) delete context[key];
            }
          } else if (change)
            throw new Error("Invalid archived snapshot change");
        }
        const table = context.lanes;
        if (!object(table) || !object(table.columns))
          throw new Error("Invalid archived lane columns");
        const columns = table.columns;
        const position = new Map<Json, number>();
        if (Array.isArray(columns.id))
          columns.id.forEach((id, n) => {
            if (!position.has(id)) position.set(id, n);
          });
        const groupCpu = new Map<Json, number | null>();
        const groups = context.groups;
        if (
          context.processRead === undefined &&
          object(groups) &&
          object(groups.columns)
        ) {
          const { path, kernelPath, cpuPercent } = groups.columns;
          if (Array.isArray(path))
            path.forEach((name, n) => {
              const cpu = Array.isArray(cpuPercent) ? cpuPercent[n] : null;
              const value = typeof cpu === "number" ? cpu : null;
              groupCpu.set(name, value);
              const kernel = Array.isArray(kernelPath) ? kernelPath[n] : null;
              if (typeof kernel === "string") groupCpu.set(kernel, value);
            });
        }
        for (const [id, samples] of i <= reached ? added : every)
          samples.push(
            laneSample(
              columns,
              position.get(id),
              time,
              context.processRead,
              groupCpu,
            ),
          );
      }
      if (!object(context.lanes))
        throw new Error("A lane projection walked no archived line");
      const projection = { index: last, context, lanes: new Map(every) };
      for (const id of fresh) this.projected.add(id);
      this.projections.set(chunk, projection);
      return projection;
    } catch (error) {
      // The held lanes were extended in place, so a walk that stopped part way
      // leaves them past the index they record. None of it is kept.
      this.projections.delete(chunk);
      throw error;
    }
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
