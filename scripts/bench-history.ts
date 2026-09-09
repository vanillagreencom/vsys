import { isDeepStrictEqual } from "node:util";
import { defaults } from "../src/config/config";
import { lanes } from "../src/model/lanes";
import { History } from "../src/store/history";
import {
  emptySnapshot,
  groupSnapshot,
  processSnapshot,
} from "../src/test/fixture";

const c = defaults();
const history = new History(c);
const started = performance.now();
const snapshot = emptySnapshot(1000);
snapshot.groups = [
  groupSnapshot({ path: "agents.slice", parent: ".", name: "agents.slice" }),
];
for (let scope = 0; scope < 50; scope++) {
  const path = `agents.slice/run-${scope}.scope`;
  const pids = Array.from({ length: 40 }, (_, i) => 100 + scope * 40 + i);
  snapshot.groups.push(
    groupSnapshot({
      path,
      parent: "agents.slice",
      name: `run-${scope}.scope`,
      pids,
      tasks: 40,
    }),
  );
  for (const pid of pids)
    snapshot.procs.push(
      processSnapshot({
        pid,
        ppid: pid === pids[0] ? 1 : pids[0],
        group: `/${path}`,
        comm: pid === pids[0] ? "claude" : "rustc",
        tool: pid === pids[0] ? "claude" : null,
        build: pid === pids[0] ? null : "rustc",
        command: [
          pid === pids[0] ? "/usr/bin/claude" : "/usr/bin/rustc",
          `/repo/${scope}/src/main.rs`,
        ],
        cwd: `/repo/${scope}`,
        start: pid,
        age: 1000 - pid / 100,
      }),
    );
}
let samples = 0;
const expected = new Map<number, string>();
try {
  const required = Math.ceil((c.historyHours * 3600000) / c.refreshMs);
  const checkpoints = new Set([
    0,
    299,
    300,
    Math.floor(required / 2),
    required - 1,
  ]);
  for (; samples < required; samples++) {
    snapshot.time = 1000 + samples * c.refreshMs;
    snapshot.system.uptime = 1000 + samples;
    const child = snapshot.procs[1];
    child.pid = 2100 + samples;
    child.start = snapshot.system.uptime * 100;
    child.ticks = 0;
    child.command = [
      "/repo/0/target/debug/deps/retry-abc123",
      "--seed",
      String(samples),
    ];
    child.build = "test";
    child.threads = 65;
    snapshot.groups[1].pids[1] = child.pid;
    for (const p of snapshot.procs) {
      p.age = snapshot.system.uptime - p.start / 100;
      p.ticks += 1;
      p.cpuPercent = 1;
      p.rss = 1048576 + ((p.pid % 100) + (samples % 10)) * 4096;
    }
    for (const g of snapshot.groups) {
      g.cpuUsec += 400000;
      g.cpuPercent = 40;
      g.memory = 100000000 + (samples % 100) * 4096;
    }
    snapshot.lanes = lanes(snapshot.groups, snapshot.procs, c);
    history.add(snapshot);
    if (checkpoints.has(samples))
      expected.set(snapshot.time, JSON.stringify(snapshot));
    if (history.retentionWarning) {
      samples++;
      break;
    }
    if (samples % 100 === 0) await Bun.sleep(0);
  }
  const firstRetained = history.at(1000) !== null;
  let verified = 0;
  if (!history.retentionWarning)
    for (const [time, json] of [...expected.entries()].reverse()) {
      if (!isDeepStrictEqual(history.at(time), JSON.parse(json)))
        throw new Error(
          `Replay differs from the collected snapshot at ${time}`,
        );
      verified++;
    }
  console.log(
    JSON.stringify({
      scopes: 50,
      processes: snapshot.procs.length,
      samples,
      requiredSamples: required,
      firstRetained,
      verifiedSnapshots: verified,
      complete: samples === required && firstRetained,
      warning: history.retentionWarning,
      elapsedMs: performance.now() - started,
      rssBytes: process.memoryUsage().rss,
    }),
  );
} finally {
  history.close();
}
