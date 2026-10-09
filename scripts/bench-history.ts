import { Database } from "bun:sqlite";
import {
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { defaults } from "../src/config/config";
import { lanes } from "../src/model/lanes";
import { Archive } from "../src/store/archive";
import { History } from "../src/store/history";
import {
  emptySnapshot,
  groupSnapshot,
  processSnapshot,
  serviceSnapshot,
} from "../src/test/fixture";
import { percentile } from "./percentile";

/**
 * What the history writes of one sample may cost. They run on the dashboard's
 * own thread, so a keystroke waits behind them, and they share each refresh
 * with collection and a render. The budget is half the shortest refresh
 * interval the settings accept.
 */
const WRITE_BUDGET_MS = 50;
/** Samples timed per condition, after the ones that warm the code up. */
const WRITE_SAMPLES = 300;
const WRITE_WARMUP = 20;
/**
 * The window the write measurement keeps, in samples. It is shorter than the
 * measurement, so most timed samples insert a row and delete one, as every
 * sample does once a long-running process has filled its window.
 */
const WRITE_WINDOW = 120;
/** Processes writing and syncing beside the database under load. */
const LOADERS = 4;
/** What a loader writes before each sync. */
const LOAD_CHUNK = 8 * 1024 * 1024;
/** A loader stops by itself after this long, so a bench that died leaves none running. */
const LOAD_LIFETIME_MS = 600000;
/**
 * How long the bench waits for a loader's exit to arrive once the timed loop
 * ends. The loop never yields, and Bun records a child's exit only when its
 * event loop runs, so a loader that ended mid-run reads as running until the
 * bench waits on it. An exit already pending arrives in well under this.
 */
const LOADER_EXIT_WAIT_MS = 20;

if (process.argv[2] === "--disk-load") {
  const [path, until] = process.argv.slice(3);
  diskLoad(path, Number(until));
}

const c = defaults();
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
// The system services one checkpoint reads, on a host with a busy system.slice.
snapshot.services = Array.from({ length: 60 }, (_, n) =>
  serviceSnapshot({
    path: `system.slice/unit-${n}.service`,
    name: `unit-${n}.service`,
  }),
);
/**
 * Counters that move by a different amount per row at every sample, because a
 * uniform series deltas away to almost nothing and understates what an archive
 * append costs on a live machine.
 */
function advance(i: number): void {
  snapshot.time = 1000 + i * c.refreshMs;
  snapshot.system.uptime = 1000 + i;
  const child = snapshot.procs[1];
  const scope = snapshot.groups[1];
  if (!child || !scope)
    throw new Error(
      `bench-history: fixture-incomplete procs=${snapshot.procs.length} groups=${snapshot.groups.length}\nEach sample moves the first scope's second process, which the fixture builds.`,
    );
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
  scope.pids[1] = child.pid;
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
  // A checkpoint is once a minute, so the service figures hold in between.
  if ((i * c.refreshMs) % 60000 === 0)
    for (const [n, u] of (snapshot.services ?? []).entries())
      u.cpuHourPercent = ((n * 13 + i * 7) % 1000) / 10;
}

/** A timing as the report prints it, to the microsecond. */
function rank(values: number[], fraction: number): number {
  return Number(percentile(values, fraction).toFixed(3));
}

/**
 * Write and sync the same region of one file until `until`, announcing the
 * first sync on stdout so the bench starts timing only once the disk is
 * contended. A separate process, because the workload vsys competes with is
 * other programs, not its own threads.
 */
function diskLoad(path: string | undefined, until: number): never {
  if (!path || !Number.isFinite(until))
    throw new Error(
      `bench-history: disk-load-arguments value=${process.argv.slice(3).join(" ")}\nA disk loader needs a file and a deadline.`,
    );
  const fd = openSync(path, "w");
  const chunk = Buffer.alloc(LOAD_CHUNK, 1);
  let announced = false;
  while (Date.now() < until) {
    writeSync(fd, chunk, 0, chunk.length, 0);
    fsyncSync(fd);
    if (!announced) {
      console.log("loading");
      announced = true;
    }
  }
  process.exit(0);
}

interface WriteCost {
  /** Timed writes that took longer than the budget. */
  overBudget: number;
  addMedianMs: number;
  addP95Ms: number;
  addMaxMs: number;
  commitMedianMs: number;
  commitP95Ms: number;
  commitMaxMs: number;
}

/**
 * What one sample's history writes cost with SQLite on, alone or beside
 * `LOADERS` processes writing and syncing in the database's own directory.
 * `add` is the whole of `History.add`: the timeline point, the archive append,
 * the compression and the SQLite commit. `commit` is that commit alone, the
 * insert and the retention delete in one transaction.
 */
async function writeCost(loaded: boolean): Promise<WriteCost> {
  // Under the repository rather than the system temporary directory, which is
  // memory on many machines and makes every sync free.
  const parent = join(import.meta.dir, "..", "tmp");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "vsys-history-bench-"));
  const config = {
    ...c,
    persistence: true,
    sqlitePath: join(dir, "history.db"),
    historyHours: (WRITE_WINDOW * c.refreshMs) / 3600000,
  };
  const loaders: Bun.Subprocess<"ignore", "pipe", "inherit">[] = [];
  // History.add opens no transaction but its commit, so timing every
  // transaction the database runs times exactly that commit. The count is
  // checked below, so a write path that stops using one fails here rather than
  // reporting the commit as free.
  const transaction = Database.prototype.transaction;
  const commitMs: number[] = [];
  let timing = false;
  Database.prototype.transaction = function timed<A extends unknown[], T>(
    this: Database,
    inside: (...args: A) => T,
  ) {
    const run = transaction.bind(this)(inside);
    const measure =
      (execute: (...args: A) => T) =>
      (...args: A): T => {
        const began = performance.now();
        try {
          return execute(...args);
        } finally {
          if (timing) commitMs.push(performance.now() - began);
        }
      };
    return Object.assign(measure(run), run, {
      immediate: measure(run.immediate),
    });
  } as typeof transaction;
  let history: History | undefined;
  const until = Date.now() + LOAD_LIFETIME_MS;
  try {
    if (loaded) {
      for (let n = 0; n < LOADERS; n++)
        loaders.push(
          Bun.spawn(
            [
              process.execPath,
              import.meta.path,
              "--disk-load",
              join(dir, `load-${n}`),
              String(until),
            ],
            { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
          ),
        );
      for (const loader of loaders) {
        const first = await loader.stdout.getReader().read();
        if (first.done)
          throw new Error(
            `bench-history: loader-exited exit=${await loader.exited}\nA disk loader ended before its first sync.`,
          );
      }
    }
    history = new History(config);
    const addMs: number[] = [];
    for (let i = 0; i < WRITE_WARMUP + WRITE_SAMPLES; i++) {
      advance(i);
      timing = i >= WRITE_WARMUP;
      const began = performance.now();
      history.add(snapshot);
      if (timing) addMs.push(performance.now() - began);
    }
    if (commitMs.length !== addMs.length)
      throw new Error(
        `bench-history: commit-count commits=${commitMs.length} writes=${addMs.length}\nEach history write is timed as one SQLite transaction, and the counts differ.`,
      );
    if (loaded) {
      // The deadline holds on its own: a loader that reached it may still be
      // finishing its last sync when the wait below gives up.
      if (Date.now() >= until)
        throw new Error(
          `bench-history: loader-lifetime lifetime=${LOAD_LIFETIME_MS}ms\nThe measurement under load outlasted the disk loaders' lifetime.`,
        );
      const stopped = await Promise.race([
        Promise.any(loaders.map((loader) => loader.exited)),
        Bun.sleep(LOADER_EXIT_WAIT_MS).then(() => null),
      ]);
      if (stopped !== null)
        throw new Error(
          `bench-history: loader-stopped exit=${stopped}\nA disk loader ended before the measurement under load did.`,
        );
    }
    return {
      overBudget: addMs.filter((ms) => ms > WRITE_BUDGET_MS).length,
      addMedianMs: rank(addMs, 0.5),
      addP95Ms: rank(addMs, 0.95),
      addMaxMs: rank(addMs, 1),
      commitMedianMs: rank(commitMs, 0.5),
      commitP95Ms: rank(commitMs, 0.95),
      commitMaxMs: rank(commitMs, 1),
    };
  } finally {
    Database.prototype.transaction = transaction;
    history?.close();
    for (const loader of loaders) loader.kill();
    await Promise.all(loaders.map((loader) => loader.exited));
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Fill the whole configured window in memory and replay snapshots from across
 * it, which is what says whether the window fits and replays exactly.
 */
async function fill(): Promise<Record<string, unknown>> {
  const history = new History(c);
  const started = performance.now();
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
    let holding = false;
    // Oldest first. Retention ends at one point and never resumes, so what the
    // window holds is a run at the newest end and what it dropped is the prefix
    // before that run. A snapshot missing once the run has begun is replay that
    // failed, which is why nothing here asks of a single snapshot which of the
    // two it was.
    for (const [time, json] of expected) {
      const replayed = history.at(time);
      if (replayed === null) {
        if (holding)
          throw new Error(`Retained snapshot at ${time} did not replay`);
        continue;
      }
      holding = true;
      if (!isDeepStrictEqual(replayed, JSON.parse(json)))
        throw new Error(
          `Replay differs from the collected snapshot at ${time}`,
        );
      verified++;
    }
    if (!verified) throw new Error("No retained snapshot was verified");
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
    return {
      samples,
      requiredSamples: required,
      firstRetained,
      verifiedSnapshots: verified,
      complete: samples === required && firstRetained,
      warning: history.retentionWarning,
      elapsedMs: performance.now() - started,
      rssBytes: process.memoryUsage().rss,
      historyAddMedianMs: rank(addMs, 0.5),
      historyAddP95Ms: rank(addMs, 0.95),
      historyAddMaxMs: rank(addMs, 1),
      archiveAddMedianMs: rank(archiveMs, 0.5),
      archiveAddP95Ms: rank(archiveMs, 0.95),
      archiveAddMaxMs: rank(archiveMs, 1),
    };
  } finally {
    history.close();
  }
}

// `--budget` is the check contract's form: the write cost alone and its
// budget, without the load or the window fill, which take minutes.
const budgetOnly = process.argv[2] === "--budget";
if (process.argv.length > 2 && !budgetOnly)
  throw new Error(
    `bench-history: unknown-argument value=${process.argv.slice(2).join(" ")}`,
  );
const idle = await writeCost(false);
const report = {
  scopes: 50,
  processes: snapshot.procs.length,
  writeBudgetMs: WRITE_BUDGET_MS,
  writeSamples: WRITE_SAMPLES,
  idle,
  ...(budgetOnly
    ? {}
    : { loaders: LOADERS, loaded: await writeCost(true), ...(await fill()) }),
};
console.log(JSON.stringify(report));
// Only the idle cost is held to the budget. What the load does to a write is
// set by the disk under it as much as by the code, so a slow disk would fail
// the check on every change alike. The median, so one stall the scheduler or
// the collector caused does not fail the run, while a write that got slower
// moves it.
if (idle.addMedianMs > WRITE_BUDGET_MS) {
  console.error(
    `bench-history: over-budget median=${idle.addMedianMs}ms budget=${WRITE_BUDGET_MS}ms`,
  );
  console.error(
    "The history writes of one sample took longer than the sample path allows them.",
  );
  process.exit(1);
}
