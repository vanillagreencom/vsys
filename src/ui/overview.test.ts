import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import type { Snapshot } from "../model/types";
import { meters } from "../model/verdict";
import {
  emptySnapshot,
  everyCauseSnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
  volumeSnapshot,
} from "../test/fixture";
import { attention, meterLine, sourceFooter, verdictLine } from "./overview";

const base = ["/usr/bin", "/bin"];
test("overview promotes active problems and does not call past events current", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.alerts = [
    { rule: "memory-cap", subject: "old", message: "past event", time: 0 },
  ];
  expect(attention(s, c, base)).toEqual([]);
  expect(verdictLine([], s)).toBe("Healthy");
  s.lanes = [laneSnapshot({ dangerous: true })];
  const problems = attention(s, c, base);
  expect(problems).toHaveLength(1);
  expect(problems[0].laneId).toBe(s.lanes[0].id);
  expect(problems[0].danger).toBe(true);
});

test("every card kind ends with a next step of its own", () => {
  const c = defaults();
  const items = attention(everyCauseSnapshot(c), c, base);
  expect(items.length).toBeGreaterThan(10);
  for (const item of items) {
    expect(item.next.length).toBeGreaterThan(20);
    expect(item.next).not.toBe(item.title);
    expect(item.next).not.toBe(item.detail);
    expect(item.title.length).toBeGreaterThan(0);
    expect(item.detail.length).toBeGreaterThan(0);
    expect(item.headline.length).toBeGreaterThan(0);
  }
  // Every cause appears once, so no card text repeats anywhere in the list.
  const text = items.flatMap((item) => [item.title, item.detail, item.next]);
  expect(new Set(text).size).toBe(text.length);
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
});

test("the verdict is the worst cause, formatted with its numbers", () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  expect(verdictLine(attention(s, c, base), s)).toBe(
    "Danger: 1 lane runs outside agents.slice: escaped",
  );
  s.lanes = s.lanes.filter((l) => !l.unconfined);
  s.storage.volumes = [];
  expect(verdictLine(attention(s, c, base), s)).toBe(
    "Slow: Disk I/O saturated: writer writing 200.0 MiB/s",
  );
  s.system.pressure.io = { some: 1, full: 0, total: 0 };
  expect(verdictLine(attention(s, c, base), s)).toBe(
    "Slow: desktop swapped out, agents hold 80.0 GiB of page cache",
  );
  const blind = emptySnapshot();
  blind.system.pressure = {};
  expect(verdictLine([], blind)).toBe(
    "Health unknown: no pressure data on this kernel",
  );
});

test("nine stalling lanes produce one card that names them", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = Array.from({ length: 9 }, (_, i) =>
    laneSnapshot({ id: `lane-${i}`, name: `kendex-${i}`, ioPressure: 40 }),
  );
  const stalls = attention(s, c, base).filter((item) => item.id === "stalls");
  expect(stalls).toHaveLength(1);
  expect(stalls[0].title).toBe(
    "9 lanes are stalling on a resource: kendex-0, kendex-1, kendex-2, kendex-3 and 5 more",
  );
  expect(stalls[0].detail).toBe(
    "Highest stall share 40.0% of the recent window.",
  );
  expect(stalls[0].laneId).toBeUndefined();
});

test("unconfined lanes are one card that states the launcher conclusion", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({
      id: "a",
      name: "kendex hclaude",
      pids: [11],
      unconfined: true,
    }),
    laneSnapshot({
      id: "b",
      name: "kendex nclaude",
      pids: [21],
      unconfined: true,
    }),
  ];
  s.procs = [
    processSnapshot({
      pid: 11,
      group: "/app.slice/tmux-spawn-4.scope",
      env: { CARGO_BUILD_JOBS: "16", PATH: "/home/user/.shadow/bin:/usr/bin" },
    }),
    processSnapshot({
      pid: 21,
      group: "/app.slice/tmux-spawn-3.scope",
      env: {},
    }),
  ];
  const card = attention(s, c, base).find((item) => item.id === "unconfined");
  if (!card) throw new Error("Expected one unconfined card");
  expect(card.title).toBe(
    "2 lanes run outside agents.slice: kendex hclaude, kendex nclaude",
  );
  expect(card.detail).toContain("shadowed");
  expect(card.detail).toContain("/home/user/.shadow/bin");
  expect(card.detail).toContain("Launched bare");
  expect(card.command).toBe(
    "systemd-run --user --slice=agents.slice --scope -- claude",
  );
  expect(card.laneId).toBeUndefined();
  // The marker list is configuration, so a different marker changes the verdict.
  const other = attention(s, { ...c, capMarkers: ["MAKEFLAGS"] }, base).find(
    (item) => item.id === "unconfined",
  );
  expect(other?.detail).not.toContain("shadowed");
});

test("a saturated disk card names the lane, its linkers and a read command", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.system.pressure.io = { some: 70, full: 41, total: 0 };
  s.groups = [
    groupSnapshot({
      path: "a/510341.scope",
      name: "510341.scope",
      writeRate: 209715200,
    }),
  ];
  s.lanes = [
    laneSnapshot({ id: "a/510341.scope", name: "lane-510341", pids: [1, 2] }),
  ];
  s.procs = [
    processSnapshot({ pid: 1, build: "ld.mold" }),
    processSnapshot({ pid: 2, build: "mold" }),
  ];
  const card = attention(s, c, base).find((item) => item.id === "disk");
  if (!card) throw new Error("Expected a disk card");
  expect(card.title).toBe(
    "Disk I/O saturated: lane-510341 writing 200.0 MiB/s",
  );
  expect(card.detail).toBe(
    "Tasks stalled on storage 70.0% of the recent window, 41.0% of it with nothing else to run, with 2 linkers running in that lane.",
  );
  expect(card.command).toBe(`cat ${c.cgroupRoot}/a/510341.scope/io.stat`);
  expect(card.danger).toBe(true);
});

test("source read failures leave attention and become one footer line", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.errors = [
    { source: "/proc/1", message: "permission denied" },
    { source: "/proc/1", message: "permission denied" },
    { source: "/proc/2", message: "permission denied" },
  ];
  expect(attention(s, c, base)).toEqual([]);
  // Counted once per source, so repeated failed reads cannot make it climb.
  expect(sourceFooter(s)).toBe("vsys cannot read 2 sources; open Settings");
  expect(sourceFooter(emptySnapshot())).toBe(null);
});

test("read-only mounts and device errors are one card each, not one per mount", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes = [
    volumeSnapshot("/a", { readOnly: true, delta: { "x/corruption_errs": 1 } }),
    volumeSnapshot("/b", { readOnly: true, delta: { "x/corruption_errs": 1 } }),
  ];
  const items = attention(s, c, base);
  expect(items.filter((item) => item.id === "read-only")).toHaveLength(1);
  expect(items.filter((item) => item.id === "device-errors")).toHaveLength(1);
  expect(items.find((item) => item.id === "read-only")?.title).toBe(
    "2 mounts are read-only: /a, /b",
  );
});

test("the disk meter reports free space and says when mounts are unreadable", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.system.pressure.io = { some: 12, full: 3, total: 0 };
  s.storage.volumes = [volumeSnapshot("/full", { free: 5368709120 })];
  const line = (snapshot: Snapshot) =>
    meterLine(meters(snapshot, c)[2], snapshot, c);
  expect(line(s)).toBe(
    "Disk: pressure some 12.0% full 3.0% | least free 5.0 GiB | top writer none ?/s",
  );
  s.storage.mountsAvailable = false;
  expect(line(s)).toContain("mount information unavailable");
  const bare = emptySnapshot();
  expect(line(bare)).toContain("no watched filesystems");
});
