import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, laneSnapshot, processSnapshot } from "../test/fixture";
import { mount } from "../test/harness";
import { cacheText } from "./builds-screen";

test("the cache reading states its window and never divides by nothing", () => {
  expect(cacheText(null)).toBe("not available");
  expect(cacheText({ hits: 0, misses: 0, rate: null, windowMs: 300000 })).toBe(
    "no requests over 5m",
  );
  expect(cacheText({ hits: 3, misses: 1, rate: 75, windowMs: 0 })).toBe(
    "75.0% hits · 3 hits, 1 miss over no elapsed time",
  );
  expect(cacheText({ hits: 1, misses: 3, rate: 25, windowMs: 60000 })).toBe(
    "25.0% hits · 1 hit, 3 misses over 1m",
  );
});

test("an unstated pool size is not reported as an unreadable one", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", pids: [40], builds: { rustc: 1 } }),
  ];
  // A build process advertising a token pool whose flags carry no -j. Nothing
  // is read from the fifo, by design: reading it would take a token.
  s.procs = [
    processSnapshot({
      pid: 40,
      build: "rustc",
      env: { MAKEFLAGS: "--jobserver-auth=fifo:/tmp/pool" },
    }),
  ];
  // Wide enough that the tile draws the whole sentence rather than a cut one.
  const t = await mount(s, c, { width: 220, height: 30 });
  try {
    await t.press("4");
    const frame = t.frame();
    expect(frame).toContain("pool size not stated in the build flags");
    // The old wording sent a reader to look for a permissions problem that
    // never existed.
    expect(frame).not.toContain("not readable");
    expect(frame).not.toContain("from the fifo");
  } finally {
    await t.close();
  }
});

test("the linkers cell stays inside its column on the rendered Builds screen", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // Every default linker running at once. The raw reading is 59 columns, near
  // twice the 30 the heading reserves for it, so a cell that skipped the
  // column spec would run past the width its heading declares.
  s.lanes = [
    laneSnapshot({
      name: "lane-a",
      builds: Object.fromEntries(c.linkerNames.map((name) => [name, 1])),
    }),
  ];
  const t = await mount(s, c, { width: 140, height: 24 });
  try {
    await t.press("4");
    const lines = t.frame().split("\n");
    const heading = lines.find(
      (line) => line.includes("Building") && line.includes("Linkers"),
    );
    const row = lines.find((line) => line.includes("lane-a"));
    expect(heading).toBeDefined();
    expect(row).toBeDefined();
    if (!heading || !row) throw new Error("no heading and row to compare");
    const start = heading.indexOf("Linkers");
    const linkers = row.slice(start).trimEnd();
    // The cell starts where its heading starts and ends inside its width, the
    // cut marked, rather than spilling the rest of the list past the column.
    expect(row.indexOf("7 linkers")).toBe(start);
    expect(linkers.length).toBe(30);
    expect(linkers.endsWith("…")).toBe(true);
    expect(row).not.toContain("ld.bfd");
  } finally {
    await t.close();
  }
});

test("the row for unwatched build work names no process id rather than nought", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // A compiler running outside every watched cgroup, which is the only way
  // the catch-all row appears. It stands for a set of processes rather than a
  // lane, so it has no main process to name.
  s.procs = [processSnapshot({ pid: 4242, build: "rustc" })];
  // A watched lane compiling too, so the screen draws both kinds of row.
  s.lanes = [
    laneSnapshot({ name: "lane-a", mainPid: 3400, builds: { rustc: 1 } }),
  ];
  const t = await mount(s, c, { width: 160, height: 24 });
  try {
    await t.press("4");
    const lines = t.frame().split("\n");
    // Read the column by where its heading sits: the row carries a real `0`
    // of its own in `0 linkers`, so looking for the character is not enough.
    const at = (lines.find((line) => line.includes("PID")) ?? "").indexOf(
      "PID",
    );
    expect(at).toBeGreaterThan(0);
    const idIn = (line: string) => line.slice(at - 6, at + 3).trim();
    const loose =
      lines.find((line) => line.includes("outside the watched lanes")) ?? "";
    expect(loose).not.toBe("");
    // A zero here is a number nobody measured, drawn where a reader reads
    // process ids. The cell is blank instead.
    expect(idIn(loose)).toBe("");
    // The watched lane beside it draws its own, so this is the catch-all row
    // being blank rather than the column being absent.
    const watched = lines.find((line) => line.includes("lane-a")) ?? "";
    expect(idIn(watched)).toBe("3400");
  } finally {
    await t.close();
  }
});
