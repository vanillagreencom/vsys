// Proof tests for the collection findings in review/cloud-defect-review.md.
// Every test here FAILS on the reviewed commit; each failure is the defect.
// Run from the repository root:
//   PATH="$PWD/node_modules/.bin:$PATH" bun test review/tests/collect.test.ts
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Collector } from "../../src/collect/collector";
import { claudeLink, fixture } from "../../src/test/fixture";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
const setup = () => {
  const f = fixture();
  fixtures.push(f);
  return f;
};

// execve keeps the pid and the stat start time but replaces both cmdline and
// environ. A pane shell (the scope's main process) that runs
// `export CLAUDE_CONFIG_DIR=~/accounts/work; exec claude` keeps the shell's
// cached launch environment for the agent's whole life.
test("a scope main that execs into an agent reads the agent's environment", async () => {
  const f = setup();
  f.group("agents.slice/pane.scope", [40]);
  f.proc(40, "agents.slice/pane.scope", {
    command: ["/bin/bash"],
    comm: "bash",
    env: "PATH=/usr/bin\0",
  });
  const collector = new Collector(f.config, 100, 4096);
  const before = await collector.sample(1000);
  expect(before.procs[0]?.tool).toBeNull();
  f.proc(40, "agents.slice/pane.scope", {
    command: [claudeLink],
    env: "PATH=/usr/bin\0CLAUDE_CONFIG_DIR=/accounts/work\0",
  });
  const after = await collector.sample(2000);
  // The command line is read fresh, so the tool is right...
  expect(after.procs[0]?.tool).toBe("claude");
  // ...but the account comes from the stale environment.
  expect(after.lanes[0]?.account).toBe("work");
});

// Control, which passes: a collector with no cached environment reads the
// same files as account "work", so the cache alone causes the failure above.
test("control: a fresh collector reads the exec'd agent's account", async () => {
  const f = setup();
  f.group("agents.slice/pane.scope", [40]);
  f.proc(40, "agents.slice/pane.scope", {
    command: [claudeLink],
    env: "PATH=/usr/bin\0CLAUDE_CONFIG_DIR=/accounts/work\0",
  });
  const s = await new Collector(f.config, 100, 4096).sample(2000);
  expect(s.lanes[0]?.account).toBe("work");
});

// The kernel adds a device line to a group's io.stat on that group's first
// I/O to the device, so a scope that has not reached a disk yet has an
// io.stat that exists, is readable and is empty: a measured zero.
test("an empty but readable io.stat is zero bytes, not unknown", async () => {
  const f = setup();
  f.group("agents.slice/quiet.scope", [40]);
  f.proc(40, "agents.slice/quiet.scope");
  const path = join(f.config.cgroupRoot, "agents.slice/quiet.scope");
  f.write(join(path, "io.stat"), "");
  const collector = new Collector(f.config, 100, 4096);
  await collector.sample(1000);
  const s = await collector.sample(2000);
  expect(s.errors).toEqual([]);
  const g = s.groups.find((x) => x.path === "agents.slice/quiet.scope");
  expect({ write: g?.ioWrite, rate: g?.writeRate }).toEqual({
    write: 0,
    rate: 0,
  });
});

// The sample in which such a scope first writes has a known counter on both
// sides, so it has a rate; it reads unknown instead.
test("a scope's first I/O after an empty io.stat gets a rate", async () => {
  const f = setup();
  f.group("agents.slice/quiet.scope", [40]);
  f.proc(40, "agents.slice/quiet.scope");
  const path = join(f.config.cgroupRoot, "agents.slice/quiet.scope");
  f.write(join(path, "io.stat"), "");
  const collector = new Collector(f.config, 100, 4096);
  await collector.sample(1000);
  f.write(join(path, "io.stat"), "259:0 rbytes=0 wbytes=4096 rios=0 wios=1\n");
  const s = await collector.sample(2000);
  const g = s.groups.find((x) => x.path === "agents.slice/quiet.scope");
  expect(g?.writeRate).toBe(4096);
});
