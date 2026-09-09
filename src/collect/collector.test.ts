import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
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
test("only scope main process environment is collected", async () => {
  const f = setup();
  f.group("agents.slice/a.scope", [40, 41]);
  f.proc(40, "agents.slice/a.scope");
  f.proc(41, "agents.slice/a.scope", { env: "TMPDIR=/private\0", parent: 40 });
  const s = await new Collector(f.config, 100, 4096).sample();
  expect(s.procs.find((p) => p.pid === 41)?.env).toEqual({});
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
    [["/repo/target/debug/deps/suite-abc123"], "test"],
    [["node", "/bin/tsc"], "node"],
    [["bun", "build"], "bun"],
    [["claude", "please build"], null],
    [["node", "server.js"], null],
  ] as const)
    expect(buildKind(command[0], [...command])).toBe(expected);
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
  expect((await collector.sample(1000)).lanes[0].name).toBe("feature/lane");
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
  expect(s.lanes[0].account).toBe("?");
  expect(s.procs[0].envAvailable).toBe(false);
});
