import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultScratchDirs, defaults } from "../config/config";
import { fixture, processSnapshot } from "../test/fixture";
import { present } from "../test/present";
import {
  agentScratchDirs,
  type ScanRunner,
  ScratchCollector,
  scratchRoots,
} from "./scratch";
import {
  type ScanBudget,
  type ScanRoot,
  type ScratchScan,
  scanScratch,
} from "./scratch-scan";

const empty = (time: number): ScratchScan => ({
  scratch: [],
  sessions: [],
  absent: [],
  time,
  errors: [],
});

/** A scan the test finishes by hand, so nothing reads a real directory. */
function held() {
  const budgets: ScanBudget[] = [];
  const roots: ScanRoot[][] = [];
  const signals: AbortSignal[] = [];
  const waiting: PromiseWithResolvers<ScratchScan>[] = [];
  let closed = 0;
  const runner: ScanRunner = {
    run(asked, _time, budget, signal) {
      roots.push(asked);
      budgets.push(budget);
      signals.push(signal);
      const next = Promise.withResolvers<ScratchScan>();
      waiting.push(next);
      return next.promise.then((scan) => ({ scan, rests: 0 }));
    },
    close() {
      closed++;
    },
  };
  return {
    runner,
    budgets,
    roots,
    signals,
    waiting,
    get closed() {
      return closed;
    },
  };
}

test("live reads reuse a single pending scan and keep its measurement time", async () => {
  const c = { ...defaults(), scratchDirs: ["/scratch"] };
  const scans = held();
  const collector = new ScratchCollector(scans.runner);
  try {
    expect((await collector.collect(c, [], 1000, false)).time).toBeNull();
    expect((await collector.collect(c, [], 2000, false)).time).toBeNull();
    expect(scans.waiting.length).toBe(1);
    expect(collector.pending).toBe(true);
    present(scans.waiting[0], "pending scan").resolve(empty(1000));
    expect((await collector.collect(c, [], 2000, true)).time).toBe(1000);
    expect(collector.pending).toBe(false);
    expect((await collector.collect(c, [], 2001, false)).time).toBe(1000);
    expect(scans.waiting.length).toBe(1);
    collector.close();
    expect(scans.signals[0]?.aborted).toBe(true);
    expect(scans.closed).toBe(1);
    await expect(collector.collect(c, [], 3000, false)).rejects.toThrow();
  } finally {
    collector.close();
  }
});

test("a background scan holds the configured share; a waiting caller waits on none", async () => {
  const c = {
    ...defaults(),
    scratchDirs: ["/scratch"],
    scratchDutyPercent: 20,
  };
  const scans = held();
  const collector = new ScratchCollector(scans.runner);
  try {
    await collector.collect(c, [], 1000, false);
    const scan = present(scans.waiting[0], "pending scan");
    scan.resolve(empty(1000));
    await scan.promise;
    expect(scans.budgets[0]?.dutyPercent).toBe(20);
  } finally {
    collector.close();
  }
  // A script waiting on the reading has no screen to protect, so its scan
  // never rests: throttling it would only make the caller wait longer.
  const scripted: ScanBudget[] = [];
  const once = new ScratchCollector({
    run: (_c, time, budget) => {
      scripted.push(budget);
      return Promise.resolve({ scan: empty(time), rests: 0 });
    },
    close: () => {},
  });
  try {
    await once.collect(c, [], 1000, true);
    expect(scripted[0]?.dutyPercent).toBe(100);
  } finally {
    once.close();
  }
});

test("a scan that outlasts the interval waits the interval out from its completion", async () => {
  const c = {
    ...defaults(),
    scratchDirs: ["/scratch"],
    scratchRefreshMs: 30000,
  };
  const scans = held();
  let now = 0;
  const collector = new ScratchCollector(scans.runner, () => now);
  try {
    await collector.collect(c, [], 1000, false);
    expect(scans.waiting.length).toBe(1);
    // The traversal runs far longer than the rescan interval.
    now = 100000;
    present(scans.waiting[0], "pending scan").resolve(empty(1000));
    expect((await collector.collect(c, [], 2000, true)).time).toBe(1000);
    expect(scans.waiting.length).toBe(1);
    // Measured from the attempt, the completed scan would be eligible again
    // at once and the traversal would never pause.
    now = 129999;
    await collector.collect(c, [], 3000, false);
    expect(scans.waiting.length).toBe(1);
    now = 130000;
    await collector.collect(c, [], 4000, false);
    expect(scans.waiting.length).toBe(2);
  } finally {
    collector.close();
  }
});

test("a failed scan keeps the last complete reading and names what failed", async () => {
  const c = { ...defaults(), scratchDirs: ["/scratch"] };
  const scans = held();
  let now = 0;
  const collector = new ScratchCollector(scans.runner, () => now);
  try {
    await collector.collect(c, [], 1000, false);
    present(scans.waiting[0], "pending scan").resolve({
      scratch: [
        {
          path: "/scratch",
          bytes: 4096,
          age: 0,
          modifiedAt: 1,
          error: null,
          origin: "configured",
        },
      ],
      sessions: [],
      absent: [],
      time: 1000,
      errors: [],
    });
    await collector.collect(c, [], 1000, true);
    now = 60000;
    await collector.collect(c, [], 2000, false);
    present(scans.waiting[1], "second scan").reject(
      new Error("Scratch scan thread exited"),
    );
    const after = await collector.collect(c, [], 2000, true);
    expect(after.time).toBe(1000);
    expect(after.scratch[0]?.bytes).toBe(4096);
    expect(after.errors).toEqual([
      { source: "scratch scan", message: "Scratch scan thread exited" },
    ]);
  } finally {
    collector.close();
  }
});

test("empty scratch settings need no background work", async () => {
  const scans = held();
  const collector = new ScratchCollector(scans.runner);
  try {
    const value = await collector.collect(
      { ...defaults(), scratchDirs: [] },
      [],
      1000,
      false,
    );
    expect(value.errors).toEqual([]);
    expect(scans.waiting.length).toBe(0);
    expect(collector.pending).toBe(false);
  } finally {
    collector.close();
  }
});

test("an agent's temporary directory is scratch work even with no root set", async () => {
  const scans = held();
  const collector = new ScratchCollector(scans.runner);
  try {
    await collector.collect(
      { ...defaults(), scratchDirs: [] },
      ["/agent/tmp"],
      1000,
      false,
    );
    // The agent's directory is measured only if vsys's own user owns it.
    const owner = process.getuid?.() ?? Number.NaN;
    expect(scans.roots).toEqual([
      [{ path: "/agent/tmp", origin: "agent", owner }],
    ]);
  } finally {
    collector.close();
  }
});

test("a reading names only the roots of the sample it is published for", async () => {
  const c = { ...defaults(), scratchDirs: [], scratchRefreshMs: 30000 };
  const scans = held();
  let now = 0;
  const collector = new ScratchCollector(scans.runner, () => now);
  try {
    await collector.collect(c, ["/a"], 1000, false);
    present(scans.waiting[0], "pending scan").resolve({
      scratch: [
        {
          path: "/a",
          bytes: 4096,
          age: 0,
          modifiedAt: 1,
          error: "Permission denied",
          origin: "agent",
        },
      ],
      sessions: [
        { path: "/a/s", bytes: 4096, age: 0, modifiedAt: 1, error: null },
      ],
      absent: [],
      time: 1000,
      errors: [{ source: "/a", message: "Permission denied" }],
    });
    const scanned = await collector.collect(c, ["/a"], 1000, true);
    expect(scanned.scratch.map((x) => x.path)).toEqual(["/a"]);
    // Within the interval agent A stops, then agent B starts. Neither sample
    // republishes A's row from the cached scan, and B waits for the next one.
    now = 1;
    const read = (dirs: string[], time: number) =>
      collector.collect(c, dirs, time, false);
    for (const reading of [await read([], 2000), await read(["/b"], 3000)])
      expect(reading).toMatchObject({
        scratch: [],
        sessions: [],
        errors: [],
      });
    expect(scans.waiting.length).toBe(1);
  } finally {
    collector.close();
  }
});

test("a list equal to the shipped one is default and any other list is the reader's", async () => {
  const shipped = defaultScratchDirs();
  // The author's workstation runs with no settings file, so these three are
  // what it measures. They stay in the default, and stay scanned there.
  expect(shipped).toEqual(
    expect.arrayContaining([
      join(homedir(), "dev/.scratch/agents"),
      join(homedir(), "dev/.scratch/claude"),
      "/var/tmp/claude",
    ]),
  );
  const scans = held();
  const collector = new ScratchCollector(scans.runner);
  try {
    await collector.collect(defaults(), [], 1000, false);
    expect(scans.roots[0]).toEqual(
      shipped.map((path) => ({ path, origin: "default" })),
    );
  } finally {
    collector.close();
  }
  // Each row: the list in settings, the agent directories, the roots asked for.
  const rows: [string, string[], string[], ScanRoot[]][] = [
    [
      "the shipped list",
      ["/a", "/b"],
      [],
      [
        { path: "/a", origin: "default" },
        { path: "/b", origin: "default" },
      ],
    ],
    // The settings file carries a list that differs from the shipped one, so
    // every root in it was set by the reader.
    ["one root removed", ["/a"], [], [{ path: "/a", origin: "configured" }]],
    [
      "reordered",
      ["/b", "/a"],
      [],
      [
        { path: "/b", origin: "configured" },
        { path: "/a", origin: "configured" },
      ],
    ],
    // A directory a listed root already holds is measured there.
    [
      "inside a root",
      ["/a/"],
      ["/a", "/a/lane", "/ab"],
      [
        { path: "/a/", origin: "configured" },
        { path: "/ab", origin: "agent", owner: 1000 },
      ],
    ],
    [
      "inside another agent directory",
      [],
      ["/t", "/t/x", "/u"],
      [
        { path: "/t", origin: "agent", owner: 1000 },
        { path: "/u", origin: "agent", owner: 1000 },
      ],
    ],
  ];
  for (const [name, dirs, agentDirs, roots] of rows)
    expect({
      name,
      roots: scratchRoots(dirs, agentDirs, ["/a", "/b"], 1000),
    }).toEqual({ name, roots });
});

test("only running agents name scratch, by absolute path, once each", () => {
  const procs = [
    // Process order is not path order: the agent holding the child directory
    // comes first, and the parent must still come out ahead of it.
    processSnapshot({ pid: 6, env: { TMPDIR: "/t/x" } }),
    processSnapshot({ pid: 7, env: { TMPDIR: "/t" } }),
    processSnapshot({
      pid: 1,
      env: {
        TMPDIR: "/scratch/agents/",
        CLAUDE_CODE_TMPDIR: "/scratch/claude",
      },
    }),
    processSnapshot({ pid: 2, env: { TMPDIR: "/scratch/agents" } }),
    // A relative path names no directory vsys can find.
    processSnapshot({ pid: 3, env: { TMPDIR: "tmp" } }),
    // Not an agent: a shell or a build names its own temporary directory.
    processSnapshot({ pid: 4, tool: null, env: { TMPDIR: "/scratch/shell" } }),
    processSnapshot({ pid: 5, env: { HOME: "/home/x" } }),
  ];
  const dirs = agentScratchDirs(procs);
  expect(dirs).toEqual(["/scratch/agents", "/scratch/claude", "/t", "/t/x"]);
  // A directory inside another agent's is measured there, never twice.
  expect(scratchRoots([], dirs, [], 1000).map((root) => root.path)).toEqual([
    "/scratch/agents",
    "/scratch/claude",
    "/t",
  ]);
});

test("the shipped list on a machine without it reports nothing; a typed path that is missing fails", async () => {
  const f = fixture();
  try {
    // The fixture's shipped list, none of which exists on this machine.
    const shipped: [string, string] = [
      join(f.root, "agents"),
      join(f.root, "claude"),
    ];
    const rows: [string, string[], { rows: number; errors: string[] }][] = [
      ["no settings file", shipped, { rows: 0, errors: [] }],
      // The reader kept one of the shipped paths, so it is theirs to fix.
      ["one path typed", [shipped[0]], { rows: 1, errors: [shipped[0]] }],
    ];
    for (const [name, dirs, expected] of rows) {
      const { scan } = await scanScratch(
        scratchRoots(dirs, [], shipped),
        1000,
        { sliceMs: 10, dutyPercent: 100 },
      );
      expect({
        name,
        rows: scan.scratch.length,
        errors: scan.errors.map((e) => e.source),
      }).toEqual({ name, ...expected });
    }
  } finally {
    f.cleanup();
  }
});
