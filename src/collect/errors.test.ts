import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ErrorMemory } from "./errors";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), "vsys-errors-"));
  roots.push(root);
  return join(root, "state", "filesystem-errors.json");
}

test("a counter already above zero establishes a baseline and claims no time", () => {
  const memory = new ErrorMemory(statePath());
  // A counter reading 1390 on the first sample says damage happened, not when.
  expect(memory.observe("fs", 1390, 1000)).toEqual({
    counter: 1390,
    at: null,
    size: null,
  });
  expect(memory.observe("fs", 1390, 2000)).toEqual({
    counter: 1390,
    at: null,
    size: null,
  });
});

test("growth records when the counter grew and by how much", () => {
  const memory = new ErrorMemory(statePath());
  memory.observe("fs", 10, 1000);
  expect(memory.observe("fs", 36, 5000)).toEqual({
    counter: 36,
    at: 5000,
    size: 26,
  });
  // A later sample that finds no growth keeps the time of the growth it saw.
  expect(memory.observe("fs", 36, 9000)).toEqual({
    counter: 36,
    at: 5000,
    size: 26,
  });
});

test("a counter reset moves the baseline and never reads as a repair", () => {
  const memory = new ErrorMemory(statePath());
  memory.observe("fs", 10, 1000);
  memory.observe("fs", 36, 5000);
  // A reboot zeroes the counters. The recorded growth outlives it.
  expect(memory.observe("fs", 0, 9000)).toEqual({
    counter: 0,
    at: 5000,
    size: 26,
  });
  // And growth from the new baseline is measured against it, not against 36.
  expect(memory.observe("fs", 2, 12000)).toEqual({
    counter: 2,
    at: 12000,
    size: 2,
  });
});

test("each filesystem is remembered on its own", () => {
  const memory = new ErrorMemory(statePath());
  memory.observe("one", 1, 1000);
  memory.observe("two", 1, 1000);
  memory.observe("one", 5, 4000);
  expect(memory.observe("two", 1, 6000).at).toBeNull();
  expect(memory.observe("one", 5, 6000).at).toBe(4000);
});

test("what was remembered survives a restart", () => {
  const path = statePath();
  const first = new ErrorMemory(path);
  first.observe("fs", 10, 1000);
  first.observe("fs", 36, 5000);
  first.save();
  const second = new ErrorMemory(path);
  second.load();
  // The history window is a day; this reading is older than that and still
  // answers "when was the last new error".
  expect(second.observe("fs", 36, 90000000)).toEqual({
    counter: 36,
    at: 5000,
    size: 26,
  });
});

test("a state file that is not what it claims is refused, not half read", () => {
  for (const body of ["[]", '{"fs":{"counter":"lots"}}', "not json", '"x"']) {
    const path = statePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    expect(() => new ErrorMemory(path).load()).toThrow();
  }
  // The control: the shape the writer produces loads.
  const good = statePath();
  mkdirSync(dirname(good), { recursive: true });
  writeFileSync(good, '{"fs":{"counter":3,"at":5000,"size":2}}');
  const memory = new ErrorMemory(good);
  memory.load();
  expect(memory.observe("fs", 3, 9000).at).toBe(5000);
});

test("a write that failed is tried again rather than dropped", () => {
  const path = statePath();
  const memory = new ErrorMemory(path);
  memory.observe("fs", 10, 1000);
  memory.observe("fs", 36, 5000);
  // A state directory that cannot be created: the one place the remembered
  // time lives is unwritable, and the reading must not be discarded with it.
  mkdirSync(dirname(dirname(path)), { recursive: true });
  writeFileSync(dirname(path), "");
  expect(() => memory.save()).toThrow();
  rmSync(dirname(path));
  memory.save();
  const second = new ErrorMemory(path);
  second.load();
  expect(second.observe("fs", 36, 9000).at).toBe(5000);
});

test("a memory that could not be read says so and is never overwritten", () => {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "not json");
  const memory = new ErrorMemory(path);
  expect(() => memory.load()).toThrow();
  expect(memory.available).toBe(false);
  memory.observe("fs", 1390, 1000);
  memory.save();
  // The file a person can still repair stands, rather than being replaced by
  // this process's fresh baselines.
  expect(readFileSync(path, "utf8")).toBe("not json");
  // A file that is merely absent is an empty memory, which is a reading.
  const fresh = new ErrorMemory(statePath());
  expect(() => fresh.load()).toThrow();
  expect(fresh.available).toBe(true);
});

test("a second process writing the same file loses neither growth time", () => {
  const path = statePath();
  const first = new ErrorMemory(path);
  const second = new ErrorMemory(path);
  // Both sample the same host and both start from the same baseline.
  first.observe("one", 10, 1000);
  second.observe("one", 10, 1000);
  first.observe("two", 5, 1000);
  second.observe("two", 5, 1000);
  // Each sees growth on a different filesystem, and the one that saw the
  // earlier growth renames last.
  second.observe("two", 8, 6000);
  first.observe("one", 36, 4000);
  second.save();
  first.save();
  const read = new ErrorMemory(path);
  read.load();
  expect(read.observe("one", 36, 9000)).toEqual({
    counter: 36,
    at: 4000,
    size: 26,
  });
  expect(read.observe("two", 8, 9000)).toEqual({
    counter: 8,
    at: 6000,
    size: 3,
  });
});

test("a growth time on disk is never replaced by an older one", () => {
  const path = statePath();
  const stale = new ErrorMemory(path);
  stale.observe("fs", 10, 1000);
  stale.observe("fs", 20, 2000);
  const fresh = new ErrorMemory(path);
  fresh.observe("fs", 10, 1000);
  fresh.observe("fs", 30, 8000);
  fresh.save();
  // The process holding the older reading writes last.
  stale.save();
  const read = new ErrorMemory(path);
  read.load();
  expect(read.observe("fs", 30, 9000).at).toBe(8000);
});
