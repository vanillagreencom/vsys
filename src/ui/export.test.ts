import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
  volumeSnapshot,
} from "../test/fixture";
import { exportSnapshot } from "./export";

/**
 * Every section of the report with rows in it, the cells the escaper and the
 * terminal-control filter rewrite, and each value the report writes as
 * unknown or unavailable.
 */
function reportSnapshot() {
  const s = emptySnapshot(1767225600000);
  s.system.host = "host|*a*";
  s.system.load = [1.5, 0.25, 0];
  s.system.memory = { MemTotal: 16000, MemAvailable: 8000, SwapFree: 0 };
  s.system.pressure = {
    cpu: { some: 1.25, full: null, total: 10 },
    memory: null,
    io: { some: 0, full: 3.5, total: 20 },
  };
  s.system.zram = [
    { device: "zram0", original: 4096, compressed: 1024, used: 2048 },
  ];
  s.lanes = [
    laneSnapshot({
      id: "agents.slice/a.scope",
      name: "a_[b]\u001b[2J",
      account: "acct#1",
      cwd: "/repo/x.y",
      branch: "feat/(x)",
      mainPid: 4071,
      cpu: 12.5,
      unconfined: true,
    }),
    laneSnapshot({
      id: "agents.slice/bare.scope",
      name: "bare",
      mainPid: 0,
      pids: [],
      age: null,
      rss: null,
      swap: null,
      state: "unknown",
      dangerous: true,
    }),
  ];
  s.groups = [
    groupSnapshot({
      path: "agents.slice/a.scope",
      kernelPath: "/user.slice/agents.slice/a.scope",
      memory: 4096,
      high: 8192,
      max: 5242880,
      swapMax: 0,
      tasks: 3,
      tasksMax: 512,
      pressure: { cpu: { some: 1, full: 0, total: 5 } },
    }),
    groupSnapshot({ path: "agents.slice/bare.scope", cpuMax: "50000 100000" }),
  ];
  s.procs = [
    processSnapshot({
      pid: 4071,
      threads: 65,
      command: ["tool", "![payload](https://invalid)", "a&b<c>"],
      env: { CARGO_TARGET_DIR: "/tmp/t", KEY: "v`x`" },
    }),
  ];
  s.storage.volumes = [
    volumeSnapshot("/", {
      device: "/dev/nvme0n1p2",
      options: ["rw", "noatime"],
      errors: { "1/corruption_errs": 2 },
      delta: { "1/corruption_errs": 1 },
    }),
    volumeSnapshot("/ro", { readOnly: true }),
  ];
  s.storage.scrubs = [
    { path: "/scrub/root", text: "Error summary: csum=2", problem: true },
  ];
  s.storage.scratchTime = 1767225500000;
  s.storage.scratchPending = true;
  s.storage.scratch = [
    {
      path: "/scratch/one",
      bytes: 1048576,
      age: 3600,
      error: null,
      origin: "configured",
    },
    {
      path: "/unread-root",
      bytes: null,
      age: null,
      error: "ENOENT: no such file or directory",
      origin: "default",
    },
  ];
  s.storage.sessions = [
    { path: "/tmp/session-1", bytes: 512, age: 60, error: null },
  ];
  s.alerts = [
    {
      time: 1767225590000,
      rule: "memory-cap",
      subject: "agents.slice/a.scope",
      message: "a_[b] reached its memory cap",
    },
  ];
  s.errors = [{ source: "cgroup", message: "EACCES: memory.stat" }];
  return s;
}

// Written by the Markdown export before it moved out of `src/model/`.
const expected = readFileSync(
  new URL("./export.fixture.txt", import.meta.url),
  "utf8",
);

test("the Markdown report keeps every byte of the report it replaced", () => {
  expect(exportSnapshot(reportSnapshot(), "markdown")).toBe(expected);
});
test("reports retain process threads and the exact memory cap", () => {
  const s = emptySnapshot();
  s.groups = [groupSnapshot({ max: 5242880 })];
  s.procs = [
    processSnapshot({
      pid: 4242,
      threads: 65,
      command: ["tool", "![payload](https://invalid)"],
    }),
  ];
  const report = exportSnapshot(s, "markdown");
  expect(
    report.split("\n").find((line) => line.startsWith("| agents")),
  ).toContain("| 5242880 |");
  expect(
    report.split("\n").find((line) => line.startsWith("| 4242 |")),
  ).toContain("| 65 |");
  expect(report).toContain("\\!\\[payload\\]");
  expect(report).not.toContain("![payload]");
});
test("the scratch table writes no age for a root it never read", () => {
  const s = emptySnapshot();
  s.storage.scratch = [
    {
      path: "/unread-root",
      bytes: null,
      age: null,
      modifiedAt: null,
      error: "ENOENT: no such file or directory",
      origin: "configured",
    },
  ];
  const report = exportSnapshot(s, "markdown");
  const row = report.split("\n").find((line) => line.includes("/unread-root"));
  expect(row).toContain("unavailable");
  expect(row).not.toMatch(/\|\s*0\s*\|/);
});
test("a lane with no member read exports its main process as unknown", () => {
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "led.scope", name: "led", mainPid: 4071 }),
    laneSnapshot({ id: "bare.scope", name: "bare", mainPid: 0, pids: [] }),
  ];
  const stored = JSON.parse(exportSnapshot(s, "json")) as {
    lanes: { mainPid: number | null }[];
  };
  expect(stored.lanes.map((lane) => lane.mainPid)).toEqual([4071, null]);
  const rows = exportSnapshot(s, "markdown").split("\n");
  const pid = (name: string) =>
    rows.find((row) => row.startsWith(`| ${name} |`))?.split(" | ")[5];
  expect([pid("led"), pid("bare")]).toEqual(["4071", "?"]);
});
