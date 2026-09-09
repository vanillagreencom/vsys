import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import { attention, sourceFooter } from "./overview";

const base = ["/usr/bin", "/bin"];

test("overview promotes active problems and does not call past events current", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.alerts = [
    { rule: "memory-cap", subject: "old", message: "past event", time: 0 },
  ];
  expect(attention(s, c, base)).toEqual([]);
  s.lanes = [laneSnapshot({ dangerous: true })];
  const problems = attention(s, c, base);
  expect(problems).toHaveLength(1);
  expect(problems[0].laneId).toBe(s.lanes[0].id);
  expect(problems[0].danger).toBe(true);
});

test("nine stalling lanes produce one card that names them", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = Array.from({ length: 9 }, (_, i) =>
    laneSnapshot({ id: `lane-${i}`, name: `kendex-${i}`, ioPressure: 40 }),
  );
  const items = attention(s, c, base);
  const stalls = items.filter((item) => item.id === "stalls");
  expect(stalls).toHaveLength(1);
  expect(stalls[0].title).toContain("9 lanes are stalling");
  expect(stalls[0].title).toContain("kendex-0");
  expect(stalls[0].title).toContain("and 5 more");
  // No card title or detail is repeated anywhere in the list.
  const text = items.flatMap((item) => [item.title, item.detail]);
  expect(new Set(text).size).toBe(text.length);
  expect(stalls[0].laneId).toBeUndefined();
});

test("unconfined lanes are one card that states the launcher conclusion", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({
      id: "app.slice/tmux-spawn-4.scope",
      name: "kendex hclaude",
      pids: [11],
      unconfined: true,
    }),
    laneSnapshot({
      id: "app.slice/tmux-spawn-3.scope",
      name: "kendex nclaude",
      pids: [21],
      unconfined: true,
    }),
  ];
  s.procs = [
    processSnapshot({
      pid: 11,
      ppid: 1,
      group: "/user.slice/app.slice/tmux-spawn-4.scope",
      env: { CARGO_BUILD_JOBS: "16", PATH: "/home/user/.shadow/bin:/usr/bin" },
    }),
    processSnapshot({
      pid: 21,
      ppid: 1,
      group: "/user.slice/app.slice/tmux-spawn-3.scope",
      env: { PATH: "/usr/bin" },
    }),
  ];
  const items = attention(s, c, base);
  const card = items.find((item) => item.id === "unconfined");
  if (!card) throw new Error("Expected one unconfined card");
  expect(items.filter((item) => item.id === "unconfined")).toHaveLength(1);
  expect(card.title).toContain("2 lanes run outside agents.slice");
  expect(card.title).toContain("kendex hclaude");
  expect(card.title).toContain("kendex nclaude");
  expect(card.detail).toContain("shadowed");
  expect(card.detail).toContain("Launched bare");
  expect(card.next).not.toBe("");
  expect(card.command).toBe(
    "systemd-run --user --slice=agents.slice --scope -- claude",
  );
  expect(card.laneId).toBeUndefined();
});

test("a saturated disk card names the lane, its linkers and a read command", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.system.pressure.io = { some: 70, full: 40, total: 0 };
  s.groups = [
    groupSnapshot({
      path: "agents.slice/510341.scope",
      name: "510341.scope",
      writeRate: 209715200,
    }),
  ];
  s.lanes = [
    laneSnapshot({
      id: "agents.slice/510341.scope",
      name: "lane-510341",
      pids: [1, 2],
    }),
  ];
  s.procs = [
    processSnapshot({ pid: 1, build: "mold" }),
    processSnapshot({ pid: 2, build: "mold" }),
  ];
  const card = attention(s, c, base).find((item) => item.id === "disk");
  if (!card) throw new Error("Expected a disk card");
  expect(card.title).toContain("lane-510341");
  expect(card.detail).toContain("2 linkers");
  expect(card.command).toBe(
    `cat ${c.cgroupRoot}/agents.slice/510341.scope/io.stat`,
  );
  expect(card.danger).toBe(true);
});

test("a swapped desktop card names the holder and the agent page cache", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.groups = [
    groupSnapshot({
      path: "app.slice",
      name: c.desktopSlice,
      swap: c.swapFloor + 1,
    }),
    groupSnapshot({
      path: "app.slice/shell.scope",
      name: "shell.scope",
      swap: 999,
    }),
    groupSnapshot({
      path: "agents.slice",
      name: c.agentSlice,
      cache: 85899345920,
    }),
  ];
  const card = attention(s, c, base).find((item) => item.id === "desktop-swap");
  if (!card) throw new Error("Expected a desktop swap card");
  expect(card.detail).toContain("shell.scope");
  expect(card.detail).toContain("80.0 GiB");
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
  const volume = (mount: string) => ({
    mount,
    device: "/dev/x",
    fsid: mount,
    options: [],
    readOnly: true,
    free: 0,
    total: 1,
    errors: {},
    delta: { "x/corruption_errs": 1 },
    sinceStart: {},
  });
  s.storage.volumes = [volume("/a"), volume("/b")];
  const items = attention(s, c, base);
  expect(items.filter((item) => item.id === "read-only")).toHaveLength(1);
  expect(items.filter((item) => item.id === "device-errors")).toHaveLength(1);
  expect(items.find((item) => item.id === "read-only")?.title).toContain(
    "/a, /b",
  );
});
