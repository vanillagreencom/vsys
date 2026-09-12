import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
