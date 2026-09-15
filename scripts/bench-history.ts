import { isDeepStrictEqual } from "node:util";
import { defaults } from "../src/config/config";
import { lanes } from "../src/model/lanes";
import { Archive } from "../src/store/archive";
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
/**
 * Counters that move by a different amount per row at every sample, because a
 * uniform series deltas away to almost nothing and understates what an archive
 * append costs on a live machine.
 */
function advance(i: number): void {
  snapshot.time = 1000 + i * c.refreshMs;
  snapshot.system.uptime = 1000 + i;
  const child = snapshot.procs[1];
  child.pid = 2100 + i;
  child.start = snapshot.system.uptime * 100;
  child.ticks = 0;
  child.command = [
    "/repo/0/target/debug/deps/retry-abc123",
    "--seed",
    String(i),
  ];
  child.build = "test";
  child.threads = 65;
  snapshot.groups[1].pids[1] = child.pid;
  for (const [n, p] of snapshot.procs.entries()) {
    p.age = snapshot.system.uptime - p.start / 100;
    p.ticks += 1 + ((n * 7 + i * 13) % 11);
    p.cpuPercent = ((n * 17 + i * 29) % 997) / 10;
    p.rss = 1048576 + ((n * 31 + i * 53) % 4096) * 4096;
    p.threads = 1 + ((n + i) % 64);
  }
  for (const [n, g] of snapshot.groups.entries()) {
    g.cpuUsec += 100000 + ((n * 37 + i * 41) % 500000);
    g.cpuPercent = ((n * 11 + i * 19) % 800) / 10;
    g.memory = 100000000 + ((n * 23 + i * 61) % 8192) * 4096;
  }
  snapshot.lanes = lanes(snapshot.groups, snapshot.procs, c);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return Number((sorted[at] ?? 0).toFixed(3));
}

let samples = 0;
const expected = new Map<number, string>();
const addMs: number[] = [];
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
    advance(samples);
    const began = performance.now();
    history.add(snapshot);
    addMs.push(performance.now() - began);
    if (checkpoints.has(samples) || samples % 1000 === 0)
      expected.set(snapshot.time, JSON.stringify(snapshot));
    if (history.retentionWarning) {
      expected.set(snapshot.time, JSON.stringify(snapshot));
      samples++;
      break;
    }
    if (samples % 100 === 0) await Bun.sleep(0);
  }
  const firstRetained = history.at(1000) !== null;
  let verified = 0;
  let evicted = 0;
  for (const [time, json] of [...expected.entries()].reverse()) {
    const replayed = history.at(time);
    // A shortened window drops its oldest checkpoints. A window that never
    // shortened dropped nothing, so a missing snapshot there is a replay
    // defect and not an eviction, and it fails rather than being counted.
    if (replayed === null) {
      if (!history.retentionWarning)
        throw new Error(`Retained snapshot at ${time} did not replay`);
      evicted++;
      continue;
    }
    if (!isDeepStrictEqual(replayed, JSON.parse(json)))
      throw new Error(`Replay differs from the collected snapshot at ${time}`);
    verified++;
  }
  // A run that evicted more than it verified proves almost nothing, and the
  // count alone cannot say which of the two it was.
  if (verified <= evicted)
    throw new Error(
      `Verified ${verified} snapshot(s) against ${evicted} evicted`,
    );
  // One checkpoint of the same workload against the archive alone, so the
  // share of an append that belongs to snapshot storage is readable next to
  // the whole-sample cost above.
  const archive = new Archive();
  const archiveMs: number[] = [];
  for (let i = 0; i < 300; i++) {
    advance(i);
    const json = JSON.stringify(snapshot);
    const began = performance.now();
    archive.add(snapshot.time, json);
    archiveMs.push(performance.now() - began);
  }
  console.log(
    JSON.stringify({
      scopes: 50,
      processes: snapshot.procs.length,
      samples,
      requiredSamples: required,
      firstRetained,
      verifiedSnapshots: verified,
      evictedSnapshots: evicted,
      complete: samples === required && firstRetained,
      warning: history.retentionWarning,
      elapsedMs: performance.now() - started,
      rssBytes: process.memoryUsage().rss,
      historyAddMedianMs: percentile(addMs, 0.5),
      historyAddP95Ms: percentile(addMs, 0.95),
      historyAddMaxMs: percentile(addMs, 1),
      archiveAddMedianMs: percentile(archiveMs, 0.5),
      archiveAddP95Ms: percentile(archiveMs, 0.95),
      archiveAddMaxMs: percentile(archiveMs, 1),
    }),
  );
} finally {
  history.close();
}
