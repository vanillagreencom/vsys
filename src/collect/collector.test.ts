import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "../config/config";
import { launcherTrail } from "../model/launcher";
import type { Proc } from "../model/types";
import { fixture } from "../test/fixture";
import { buildKind, toolName } from "./builds";
import { Collector } from "./collector";
import { parseStat } from "./procs";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
const setup = () => {
  const f = fixture();
  fixtures.push(f);
  return f;
};

test("scope CPU, memory, environment and process identity survive sampling", async () => {
  const f = setup();
  f.group("agents.slice/run-lane.scope", [40]);
  f.proc(40, "agents.slice/run-lane.scope", {
    env: "CLAUDE_CONFIG_DIR=/accounts/work\0SECRET=hidden\0TMPDIR=/tmp/lane\0",
    ticks: 10,
  });
  const collector = new Collector(f.config, 100, 4096);
  const a = await collector.sample(1000);
  expect(a.errors).toEqual([]);
  expect(a.lanes[0].account).toBe("work");
  expect(a.procs[0].env).toEqual({
    CLAUDE_CONFIG_DIR: "/accounts/work",
    TMPDIR: "/tmp/lane",
  });
  expect(a.lanes[0].cpu).toBeNull();
  f.proc(40, "agents.slice/run-lane.scope", {
    ticks: 60,
    env: "CLAUDE_CONFIG_DIR=/accounts/changed\0",
  });
  f.write(
    join(f.config.cgroupRoot, "agents.slice/run-lane.scope/cpu.stat"),
    "usage_usec 501000",
  );
  const b = await collector.sample(2000);
  expect(b.lanes[0].cpu).toBe(50);
  expect(b.procs[0].cpuPercent).toBe(50);
  expect(b.lanes[0].rss).toBe(40960);
  expect(b.lanes[0].account).toBe("work");
  f.proc(40, "agents.slice/run-lane.scope", {
    start: 500,
    ticks: 1,
    env: "CLAUDE_CONFIG_DIR=/accounts/new\0",
  });
  const reused = await collector.sample(3000);
  expect(reused.procs[0].cpuPercent).toBeNull();
  expect(reused.lanes[0].account).toBe("new");
});
test("environment is collected for scope mains and agents, not other children", async () => {
  const f = setup();
  f.group("agents.slice/a.scope", [40, 41, 42]);
  f.proc(40, "agents.slice/a.scope");
  f.proc(41, "agents.slice/a.scope", {
    command: ["/bin/cat"],
    comm: "cat",
    env: "TMPDIR=/private\0",
    parent: 40,
  });
  // The launcher trail needs the agent's own caps, so an agent child is read.
  f.proc(42, "agents.slice/a.scope", { env: "TMPDIR=/agent\0", parent: 40 });
  const s = await new Collector(f.config, 100, 4096).sample();
  expect(s.procs.find((p) => p.pid === 41)?.env).toEqual({});
  expect(s.procs.find((p) => p.pid === 42)?.env).toEqual({ TMPDIR: "/agent" });
});
test("a scope wrapper owns launch metadata even when an agent is its child", async () => {
  const f = setup();
  f.group("agents.slice/a.scope", [40, 41]);
  f.proc(40, "agents.slice/a.scope", {
    command: ["/bin/bash", "launch.sh"],
    comm: "bash",
    env: "CLAUDE_CONFIG_DIR=/accounts/work\0",
  });
  f.proc(41, "agents.slice/a.scope", {
    command: ["/usr/bin/claude"],
    parent: 40,
  });
  const s = await new Collector(f.config, 100, 4096).sample();
  expect(s.lanes[0].mainPid).toBe(40);
  expect(s.lanes[0].account).toBe("work");
  expect(s.lanes[0].tool).toBe("claude");
});
test("launch commands preserve empty arguments", async () => {
  const f = setup();
  f.proc(40, "app.slice/a.scope", {
    command: ["/bin/bash", "launch.sh", ""],
    comm: "bash",
  });
  const s = await new Collector(f.config, 100, 4096).sample();
  expect(s.procs[0].command).toEqual(["/bin/bash", "launch.sh", ""]);
});
test("cgroup membership comes from the scope list when its mount root is known", async () => {
  const f = setup();
  f.group("agents.slice/a.scope", [40]);
  f.proc(40, "agents.slice/a.scope");
  f.write(
    join(f.config.procRoot, "40/cgroup"),
    "redundant read must not be used",
  );
  const s = await new Collector(f.config, 100, 4096).sample();
  expect(s.errors).toEqual([]);
  expect(s.procs[0].group).toBe(
    "/user.slice/user-1000.slice/user@1000.service/agents.slice/a.scope",
  );
});
test("ambiguous scope membership uses the process membership file", async () => {
  const f = setup();
  f.group("app.slice/a.scope", [40]);
  f.group("agents.slice/a.scope", [40]);
  f.proc(40, "agents.slice/a.scope");
  const s = await new Collector(f.config, 100, 4096).sample();
  expect(s.procs[0].group).toBe(
    "/user.slice/user-1000.slice/user@1000.service/agents.slice/a.scope",
  );
  expect(s.lanes.find((l) => l.id === "app.slice/a.scope")?.pids).toEqual([]);
  expect(s.lanes.find((l) => l.id === "agents.slice/a.scope")?.pids).toEqual([
    40,
  ]);
});
test("escaped agent and inherited dangerous cap appear as separate rule hits", async () => {
  const f = setup();
  f.group("app.slice/run-escape.scope", [40]);
  f.proc(40, "app.slice/run-escape.scope");
  f.write(join(f.config.cgroupRoot, "app.slice/memory.max"), "5242880");
  const s = await new Collector(f.config, 100, 4096).sample();
  expect(s.lanes[0].unconfined).toBe(true);
  expect(s.lanes[0].dangerous).toBe(true);
  expect(s.alerts.map((a) => a.rule).sort()).toEqual([
    "memory-cap",
    "unconfined",
  ]);
});
test("process outside the configured root remains visible", async () => {
  const f = setup();
  f.proc(80, "background.slice/a.service");
  const s = await new Collector(f.config, 100, 4096).sample();
  expect(s.lanes[0].pids).toEqual([80]);
  expect(s.lanes[0].unconfined).toBe(true);
});
test("a dangerous scope in an unwatched slice remains visible", async () => {
  const f = setup();
  f.group("background.slice");
  f.group("background.slice/run-small.scope", [40]);
  f.proc(40, "background.slice/run-small.scope", {
    command: ["/usr/bin/worker"],
    comm: "worker",
  });
  f.write(
    join(f.config.cgroupRoot, "background.slice/run-small.scope/memory.max"),
    "5242880",
  );
  const s = await new Collector(f.config, 100, 4096).sample();
  expect(
    s.lanes.find((l) => l.id === "background.slice/run-small.scope")?.dangerous,
  ).toBe(true);
  expect(s.alerts.map((a) => a.rule)).toEqual(["memory-cap"]);
});
test("invalid source is an error and cannot become zero usage", async () => {
  const f = setup();
  f.write(
    join(f.config.cgroupRoot, "agents.slice/cpu.stat"),
    "usage_usec nope",
  );
  const s = await new Collector(f.config, 100, 4096).sample();
  expect(
    s.errors.some(
      (e) => e.source === join(f.config.cgroupRoot, "agents.slice"),
    ),
  ).toBe(true);
  expect(s.groups.find((g) => g.path === "agents.slice")).toBeUndefined();
});
test("zram symlinks under sys block expose compression stats", async () => {
  const f = setup();
  const target = join(f.root, "devices/zram0");
  mkdirSync(target, { recursive: true });
  f.write(join(target, "mm_stat"), "1000 500 600 0 0 0 0");
  symlinkSync(target, join(f.config.sysBlockRoot, "zram0"));
  const s = await new Collector(f.config, 100, 4096).sample();
  expect(s.system.zram).toEqual([
    { device: "zram0", original: 1000, compressed: 500, used: 600 },
  ]);
});
test("build and agent classification does not match prompt arguments", () => {
  for (const [command, expected] of [
    [["/usr/bin/rustc"], "rustc"],
    [["/usr/bin/ld.mold", "-o", "app"], "ld.mold"],
    [["/repo/target/debug/deps/suite-abc123"], "test"],
    [["node", "/bin/tsc"], "node"],
    [["bun", "build"], "bun"],
    [["claude", "please build"], null],
    [["node", "server.js"], null],
    [["node", "server.js", "build"], null],
  ] as const)
    expect(buildKind(command[0], [...command], defaults().linkerNames)).toBe(
      expected,
    );
  // The linker list is configuration, so an empty list classifies no linker.
  expect(buildKind("ld.mold", ["/usr/bin/ld.mold"], [])).toBeNull();
  expect(toolName("bash", ["bash", "-c", "claude"], ["claude"])).toBeNull();
  expect(toolName("node", ["node", "/bin/codex.js"], ["codex"])).toBe("codex");
});
test("stat parser handles a closing parenthesis in comm", () => {
  const fields = Array.from({ length: 22 }, () => "0");
  fields[0] = "S";
  fields[17] = "65";
  expect(parseStat(`12 (a ) b) ${fields.join(" ")}`).threads).toBe(65);
  expect(() => parseStat("broken")).toThrow();
});
test("branch naming follows a linked worktree and does not hide a broken gitdir", async () => {
  const f = setup();
  const cwd = join(f.root, "repo/worktree");
  f.write(join(f.root, "repo/.git/HEAD"), "ref: refs/heads/parent\n");
  f.write(join(cwd, ".git"), "gitdir: ../.git/worktrees/lane\n");
  f.write(
    join(f.root, "repo/.git/worktrees/lane/HEAD"),
    "ref: refs/heads/feature/lane\n",
  );
  f.config.laneNaming = "branch";
  f.group("agents.slice/a.scope", [40]);
  f.proc(40, "agents.slice/a.scope", { cwd });
  const collector = new Collector(f.config, 100, 4096);
  expect((await collector.sample(1000)).lanes[0].name).toBe(
    "default claude feature/lane",
  );
  rmSync(join(f.root, "repo/.git/worktrees/lane/HEAD"));
  const broken = await collector.sample(2000);
  expect(broken.procs[0].branch).toBeNull();
  expect(broken.errors.length).toBeGreaterThan(0);
});
test("an unreadable environment is not labelled as the default account", async () => {
  const f = setup();
  f.group("agents.slice/a.scope", [40]);
  f.proc(40, "agents.slice/a.scope");
  rmSync(join(f.config.procRoot, "40/environ"));
  mkdirSync(join(f.config.procRoot, "40/environ"));
  const s = await new Collector(f.config, 100, 4096).sample();
  expect(s.lanes[0].account).toBeNull();
  expect(s.procs[0].envAvailable).toBe(false);
});
test("io.stat and memory.stat give byte totals, write rates and page cache", async () => {
  const f = setup();
  f.group("agents.slice/a.scope", [40]);
  f.proc(40, "agents.slice/a.scope");
  const path = join(f.config.cgroupRoot, "agents.slice/a.scope");
  f.write(
    join(path, "io.stat"),
    "259:0 rbytes=100 wbytes=200\n8:0 rbytes=1 wbytes=2\n",
  );
  f.write(join(path, "memory.stat"), "anon 5\nfile 4096\nslab 1\n");
  const collector = new Collector(f.config, 100, 4096);
  const a = await collector.sample(1000);
  const first = a.groups.find((g) => g.path === "agents.slice/a.scope");
  expect(first).toMatchObject({ ioRead: 101, ioWrite: 202, cache: 4096 });
  // The first sample has no earlier counter, so a rate is unknown, not zero.
  expect(first?.writeRate).toBeNull();
  f.write(
    join(path, "io.stat"),
    "259:0 rbytes=100 wbytes=1200\n8:0 rbytes=1 wbytes=2\n",
  );
  const b = await collector.sample(2000);
  const second = b.groups.find((g) => g.path === "agents.slice/a.scope");
  expect(second?.writeRate).toBe(1000);
  expect(second?.readRate).toBe(0);
  // An unreadable or invalid counter stays unknown, never a measured zero.
  f.write(join(path, "io.stat"), "259:0 rbytes=x wbytes=200\n");
  rmSync(join(path, "memory.stat"));
  const bad = await collector.sample(3000);
  const group = bad.groups.find((g) => g.path === "agents.slice/a.scope");
  expect(group?.ioWrite).toBeNull();
  expect(group?.cache).toBeNull();
  expect(bad.errors.map((e) => e.source)).toContain(join(path, "io.stat"));
});
test("argv exclusion hides a helper process but never an agent lane", async () => {
  const f = setup();
  f.proc(39, "app.slice/chrome.scope", {
    command: ["/usr/bin/claude", "--chrome-native-host"],
  });
  f.proc(40, "app.slice/pane.scope", {
    command: [
      "/usr/bin/claude",
      "-p",
      "fix the typescript-language-server config",
      "rust-analyzer",
    ],
  });
  const a = await new Collector(f.config, 100, 4096).sample();
  // The host is excluded; prompt text naming a pattern never excludes.
  expect(a.procs.find((p) => p.pid === 39)?.tool).toBeNull();
  expect(a.procs.find((p) => p.pid === 40)?.tool).toBe("claude");
  expect(a.lanes).toHaveLength(1);
  expect(a.lanes[0].id).toEndWith("app.slice/pane.scope");
  expect(a.alerts.map((x) => x.subject)).toEqual(["40:100:claude"]);
  // The pattern list is configuration, so a different flag excludes instead.
  f.config.excludeArgv = ["--headless"];
  f.proc(41, "app.slice/b.scope", {
    command: ["/usr/bin/claude", "--headless"],
  });
  const b = await new Collector(f.config, 100, 4096).sample();
  expect(b.procs.find((p) => p.pid === 41)?.tool).toBeNull();
  expect(b.procs.find((p) => p.pid === 39)?.tool).toBe("claude");
});
test("an escaped agent's own environment reaches the launcher trail", async () => {
  const f = setup();
  f.group("app.slice/tmux-spawn-4.scope", [50, 51]);
  f.proc(50, "app.slice/tmux-spawn-4.scope", {
    command: ["/bin/bash"],
    comm: "bash",
  });
  f.proc(51, "app.slice/tmux-spawn-4.scope", {
    parent: 50,
    env: "CARGO_BUILD_JOBS=16\0PATH=/shadow/bin:/usr/bin\0",
  });
  const s = await new Collector(f.config, 100, 4096).sample();
  // The agent, not the pane shell, is what makes the lane unconfined.
  expect(s.procs.find((p) => p.pid === 50)?.tool).toBeNull();
  expect(s.lanes.map((l) => l.unconfined)).toEqual([true]);
  const agent = s.procs.find((p) => p.pid === 51);
  expect(agent?.env).toEqual({
    CARGO_BUILD_JOBS: "16",
    PATH: "/shadow/bin:/usr/bin",
  });
  const trail = launcherTrail(agent as Proc, s.procs, f.config, ["/usr/bin"]);
  expect(trail.conclusion).toBe("shadowed");
  expect(trail.summary).toContain("/shadow/bin");
});
