import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadAgentTools, parseAgentToolsDocument } from "../config/agent-tools";
import { defaults } from "../config/config";
import { sampleSummary } from "../main";
import { bypassedLanes, jobservers } from "../model/builds";
import { launcherCopy, launcherTrail } from "../model/launcher";
import { laneText } from "../model/naming";
import type { Proc, Snapshot } from "../model/types";
import { causes, meters } from "../model/verdict";
import { point } from "../store/point";
import { claudeLink, fixture } from "../test/fixture";
import { capabilityLine } from "../ui/settings";
import { buildKind, excludedArgv, toolSignals } from "./builds";
import { Collector, createCollector } from "./collector";
import { KernelLog } from "./kernel-log";
import { ProcessCollector, parseStat } from "./procs";
import { SccacheCollector } from "./sccache";
import { ScratchCollector } from "./scratch";

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
test("summary sampling does not call the scratch collector", async () => {
  const f = setup();
  f.config.scratchDirs = [join(f.root, "scratch")];
  const original = ScratchCollector.prototype.collect;
  let calls = 0;
  ScratchCollector.prototype.collect = async function (
    ...args: Parameters<ScratchCollector["collect"]>
  ): ReturnType<ScratchCollector["collect"]> {
    calls++;
    return original.apply(this, args);
  };
  try {
    const summary = await new Collector(f.config, 100, 4096).sample(
      1000,
      undefined,
      { skipScratch: true },
    );
    expect(calls).toBe(0);
    expect(summary.storage).toMatchObject({
      scratch: [],
      sessions: [],
      scratchTime: null,
      scratchPending: false,
    });
    await new Collector(f.config, 100, 4096).sample(2000);
    expect(calls).toBe(1);
  } finally {
    ScratchCollector.prototype.collect = original;
  }
});
test("a running agent's temporary directory is measured as scratch it was found on", async () => {
  const f = setup();
  const tmp = join(f.root, "agent-tmp");
  f.write(join(tmp, "session/file"), "1234");
  f.group("agents.slice/a.scope", [40]);
  f.proc(40, "agents.slice/a.scope", { env: `TMPDIR=${tmp}\0` });
  const collector = new Collector(f.config, 100, 4096);
  try {
    const s = await collector.sample(1000);
    expect(s.errors).toEqual([]);
    expect(
      s.storage.scratch.map(({ path, origin, error }) => ({
        path,
        origin,
        error,
      })),
    ).toEqual([{ path: tmp, origin: "agent", error: null }]);
    expect(s.storage.sessions.map((x) => x.path)).toEqual([
      join(tmp, "session"),
    ]);
  } finally {
    collector.close();
  }
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
    command: [claudeLink],
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
test("an agent is escaped only on a machine that has the agent slice", async () => {
  // Two agent CLIs, one in a watched slice and one in a slice nothing
  // watches. Where the slice exists both run outside it; where it does not,
  // both are still lanes, measured by their own scopes.
  const rows = [
    {
      slice: "present",
      unconfined: [true, true],
      cause: true,
      escaped: 2,
      agents: 0,
      // The slice's own page cache, which the fixture writes for every group.
      cache: 4000,
      line: "Agent slice: available",
    },
    {
      slice: "absent",
      unconfined: [false, false],
      cause: false,
      escaped: 0,
      agents: 30,
      // Each agent scope's own page cache.
      cache: 8000,
      line: "Agent slice: not available: no agent slice is defined or running",
    },
  ];
  for (const row of rows) {
    const f = setup();
    if (row.slice === "absent")
      rmSync(join(f.config.cgroupRoot, "agents.slice"), { recursive: true });
    f.group("background.slice");
    const scopes = [
      [40, "app.slice/run-a.scope", 201000],
      [41, "background.slice/run-b.scope", 101000],
    ] as const;
    for (const [pid, scope] of scopes) {
      f.group(scope, [pid]);
      f.proc(pid, scope);
    }
    const collector = new Collector(f.config, 100, 4096);
    // An alert opens on the first sample that shows its rule and only then.
    const first = await collector.sample(1000);
    for (const [, scope, usage] of scopes)
      f.write(
        join(f.config.cgroupRoot, scope, "cpu.stat"),
        `usage_usec ${usage}`,
      );
    const s = await collector.sample(2000);
    const slice = s.capabilities.find((cap) => cap.id === "agent-slice");
    if (!slice) throw new Error("agent-slice: no capability in the sample");
    expect({
      slice: row.slice,
      errors: s.errors,
      // The collector keeps the order the filesystem lists directories in,
      // which differs between hosts, so lanes are compared by id.
      lanes: s.lanes
        .toSorted((a, b) => a.id.localeCompare(b.id))
        .map((l) => [l.id, l.unconfined]),
      cause: causes(s, f.config).some((x) => x.id === "unconfined"),
      alert: first.alerts.some((a) => a.rule === "unconfined"),
      agents: meters(s, f.config).find((m) => m.id === "cpu")?.values.agents,
      cache: meters(s, f.config).find((m) => m.id === "memory")?.values.cache,
      // What the history keeps for the sample says the same.
      stored: [point(s, f.config).unconfined, point(s, f.config).agents],
      line: capabilityLine(slice).startsWith(row.line),
      source: slice.source,
    }).toEqual({
      slice: row.slice,
      errors: [],
      lanes: [
        ["app.slice/run-a.scope", row.unconfined[0]],
        ["background.slice/run-b.scope", row.unconfined[1]],
      ],
      cause: row.cause,
      alert: row.cause,
      agents: row.agents,
      cache: row.cache,
      stored: [row.escaped, row.agents],
      line: true,
      source: join(f.config.cgroupRoot, "agents.slice"),
    });
  }
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
test("build classification does not match prompt arguments", () => {
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
    expect(
      buildKind(
        command[0],
        [...command],
        defaults().compilerNames,
        defaults().linkerNames,
      ),
    ).toBe(expected);
  // Both name lists are configuration, so an empty list classifies nothing.
  expect(
    buildKind("ld.mold", ["/usr/bin/ld.mold"], defaults().compilerNames, []),
  ).toBeNull();
  expect(
    buildKind("rustc", ["/usr/bin/rustc"], [], defaults().linkerNames),
  ).toBeNull();
});
/**
 * A world of agent-tool data, and the processes one collector reads in it.
 * Each row is a process, the tool it must read as and the configured name it
 * carries that no install location confirmed. `exe: null` leaves the
 * executable link out and `cwd: null` the working directory link, as for a
 * process vsys may not read; `cwd` is otherwise under the fixture root.
 * `link` makes a real symbolic link under the root, as a package manager's
 * launcher on PATH is, and `file` a real script.
 */
async function toolWorld(
  overlay: string | object | null,
  rows: {
    pid: number;
    comm: string;
    command: (root: string) => string[];
    exe?: string | null;
    cwd?: string | null;
    link?: [from: string, to: string];
    file?: string;
    tool: string | null;
    unconfirmed?: string;
  }[],
) {
  const f = setup();
  if (overlay !== null && typeof overlay === "object")
    f.write(f.agentToolsPath, JSON.stringify(overlay));
  const tools = await loadAgentTools(
    typeof overlay === "string"
      ? overlay
      : overlay === null
        ? join(f.root, "absent.json")
        : f.agentToolsPath,
  );
  f.config.agentTools = tools.tools.map((tool) => tool.name);
  for (const row of rows) {
    if (row.link) {
      f.write(join(f.root, row.link[1]), "#!/usr/bin/env node\n");
      mkdirSync(dirname(join(f.root, row.link[0])), { recursive: true });
      symlinkSync(join(f.root, row.link[1]), join(f.root, row.link[0]));
    }
    if (row.file) f.write(join(f.root, row.file), "#!/bin/sh\n");
    const command = row.command(f.root);
    const cwd = row.cwd ? join(f.root, row.cwd) : f.root;
    mkdirSync(cwd, { recursive: true });
    f.proc(row.pid, `app.slice/tmux-spawn-${row.pid}.scope`, {
      comm: row.comm,
      command,
      exe: row.exe ?? command[0],
      cwd,
    });
    const proc = join(f.config.procRoot, String(row.pid));
    if (row.exe === null) rmSync(join(proc, "exe"));
    if (row.cwd === null) rmSync(join(proc, "cwd"));
  }
  const reading = new ProcessCollector(f.config, 100, 4096, tools).read({
    time: 1000,
    uptime: 1000,
    groups: [],
  });
  expect(reading.errors).toEqual([]);
  expect(
    Object.fromEntries(
      reading.procs.map((p) => [p.pid, [p.tool, p.unconfirmedTool]]),
    ),
  ).toEqual(
    Object.fromEntries(
      rows.map((row) => [row.pid, [row.tool, row.unconfirmed ?? null]]),
    ),
  );
  const collector = new Collector(
    f.config,
    100,
    4096,
    false,
    undefined,
    undefined,
    new ProcessCollector(f.config, 100, 4096, tools),
  );
  return (await collector.sample(1000)).lanes.map((l) => basename(l.id));
}
const home = "/home/reader";
const mise = `${home}/.local/share/mise/installs`;
test("a shipped agent CLI is recognised through its install shapes, and a name alone never is", async () => {
  // Control: confirming every name whatever its path turns the unconfirmed
  // rows red; resolving no launcher link, or a relative script against
  // vsys's own directory, turns the linked and relative rows red; matching an
  // exact executable as a fragment turns the chroot row red.
  await toolWorld(null, [
    // Native binaries: the executable lies where the tool installs itself.
    {
      pid: 10,
      comm: "claude",
      command: () => [`${home}/.local/bin/claude`],
      exe: `${home}/.local/share/claude/versions/2.1.0`,
      tool: "claude",
    },
    {
      pid: 11,
      comm: "claude",
      command: () => ["/usr/bin/claude"],
      exe: "/usr/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude",
      tool: "claude",
    },
    {
      pid: 12,
      comm: "codex",
      command: () => [
        "/usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex",
      ],
      tool: "codex",
    },
    {
      pid: 13,
      comm: "codex",
      command: () => [
        `${home}/.codex/packages/app-server-daemon/releases/0.160.0-x86_64-unknown-linux-musl/bin/codex`,
        "app-server",
      ],
      tool: "codex",
    },
    {
      pid: 14,
      comm: "opencode",
      command: () => [`${home}/.opencode/bin/opencode`],
      tool: "opencode",
    },
    {
      pid: 15,
      comm: "crush",
      command: () => ["/usr/lib/node_modules/@charmland/crush/bin/crush"],
      tool: "crush",
    },
    {
      pid: 16,
      comm: "node",
      command: () => [
        `${home}/.local/bin/cursor-agent`,
        "--use-system-ca",
        "index.js",
      ],
      exe: `${home}/.local/share/cursor-agent/versions/2026.09.28-64d2043/node`,
      tool: "cursor-agent",
    },
    // Distribution packages: Arch's openai-codex, and packages that install
    // straight into /usr/bin.
    {
      pid: 17,
      comm: "codex",
      command: () => ["/usr/bin/codex"],
      exe: "/usr/lib/openai-codex/bin/codex",
      tool: "codex",
    },
    {
      pid: 18,
      comm: "opencode",
      command: () => ["/usr/bin/opencode"],
      tool: "opencode",
    },
    {
      pid: 19,
      comm: "crush",
      command: () => ["/usr/bin/crush"],
      tool: "crush",
    },
    // The engine Claude Desktop's Code tab downloads.
    {
      pid: 20,
      comm: "claude",
      command: () => [`${home}/.config/Claude/claude-code/2.1.260/claude`],
      tool: "claude",
    },
    // A version manager's install, reached through its `latest` link.
    {
      pid: 21,
      comm: "MainThread",
      command: () => [`${mise}/copilot/latest/copilot`],
      exe: `${mise}/copilot/1.0.90/copilot`,
      tool: "copilot",
    },
    {
      pid: 22,
      comm: "pi",
      command: () => [`${mise}/pi/latest/pi/pi`],
      exe: `${mise}/pi/0.99.2/pi/pi`,
      tool: "pi",
    },
    {
      pid: 23,
      comm: "antigravity",
      command: () => [
        `${mise}/aqua-google-antigravity-antigravity-cli/latest/antigravity`,
      ],
      tool: "antigravity",
    },
    // Node packages: the script lies in the tool's package directory, named
    // directly, through the launcher link npm puts on PATH, or relative to
    // the process's own working directory.
    {
      pid: 24,
      comm: "node",
      command: () => [
        "node",
        "/usr/lib/node_modules/@openai/codex/bin/codex.js",
      ],
      exe: "/usr/bin/node",
      tool: "codex",
    },
    {
      pid: 25,
      comm: "node",
      command: () => ["node", `${mise}/npm-xai-official-grok/latest/bin/grok`],
      exe: "/usr/bin/node",
      tool: "grok",
    },
    {
      pid: 26,
      comm: "node",
      command: (root) => ["node", join(root, "usr/bin/gemini")],
      exe: "/usr/bin/node",
      link: [
        "usr/bin/gemini",
        "usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js",
      ],
      tool: "gemini",
    },
    {
      pid: 27,
      comm: "node",
      command: (root) => ["node", join(root, "usr/bin/pi")],
      exe: "/usr/bin/node",
      link: [
        "usr/bin/pi",
        "usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      ],
      tool: "pi",
    },
    {
      pid: 28,
      comm: "node",
      command: (root) => ["node", join(root, "usr/bin/copilot")],
      exe: "/usr/bin/node",
      link: [
        "usr/bin/copilot",
        "usr/lib/node_modules/@github/copilot/npm-loader.js",
      ],
      tool: "copilot",
    },
    {
      pid: 29,
      comm: "node",
      command: () => ["node", "bundle/gemini.js"],
      exe: "/usr/bin/node",
      cwd: "usr/local/lib/node_modules/@google/gemini-cli",
      tool: "gemini",
    },
    // Pi after it set its process title: Node erased the script argument.
    {
      pid: 30,
      comm: "pi",
      command: () => ["pi", "", ""],
      exe: "/usr/bin/node",
      tool: "pi",
    },
    // An engine a desktop app bundles.
    {
      pid: 31,
      comm: "codex",
      command: () => ["/opt/codex-desktop/resources/codex", "exec"],
      tool: "codex",
    },
    // A path vsys could not read keeps the name.
    {
      pid: 32,
      comm: "bash",
      command: () => ["bash", "pi.sh"],
      exe: "/usr/bin/bash",
      cwd: null,
      tool: "pi",
    },
    {
      pid: 33,
      comm: "codex",
      command: () => ["/usr/local/bin/codex"],
      exe: null,
      tool: "codex",
    },
    // A name alone: anyone's script or program.
    {
      pid: 40,
      comm: "bash",
      command: () => ["bash", "pi.sh"],
      exe: "/usr/bin/bash",
      file: "pi.sh",
      tool: null,
      unconfirmed: "pi",
    },
    {
      pid: 41,
      comm: "python3",
      command: () => ["python3", `${home}/bin/pi.py`],
      exe: "/usr/bin/python3.14",
      tool: null,
      unconfirmed: "pi",
    },
    {
      pid: 42,
      comm: "pi",
      command: () => ["/bin/bash", `${home}/bin/pi`],
      exe: "/usr/bin/bash",
      tool: null,
      unconfirmed: "pi",
    },
    {
      pid: 43,
      comm: "pi",
      command: () => ["/usr/local/bin/pi"],
      tool: null,
      unconfirmed: "pi",
    },
    {
      pid: 44,
      comm: "pi",
      command: () => ["pi", `${home}/pi.js`],
      exe: "/usr/bin/node",
      tool: null,
      unconfirmed: "pi",
    },
    {
      pid: 45,
      comm: "node",
      command: (root) => ["node", join(root, "bin/codex")],
      exe: "/usr/bin/node",
      link: ["bin/codex", "src/codex.js"],
      tool: null,
      unconfirmed: "codex",
    },
    {
      pid: 46,
      comm: "codex",
      command: () => ["/usr/local/bin/codex"],
      tool: null,
      unconfirmed: "codex",
    },
    {
      pid: 47,
      comm: "opencode",
      command: () => ["/srv/chroot/usr/bin/opencode"],
      tool: null,
      unconfirmed: "opencode",
    },
    {
      pid: 48,
      comm: "bash",
      command: () => ["bash", "-c", "claude"],
      exe: "/usr/bin/bash",
      tool: null,
    },
    // Each conjunct of the retitle and script rules, alone.
    {
      pid: 49,
      comm: "pi",
      command: () => ["pi"],
      exe: "/usr/local/bin/pi",
      tool: null,
      unconfirmed: "pi",
    },
    {
      pid: 50,
      comm: "pi",
      command: () => ["node", "", ""],
      exe: "/usr/bin/node",
      tool: null,
      unconfirmed: "pi",
    },
    {
      pid: 51,
      comm: "cat",
      command: () => [
        "cat",
        "/usr/lib/node_modules/@openai/codex/bin/codex.js",
      ],
      exe: "/usr/bin/cat",
      tool: null,
    },
    {
      pid: 52,
      comm: "node",
      command: () => ["node", "/srv/app/server.js"],
      exe: "/usr/bin/node",
      tool: null,
    },
    // A package under a desktop prefix: the claude-code directory every
    // Claude Code install shares names it; nothing names the codex one.
    {
      pid: 53,
      comm: "claude",
      command: () => ["/usr/bin/claude"],
      exe: "/opt/claude-code/bin/claude",
      tool: "claude",
    },
    {
      pid: 54,
      comm: "codex",
      command: () => ["/usr/bin/codex"],
      exe: "/opt/codex-cli/bin/codex",
      tool: null,
    },
  ]);
});
test("an overlay entry naming a shipped tool adds where this machine installed it", async () => {
  await toolWorld(
    {
      version: 1,
      tools: [
        {
          name: "codex",
          paths: ["/opt/codex-cli/"],
          executables: ["/usr/local/bin/codex"],
        },
      ],
    },
    [
      // A location the reader adds outranks the desktop prefix around it.
      {
        pid: 13,
        comm: "codex",
        command: () => ["/usr/bin/codex"],
        exe: "/opt/codex-cli/bin/codex",
        tool: "codex",
      },
      {
        pid: 10,
        comm: "codex",
        command: () => ["/usr/local/bin/codex"],
        tool: "codex",
      },
      {
        pid: 11,
        comm: "codex",
        command: () => [
          "/usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex",
        ],
        tool: "codex",
      },
      {
        pid: 12,
        comm: "codex",
        command: () => ["/opt/bin/codex-old"],
        exe: "/srv/codex",
        tool: null,
        unconfirmed: "codex",
      },
    ],
  );
});
test("tool signals are each tool's paths, version manager directories and executables", () => {
  expect(
    toolSignals(
      parseAgentToolsDocument({
        version: 1,
        tools: [
          {
            name: "a",
            mise: ["a-dir"],
            paths: ["/node_modules/a/"],
            executables: ["/usr/bin/a"],
          },
          { name: "b" },
        ],
        desktopExePrefixes: ["/apps/"],
        bundledCliSuffixes: ["/apps/a"],
      }),
    ),
  ).toEqual({
    installs: new Map([
      [
        "a",
        {
          fragments: ["/node_modules/a/", "/installs/a-dir/"],
          executables: ["/usr/bin/a"],
        },
      ],
      ["b", { fragments: [], executables: [] }],
    ]),
    desktop: {
      desktopExePrefixes: ["/apps/"],
      bundledCliSuffixes: ["/apps/a"],
    },
  });
});
test("the owner's machine keeps every agent it ran, and its local names gain no false lanes", async () => {
  // The owner runs vsys with no config.toml, the repository's owner overlay,
  // and every agent CLI installed by mise and launched through one shim, as
  // these rows reproduce.
  const owner = join(process.cwd(), "data/owner-agent-tools.json");
  await toolWorld(owner, [
    {
      pid: 10,
      comm: "claude",
      command: () => [`${mise}/claude/latest/claude`, "--model", "opus"],
      exe: `${mise}/claude/2.1.286/claude`,
      tool: "claude",
    },
    {
      pid: 11,
      comm: "codex",
      command: () => [`${mise}/codex/latest/bin/codex`],
      exe: `${mise}/codex/0.159.3/bin/codex`,
      tool: "codex",
    },
    {
      pid: 12,
      comm: "codex",
      command: () => [
        `${home}/.codex/packages/app-server-daemon/releases/0.160.0-x86_64-unknown-linux-musl/bin/codex`,
        "app-server",
        "daemon",
      ],
      tool: "codex",
    },
    {
      pid: 13,
      comm: "MainThread",
      command: () => [
        `${mise}/copilot/latest/copilot`,
        "--disable-builtin-mcps",
      ],
      exe: `${mise}/copilot/1.0.90/copilot`,
      tool: "copilot",
    },
    {
      pid: 14,
      comm: "node",
      command: () => ["node", `${mise}/gemini/latest/bin/gemini`],
      exe: `${mise}/node/24.20.0/bin/node`,
      tool: "gemini",
    },
    {
      pid: 15,
      comm: "node",
      command: () => ["node", `${mise}/npm-deepseek-ai-dsh/0.2.0-rc.2/bin/dsh`],
      exe: `${mise}/node/24.20.0/bin/node`,
      tool: "dsh",
    },
    {
      pid: 16,
      comm: "agy",
      command: () => [
        `${mise}/aqua-google-antigravity-antigravity-cli/latest/agy`,
      ],
      exe: `${mise}/aqua-google-antigravity-antigravity-cli/1.2.14/antigravity`,
      tool: "agy",
    },
    {
      pid: 17,
      comm: "omp",
      command: () => [`${mise}/github-can1357-oh-my-pi/latest/omp`],
      exe: `${mise}/github-can1357-oh-my-pi/18.4.8/omp`,
      tool: "omp",
    },
    {
      pid: 18,
      comm: "ori",
      command: () => [
        `${mise}/github-open-router-labs-ori-releases/cli-latest/ori`,
      ],
      exe: `${mise}/github-open-router-labs-ori-releases/cli-0.15.5-74c4cf2/ori`,
      tool: "ori",
    },
    {
      pid: 19,
      comm: "fx",
      command: () => [`${mise}/github-vercel-labs-fx/latest/fx`],
      exe: `${mise}/github-vercel-labs-fx/0.0.12/fx`,
      tool: "fx",
    },
    {
      pid: 20,
      comm: "node",
      command: () => [
        `${mise}/cursor-agent/latest/dist-package/cursor-agent`,
        "--use-system-ca",
        "index.js",
      ],
      exe: `${mise}/cursor-agent/2026.09.28-64d2043/dist-package/node`,
      tool: "cursor-agent",
    },
    {
      pid: 21,
      comm: "opencode",
      command: () => [`${mise}/opencode/latest/opencode`],
      exe: `${mise}/opencode/1.18.34/opencode`,
      tool: "opencode",
    },
    {
      pid: 22,
      comm: "crush",
      command: () => [`${mise}/crush/latest/crush_0.97.1_Linux_x86_64/crush`],
      exe: `${mise}/crush/0.97.1/crush_0.97.1_Linux_x86_64/crush`,
      tool: "crush",
    },
    {
      pid: 23,
      comm: "pi",
      command: () => [`${mise}/pi/latest/pi/pi`],
      exe: `${mise}/pi/0.99.2/pi/pi`,
      tool: "pi",
    },
    {
      pid: 24,
      comm: "node",
      command: () => ["node", `${mise}/npm-xai-official-grok/latest/bin/grok`],
      exe: `${mise}/node/24.20.0/bin/node`,
      tool: "grok",
    },
    {
      pid: 25,
      comm: "antigravity",
      command: () => [
        `${mise}/aqua-google-antigravity-antigravity-cli/latest/antigravity`,
      ],
      tool: "antigravity",
    },
    {
      pid: 26,
      comm: "claude",
      command: () => [`${home}/.config/Claude/claude-code/2.1.260/claude`],
      tool: "claude",
    },
    // The work profile's Code tab engine, and the Electron binary of the
    // Claude Desktop AppImage, which lies in no claude location.
    {
      pid: 27,
      comm: "claude",
      command: () => [`${home}/.config/Claude-work/claude-code/2.1.260/claude`],
      tool: "claude",
    },
    {
      pid: 28,
      comm: "claude",
      command: () => ["/tmp/.mount_claudeBHBhLJ/usr/lib/claude-desktop/claude"],
      tool: null,
    },
    // A distributed shell sharing the local name, and a script sharing a
    // shipped one.
    {
      pid: 30,
      comm: "dsh",
      command: () => ["/usr/bin/dsh", "-a", "uptime"],
      tool: null,
      unconfirmed: "dsh",
    },
    {
      pid: 31,
      comm: "bash",
      command: () => ["bash", "pi.sh"],
      exe: "/usr/bin/bash",
      file: "pi.sh",
      tool: null,
      unconfirmed: "pi",
    },
    // A script never matches a tool with no install location.
    {
      pid: 32,
      comm: "bash",
      command: () => ["bash", `${home}/bin/agy.sh`],
      exe: "/usr/bin/bash",
      tool: null,
      unconfirmed: "agy",
    },
  ]);
  // Neither false name makes a lane outside the agent slice; the agent
  // beside them does.
  expect(
    await toolWorld(owner, [
      {
        pid: 10,
        comm: "claude",
        command: () => [`${mise}/claude/latest/claude`],
        exe: `${mise}/claude/2.1.286/claude`,
        tool: "claude",
      },
      {
        pid: 30,
        comm: "dsh",
        command: () => ["/usr/bin/dsh", "-a", "uptime"],
        tool: null,
        unconfirmed: "dsh",
      },
      {
        pid: 31,
        comm: "bash",
        command: () => ["bash", "pi.sh"],
        exe: "/usr/bin/bash",
        file: "pi.sh",
        tool: null,
        unconfirmed: "pi",
      },
    ]),
  ).toEqual(["tmux-spawn-10.scope"]);
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
    "claude feature/lane",
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
test("an ancestor memory.max that cannot be read leaves the lane cap unknown", async () => {
  const f = setup();
  f.group("agents.slice/a.scope", [40]);
  f.proc(40, "agents.slice/a.scope");
  const readable = await new Collector(f.config, 100, 4096).sample();
  expect([
    readable.lanes[0].memoryMax,
    readable.lanes[0].memoryMaxKnown,
  ]).toEqual([null, true]);
  rmSync(join(f.config.cgroupRoot, "agents.slice/memory.max"));
  const s = await new Collector(f.config, 100, 4096).sample();
  expect([s.lanes[0].memoryMax, s.lanes[0].memoryMaxKnown]).toEqual([
    null,
    false,
  ]);
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
test("device totals come from the cgroup root, not the watched user tree", async () => {
  const f = setup();
  f.group("agents.slice/a.scope", [40]);
  f.write(
    join(f.config.cgroupRoot, "agents.slice/a.scope/io.stat"),
    "259:0 rbytes=1 wbytes=200\n",
  );
  // The root counts services outside the user manager, so its totals are larger.
  f.write(
    join(f.config.cgroupTop, "io.stat"),
    "259:0 rbytes=9 wbytes=900\n8:0 rbytes=1 wbytes=50\n",
  );
  const collector = new Collector(f.config, 100, 4096);
  expect((await collector.sample(1000)).storage.deviceWrites).toEqual({
    "259:0": 900,
    "8:0": 50,
  });
  // An unreadable root leaves the totals unknown rather than falling back.
  f.write(join(f.config.cgroupTop, "io.stat"), "259:0 wbytes=x\n");
  const bad = await collector.sample(2000);
  expect(bad.storage.deviceWrites).toBeNull();
  expect(bad.errors.map((e) => e.source)).toContain(
    join(f.config.cgroupTop, "io.stat"),
  );
});
test("a sample carries drive lifetime writes when a SMART report is readable", async () => {
  const f = setup();
  f.write(join(f.config.sysBlockRoot, "nvme0n1/dev"), "259:0\n");
  f.write(
    join(f.config.smartDir, "nvme0n1"),
    "Model Number: Test Drive\nData Units Written: 1,000,000 [512 GB]\n",
  );
  const s = await new Collector(f.config, 100, 4096).sample();
  expect(s.storage.devices).toContainEqual({
    name: "nvme0n1",
    number: "259:0",
    model: "Test Drive",
    lifetimeWritten: 512_000_000_000,
  });
});
test("argv exclusion hides a helper process but never an agent lane", async () => {
  const f = setup();
  f.proc(39, "app.slice/chrome.scope", {
    command: [claudeLink, "--chrome-native-host"],
  });
  f.proc(40, "app.slice/pane.scope", {
    command: [
      claudeLink,
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
    command: [claudeLink, "--headless"],
  });
  const b = await new Collector(f.config, 100, 4096).sample();
  expect(b.procs.find((p) => p.pid === 41)?.tool).toBeNull();
  expect(b.procs.find((p) => p.pid === 39)?.tool).toBe("claude");
});
test("a desktop app named after an agent is no lane, and agents beside it still escape", async () => {
  const f = setup();
  // Claude Desktop as an AppImage runs it: the window process carries no
  // --type= flag, so only its executable's path tells it from the agent CLI.
  // Their scopes are left out of the fixture, so only an agent makes a lane.
  const appImage = "/tmp/.mount_claudeBHBhLJ/usr/lib/claude-desktop/claude";
  f.proc(1702778, "app.slice/app-com.anthropic.Claude-1702778.scope", {
    command: [appImage, "--enable-transparent-visuals"],
  });
  f.proc(1702955, "app.slice/app-com.anthropic.Claude-work-1702778.scope", {
    command: [appImage, "--type=zygote", "--no-zygote-sandbox"],
    parent: 1702778,
  });
  const collector = new Collector(f.config, 100, 4096);
  const unconfined = (s: Snapshot) => ({
    tools: Object.fromEntries(s.procs.map((p) => [p.pid, p.tool])),
    lanes: s.lanes.map((l) => basename(l.id)).sort(),
    cause: causes(s, f.config).some((x) => x.id === "unconfined"),
    alerts: s.alerts
      .filter((a) => a.rule === "unconfined")
      .map((a) => a.subject)
      .sort(),
  });
  expect(unconfined(await collector.sample(1000))).toEqual({
    tools: { 1702778: null, 1702955: null },
    lanes: [],
    cause: false,
    alerts: [],
  });
  // The agent CLI outside the slice; the engine a desktop app bundles, which
  // its path names an agent, also once an update replaced it while it ran;
  // and an app binary whose executable could not be read, which stays an
  // agent rather than hiding an escape.
  f.proc(40, "app.slice/tmux-spawn-1.scope", {
    command: ["/home/reader/.local/bin/claude", "--resume"],
  });
  f.proc(41, "app.slice/app-codex.scope", {
    command: ["/opt/codex-desktop/resources/codex", "exec"],
    comm: "codex",
  });
  f.proc(42, "app.slice/app-gone.scope", { command: [appImage] });
  rmSync(join(f.config.procRoot, "42/exe"));
  f.proc(43, "app.slice/app-codex-updated.scope", {
    command: ["/opt/codex-desktop/resources/codex", "exec"],
    comm: "codex",
  });
  rmSync(join(f.config.procRoot, "43/exe"));
  symlinkSync(
    "/opt/codex-desktop/resources/codex (deleted)",
    join(f.config.procRoot, "43/exe"),
  );
  const s = await collector.sample(2000);
  expect(unconfined(s)).toEqual({
    tools: {
      40: "claude",
      41: "codex",
      42: "claude",
      43: "codex",
      1702778: null,
      1702955: null,
    },
    lanes: [
      "app-codex-updated.scope",
      "app-codex.scope",
      "app-gone.scope",
      "tmux-spawn-1.scope",
    ],
    cause: true,
    alerts: ["40:100:claude", "41:100:codex", "42:100:claude", "43:100:codex"],
  });
  expect(s.errors).toEqual([]);
});

test("an excluded pattern matches a whole flag, or an option ending in = with any value", () => {
  const appImage = "/tmp/.mount_claudeBHBhLJ/usr/lib/claude-desktop/claude";
  const shipped = defaults().excludeArgv;
  const rows = [
    [[appImage, "--type=renderer"], shipped, true],
    [[appImage, "--type=gpu-process"], shipped, true],
    [[appImage, "--type=utility"], shipped, true],
    [[appImage, "--type=zygote", "--no-zygote-sandbox"], shipped, true],
    // A helper type the shipped list never named one by one.
    [["/usr/lib/slack/slack", "--type=broker"], shipped, true],
    [["/usr/bin/claude", "--chrome-native-host"], shipped, true],
    [["/usr/bin/claude", "--resume"], shipped, false],
    // A pattern without = names one whole flag, never a longer one.
    [["/usr/bin/claude", "--agents", "{}"], ["--agent"], false],
    [["/usr/bin/claude", "--agent", "reviewer"], ["--agent"], true],
  ] as const;
  expect(
    rows.map(([command, patterns]) =>
      excludedArgv([...command], [...patterns]),
    ),
  ).toEqual(rows.map(([, , excluded]) => excluded));
});

test("the program's collector takes install locations and desktop paths from the agent-tool overlay", async () => {
  const f = setup();
  f.write(
    f.agentToolsPath,
    JSON.stringify({
      version: 1,
      tools: [{ name: "zz-agent", paths: ["/srv/agents/"] }],
      desktopExePrefixes: ["/srv/apps/"],
    }),
  );
  f.config.agentTools = [...f.config.agentTools, "zz-agent"];
  // Each app's binary is called claude and lies in no claude install
  // location, so only the desktop prefix keeps it from reading as a claude
  // whose location vsys could not confirm.
  f.proc(40, "app.slice/app-x.scope", { command: ["/srv/apps/x/claude"] });
  f.proc(41, "app.slice/app-y.scope", {
    command: ["/tmp/.mount_claudeBHBhLJ/usr/lib/claude-desktop/claude"],
  });
  f.proc(42, "app.slice/tmux-spawn-1.scope");
  f.proc(43, "app.slice/tmux-spawn-2.scope", {
    comm: "zz-agent",
    command: ["/srv/agents/zz-agent"],
  });
  f.proc(44, "app.slice/tmux-spawn-3.scope", {
    comm: "zz-agent",
    command: ["/usr/local/bin/zz-agent"],
  });
  const collector = await createCollector(
    f.config,
    false,
    undefined,
    f.agentToolsPath,
  );
  try {
    const s = await collector.sample(1000);
    // The overlay's prefix joins the shipped ones on the process thread, and
    // so does the install location of a tool the overlay adds.
    expect(
      Object.fromEntries(
        s.procs.map((p) => [p.pid, [p.tool, p.unconfirmedTool]]),
      ),
    ).toEqual({
      40: [null, null],
      41: [null, null],
      42: ["claude", null],
      43: ["zz-agent", null],
      44: [null, "zz-agent"],
    });
  } finally {
    collector.close();
  }
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
  expect(trail.prefix).toEqual(["/shadow/bin"]);
  const [copy] = launcherCopy([agent as Proc], s.procs, f.config, ["/usr/bin"]);
  expect(copy.conclusion).toContain("/shadow/bin");
});

test("build process environments carry the wrapper and the make token pool", async () => {
  const f = setup();
  f.group("agents.slice/b.scope", [50]);
  f.proc(50, "agents.slice/b.scope", {
    comm: "rustc",
    command: ["/usr/bin/rustc", "src/lib.rs"],
    env: "RUSTC_WRAPPER=\0MAKEFLAGS= -j16 --jobserver-auth=fifo:/tmp/GMfifo1\0SECRET=hidden\0",
  });
  const collector = new Collector(
    f.config,
    100,
    4096,
    false,
    new SccacheCollector(async () => "Cache hits 8\nCache misses 2\n", 0),
  );
  const s = await collector.sample(1000);
  expect(s.errors).toEqual([]);
  const p = s.procs.find((x) => x.pid === 50);
  expect(p?.build).toBe("rustc");
  // Only the selected fields leave the collector; the wrapper keeps its
  // empty value rather than disappearing with the unselected variables.
  expect(p?.env).toEqual({
    RUSTC_WRAPPER: "",
    MAKEFLAGS: " -j16 --jobserver-auth=fifo:/tmp/GMfifo1",
  });
  expect(s.sccache?.hits).toBe(8);
  expect(bypassedLanes(s)).toEqual([laneText(s.lanes[0])]);
  expect(jobservers(s, f.config)).toEqual([
    { fifo: "/tmp/GMfifo1", total: 16, inUse: 1 },
  ]);
});

test("the pane handle is collected even when the pane setting is narrowed", async () => {
  const f = setup();
  // A reader who narrows the setting to the variable they set themselves. The
  // own-pane mark compares the handle tmux exported against vsys's own, so the
  // collector names that handle for itself rather than inheriting it from a
  // list a reader is free to edit.
  f.config.paneEnv = ["VSYS_PANE"];
  f.group("agents.slice/c.scope", [60]);
  f.proc(60, "agents.slice/c.scope", {
    comm: "claude",
    command: [claudeLink],
    env: "TMUX_PANE=%7\0VSYS_PANE=vsys:2.1\0SECRET=hidden\0",
  });
  const collector = new Collector(f.config, 100, 4096);
  const s = await collector.sample(1000);
  expect(s.errors).toEqual([]);
  expect(s.procs.find((p) => p.pid === 60)?.env).toEqual({
    TMUX_PANE: "%7",
    VSYS_PANE: "vsys:2.1",
  });
});

test("a settings change keeps the cache counts measured since vsys started", async () => {
  const f = setup();
  let hits = 100;
  const sccache = new SccacheCollector(
    async () => `Cache hits ${hits}\nCache misses 0\n`,
    0,
  );
  const before = new Collector(f.config, 100, 4096, false, sccache);
  expect((await before.sample(1000)).sccache?.hits).toBe(100);
  hits = 140;
  // The replacement a settings change builds carries the same reader, so the
  // delta is not restarted by editing a setting.
  const after = await createCollector(
    f.config,
    false,
    before,
    f.agentToolsPath,
  );
  expect((await after.sample(2000)).sccache?.sinceStart).toEqual({
    hits: 40,
    misses: 0,
    windowMs: 1000,
  });
});

test("the program's collector finds a slice defined only by a drop-in", async () => {
  const f = setup();
  rmSync(join(f.config.cgroupRoot, "agents.slice"), { recursive: true });
  // What the line Settings offers writes, with no group started yet. Both XDG
  // roots point into the fixture, so the host's own units are not read.
  mkdirSync(join(f.root, "config/systemd/user.control/agents.slice.d"), {
    recursive: true,
  });
  const prior = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  process.env.XDG_CONFIG_HOME = join(f.root, "config");
  process.env.XDG_DATA_HOME = join(f.root, "data");
  const collector = await createCollector(
    f.config,
    false,
    undefined,
    f.agentToolsPath,
  ).finally(() => {
    for (const [name, value] of Object.entries(prior))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  try {
    const s = await collector.sample(1000);
    expect(
      s.capabilities.find((cap) => cap.id === "agent-slice"),
    ).toMatchObject({
      available: true,
      source: join(f.root, "config/systemd/user.control/agents.slice.d"),
    });
  } finally {
    collector.close();
  }
});

/** Puts back what a test borrowed from vsys's own environment. */
function restoreEnv(tmux: string | undefined, pane: string | undefined) {
  if (tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = tmux;
  if (pane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = pane;
}
/**
 * The tmux server these lanes and the stubs below belong to, as the collector
 * names it: the socket path and the server's pid, without the session that
 * differs between clients. Written once so a lane and the read that resolves
 * it cannot disagree by a spelling.
 */
const paneServer = "/tmp/tmux-1000/default,4242";
/** Lanes in as many tmux panes, so one read has to serve all of them. */
function panedFixture(f: ReturnType<typeof fixture>, count: number) {
  for (let i = 0; i < count; i++) {
    f.group(`agents.slice/pane-${i}.scope`, [100 + i]);
    f.proc(100 + i, `agents.slice/pane-${i}.scope`, {
      env: `TMUX_PANE=%${i}\0TMUX=${paneServer},${i}\0`,
      ticks: 10,
    });
  }
}

test("one tmux read resolves every lane's pane, however many lanes there are", async () => {
  const f = setup();
  panedFixture(f, 12);
  let reads = 0;
  const collector = new Collector(f.config, 100, 4096, false, undefined, {
    probe: () => null,
    panes: async () => {
      reads++;
      return {
        socket: paneServer,
        // vsys draws in the first of these panes, which makes that lane its
        // own screen and every other lane an agent's.
        own: "%0",
        byId: new Map(
          Array.from({ length: 12 }, (_, i) => [
            `%${i}`,
            { address: `vsys:${i}.1`, window: `w-${i}` },
          ]),
        ),
      };
    },
  });
  const s = await collector.sample(1000);
  const resolved = s.lanes.filter((lane) => lane.address !== "");
  expect(resolved).toHaveLength(12);
  // One call for the whole server, not one per lane.
  expect(reads).toBe(1);
  // The raw handle is untouched: it is what every action addresses.
  const first = s.lanes.find((lane) => lane.pane === "%0");
  expect(first?.address).toBe("vsys:0.1");
  expect(first?.window).toBe("w-0");
  // The one lane the Terminal section may never capture, marked from the same
  // read. Its neighbour is an agent and is read as always.
  expect(first?.self).toBe("yes");
  expect(s.lanes.find((lane) => lane.pane === "%1")?.self).toBe("no");
  // A second sample is a second read, not a cached one: panes move.
  await collector.sample(2000);
  expect(reads).toBe(2);
});

test("a tmux server that starts after vsys still gets its lanes addressed", async () => {
  const f = setup();
  panedFixture(f, 3);
  let reads = 0;
  // The ordinary order for this program: vsys is a dashboard for agents, and
  // the agents, with the tmux they run in, start after it.
  let running = false;
  const collector = new Collector(f.config, 100, 4096, false, undefined, {
    probe: () => ({ failure: "incomplete", detail: "no server running" }),
    panes: async () => {
      reads++;
      if (!running) throw new Error("no server on /tmp/tmux-1000/default");
      return {
        socket: paneServer,
        own: "%0",
        byId: new Map(
          Array.from({ length: 3 }, (_, i) => [
            `%${i}`,
            { address: `vsys:${i}.1`, window: `w-${i}` },
          ]),
        ),
      };
    },
  });
  // vsys's own pane and server are in vsys's own environment, which is where
  // the collector reads them when no server answers. Set here rather than
  // taken from the machine running the suite, which has panes of its own.
  const priorTmux = process.env.TMUX;
  const priorPane = process.env.TMUX_PANE;
  process.env.TMUX = `${paneServer},9`;
  process.env.TMUX_PANE = "%0";
  const before = await collector
    .sample(1000)
    .finally(() => restoreEnv(priorTmux, priorPane));
  expect(before.lanes.every((lane) => lane.address === "")).toBe(true);
  // The pane handle still arrives; only its resolution is missing.
  expect(before.lanes.some((lane) => lane.pane.startsWith("%"))).toBe(true);
  // And the lane holding vsys's own pane is still marked. Carried in the read
  // that failed, every lane came back unmarked, and the Terminal section drew
  // vsys's own screen inside itself for that sample: the capture is a separate
  // spawn that does not depend on this read at all.
  expect(before.lanes.find((lane) => lane.pane === "%0")?.self).toBe("yes");
  expect(before.lanes.find((lane) => lane.pane === "%1")?.self).toBe("no");
  expect(before.capabilities.find((cap) => cap.id === "tmux")?.available).toBe(
    false,
  );
  // A server that never answered is a capability with a reason, not a source
  // the reader is told is unreadable on every tick for the life of the run.
  expect(before.errors).toEqual([]);
  // A server comes up. Nothing re-probes and nothing restarts.
  running = true;
  const after = await collector.sample(2000);
  expect(after.lanes.filter((lane) => lane.address !== "")).toHaveLength(3);
  expect(after.lanes.find((lane) => lane.pane === "%0")?.address).toBe(
    "vsys:0.1",
  );
  expect(after.capabilities.find((cap) => cap.id === "tmux")?.available).toBe(
    true,
  );
  // Gated on the startup probe this read was never attempted at all, so the
  // count is what says the gate opened rather than the addresses arriving by
  // some other route.
  expect(reads).toBe(2);
  // The first snapshot is not rewritten by what the second learned.
  expect(before.capabilities.find((cap) => cap.id === "tmux")?.available).toBe(
    false,
  );
});

test("a tmux server that stops answering mid-run costs the addresses, not the sample", async () => {
  const f = setup();
  panedFixture(f, 2);
  const collector = new Collector(f.config, 100, 4096, false, undefined, {
    probe: () => null,
    panes: async () => {
      throw new Error("no server running on /tmp/tmux-1000/default");
    },
  });
  const s = await collector.sample(1000);
  expect(s.lanes.every((lane) => lane.address === "")).toBe(true);
  expect(s.lanes).not.toHaveLength(0);
  // The failure is reported as a source that could not be read, and the rest
  // of the sample still arrives.
  expect(s.errors.map((e) => e.source)).toContain("tmux list-panes");
  expect(s.system.cores).toBeGreaterThan(0);
});

test("a kernel log this user cannot search is probed once and never searched", async () => {
  const f = setup();
  const searched: (string | null)[] = [];
  const log = new KernelLog(async (cursor) => {
    searched.push(cursor);
    return `-- cursor: after-${cursor}\n`;
  });
  const reader = (outcome: null | { failure: "incomplete"; detail: string }) =>
    new Collector(
      f.config,
      100,
      4096,
      false,
      undefined,
      undefined,
      undefined,
      [],
      {
        probe: () => outcome,
        log,
      },
    );
  const refused = await reader({
    failure: "incomplete",
    detail: "no kernel message",
  }).sample(1000);
  expect(
    refused.capabilities.find((cap) => cap.id === "kernel-log"),
  ).toMatchObject({ available: false, failure: "incomplete" });
  // The capability states the gap once; searching anyway would add a source
  // error to every sample.
  expect(searched).toEqual([]);
  expect(refused.storage.csumFailures).toBeNull();
  const collector = reader(null);
  // The summary path skips the search: a one-shot run would pay for every
  // boot the journal holds.
  const { snapshot } = await sampleSummary(collector, async () => {});
  expect(snapshot.storage.csumFailures).toBeNull();
  expect(searched).toEqual([]);
  const first = await collector.sample(1000);
  expect(first.storage.csumFailures).toEqual({});
  // A replacement collector is handed the log, and resumes from its cursor
  // rather than searching every boot again.
  const replacement = new Collector(
    f.config,
    100,
    4096,
    false,
    undefined,
    undefined,
    undefined,
    [],
    { probe: () => null, log: collector.kernelLog ?? new KernelLog() },
  );
  await replacement.sample(2000);
  expect(searched).toEqual([null, "after-null"]);
});

test("a scrub report directory created while vsys runs is read the next sample", async () => {
  const f = setup();
  const collector = new Collector(f.config, 100, 4096);
  const scrub = async (time: number) =>
    (await collector.sample(time)).capabilities.find(
      (cap) => cap.id === "scrub",
    );
  expect(await scrub(1000)).toMatchObject({
    available: false,
    failure: "absent",
  });
  // The reader ran the install line vsys offered, which creates the directory.
  mkdirSync(f.config.scrubDir, { recursive: true });
  expect(await scrub(2000)).toMatchObject({ available: true, failure: null });
});

test("the program's collector resumes the kernel log the one it replaces held", async () => {
  const f = setup();
  const searched: (string | null)[] = [];
  const held = new KernelLog(async (cursor) => {
    searched.push(cursor);
    return `-- cursor: after-${cursor}\n`;
  });
  const before = new Collector(
    f.config,
    100,
    4096,
    false,
    undefined,
    undefined,
    undefined,
    [],
    { probe: () => null, log: held },
  );
  await before.sample(1000);
  // A settings change builds the replacement through the program's own path,
  // which picks the search up from the cursor the first one ended on.
  const after = await createCollector(
    f.config,
    false,
    before,
    f.agentToolsPath,
    () => null,
  );
  const fresh = await createCollector(
    f.config,
    false,
    undefined,
    f.agentToolsPath,
    () => null,
  );
  const unread = await createCollector(
    f.config,
    false,
    { kernelLog: null },
    f.agentToolsPath,
    () => null,
  );
  try {
    expect(after.kernelLog).toBe(held);
    await after.sample(2000);
    expect(searched).toEqual([null, "after-null"]);
    // With no predecessor, or one that searched no log, a new log starts.
    expect(fresh.kernelLog).toBeInstanceOf(KernelLog);
    expect(fresh.kernelLog).not.toBe(held);
    expect(unread.kernelLog).toBeInstanceOf(KernelLog);
  } finally {
    for (const collector of [after, fresh, unread]) collector.close();
  }
});
