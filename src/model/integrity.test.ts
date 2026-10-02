import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { volumeSnapshot } from "../test/fixture";
import { present } from "../test/present";
import {
  damageCounts,
  type Integrity,
  type IntegrityState,
  integrity,
  integrityLevel,
  volumesByDevice,
} from "./integrity";
import type { Scrub, Storage, Volume } from "./types";
import type { Level } from "./verdict";

const day = 86400000;
const now = 1_760_000_000_000;
/** One filesystem with a readable counter, named so a report can match it. */
function filesystem(overrides: Partial<Volume> = {}) {
  return present(
    volumesByDevice([
      volumeSnapshot("/", {
        fsid: "fs",
        errors: { "1/corruption_errs": 0 },
        countersAvailable: true,
        ...overrides,
      }),
    ])[0],
    "the filesystem's device group",
  );
}
function report(overrides: Partial<Scrub> = {}): Scrub {
  return {
    path: "/run/btrfs-scrub/root.result",
    text: "Error summary: no errors found",
    problem: false,
    readable: true,
    fsid: "fs",
    startedAt: now - day,
    status: "finished",
    uncorrectable: 0,
    addresses: [],
    ...overrides,
  };
}

test("an address names its files, free space, or damage it could not name", () => {
  const c = defaults();
  const item = integrity(
    filesystem(),
    {
      scrubs: [
        report({
          problem: true,
          // Six blocks counted, four addresses listed: the kernel named only
          // some of them, so two blocks are damage no file is named for.
          uncorrectable: 6,
          addresses: [
            {
              logical: 1,
              paths: ["/r/target/debug/a", "/r/target/debug/b"],
            },
            { logical: 2, paths: ["/r/target/debug/c", "/home/r/letter.txt"] },
            { logical: 3, paths: [] },
            // The reporter could not name every file here, so it is damage
            // with no file to offer, never free space.
            { logical: 4, paths: [], resolved: false },
          ],
        }),
      ],
    },
    now,
    c,
  );
  expect(item.groups.map((group) => group.kind)).toEqual([
    "files",
    "files",
    "none",
    "unresolved",
  ]);
  expect(damageCounts(item)).toEqual({
    files: 4,
    free: 1,
    unresolved: 1,
    unnamed: 2,
  });
});

test("every integrity state, and which reading produces it", () => {
  const c = defaults();
  const rows: [
    string,
    ReturnType<typeof filesystem>,
    Scrub[],
    IntegrityState,
  ][] = [
    // Nothing has ever checked this filesystem, so it cannot report sound.
    ["no report at all", filesystem(), [], "never-checked"],
    [
      "checked inside the limit, no error since",
      filesystem(),
      [report()],
      "healthy",
    ],
    [
      "checked longer ago than the limit",
      filesystem(),
      [report({ startedAt: now - (c.scrubMaxAgeDays + 1) * day })],
      "stale",
    ],
    [
      "a check running now",
      filesystem(),
      [report({ status: "running" })],
      "checking",
    ],
    [
      // The counter feeds "have errors appeared since the check", so without
      // it the state cannot be untroubled.
      "a clean check but no readable counter",
      filesystem({ countersAvailable: false }),
      [report()],
      "unknown",
    ],
    [
      // A report with no start time dates no check, so it cannot say the
      // filesystem was read end to end recently.
      "a readable report carrying no start time",
      filesystem(),
      [report({ startedAt: null })],
      "unknown",
    ],
    [
      "output vsys could not read",
      filesystem(),
      [report({ readable: false, problem: true })],
      "unknown",
    ],
    [
      "a check that stopped early",
      filesystem(),
      [report({ status: "aborted", problem: true })],
      "unknown",
    ],
    [
      "uncorrectable blocks in the last check",
      filesystem(),
      [report({ problem: true, uncorrectable: 26 })],
      "damaged",
    ],
    [
      "a damaged file still on disk",
      filesystem(),
      [
        report({
          problem: true,
          addresses: [{ logical: 1, paths: ["/r/target/x"] }],
        }),
      ],
      "damaged",
    ],
    [
      // The reading that hid the damage: a counter that grew after the last
      // check, and a check old enough that nothing has looked since.
      "the counter grew after the last check",
      filesystem({ lastErrorAt: now - 31 * 3600000, lastErrorSize: 26 }),
      [report({ startedAt: now - 4 * day })],
      "new-errors",
    ],
    [
      // The same growth, but a check ran after it and found nothing.
      "the counter grew before the last check",
      filesystem({ lastErrorAt: now - 4 * day, lastErrorSize: 26 }),
      [report({ startedAt: now - 3600000 })],
      "healthy",
    ],
  ];
  for (const [name, group, scrubs, state] of rows)
    expect({
      name,
      state: integrity(group, { scrubs }, now, c).state,
    }).toEqual({
      name,
      state,
    });
});

test("each source answers on its own, and neither makes a filesystem healthy", () => {
  const c = defaults();
  const failure = { root: 257, inode: 4242, at: now - 2 * 3600000 };
  const older = { root: 257, inode: 17, at: now - 2 * day };
  type Answer = Pick<
    Integrity,
    "state" | "errorSource" | "errorAge" | "kernelLog" | "logged"
  >;
  const rows: [
    string,
    ReturnType<typeof filesystem>,
    Pick<Storage, "scrubs" | "csumFailures">,
    Answer,
  ][] = [
    [
      // The log speaks for the reads since the check, and names the inode.
      "both sources, a failure logged after the check",
      filesystem(),
      { scrubs: [report()], csumFailures: { fs: [failure, older] } },
      {
        state: "new-errors",
        errorSource: "kernel-log",
        errorAge: 7200,
        kernelLog: true,
        logged: [failure],
      },
    ],
    [
      // A check that finished after the failure read past it, so the
      // failure is the report's to speak for.
      "both sources, a failure the check read past",
      filesystem(),
      {
        scrubs: [report({ startedAt: now - 3600000 })],
        csumFailures: { fs: [failure] },
      },
      {
        state: "healthy",
        errorSource: "kernel-log",
        errorAge: 7200,
        kernelLog: true,
        logged: [],
      },
    ],
    [
      // The counter grew after the logged failure, so it is the newer error.
      "both sources, the counter grew last",
      filesystem({ lastErrorAt: now - 3600000, lastErrorSize: 3 }),
      { scrubs: [report()], csumFailures: { fs: [failure] } },
      {
        state: "new-errors",
        errorSource: "counter",
        errorAge: 3600,
        kernelLog: true,
        logged: [failure],
      },
    ],
    [
      "reports only",
      filesystem(),
      { scrubs: [report()], csumFailures: null },
      {
        state: "healthy",
        errorSource: null,
        errorAge: null,
        kernelLog: false,
        logged: [],
      },
    ],
    [
      // No report, and still a dated error and the inode it was in.
      "kernel log only",
      filesystem(),
      { scrubs: [], csumFailures: { fs: [failure] } },
      {
        state: "new-errors",
        errorSource: "kernel-log",
        errorAge: 7200,
        kernelLog: true,
        logged: [failure],
      },
    ],
    [
      // A log holding nothing for this filesystem is not a check.
      "kernel log only, nothing logged",
      filesystem(),
      { scrubs: [], csumFailures: { other: [failure] } },
      {
        state: "never-checked",
        errorSource: null,
        errorAge: null,
        kernelLog: true,
        logged: [],
      },
    ],
    [
      "neither",
      filesystem(),
      { scrubs: [] },
      {
        state: "never-checked",
        errorSource: null,
        errorAge: null,
        kernelLog: false,
        logged: [],
      },
    ],
  ];
  for (const [name, group, storage, answer] of rows) {
    const item = integrity(group, storage, now, c);
    expect({
      name,
      state: item.state,
      errorSource: item.errorSource,
      errorAge: item.errorAge,
      kernelLog: item.kernelLog,
      logged: item.logged,
    }).toEqual({ name, ...answer });
  }
});

test("no state but healthy and checking reads as untroubled", () => {
  const rows: [IntegrityState, Level][] = [
    ["damaged", "danger"],
    ["new-errors", "danger"],
    ["never-checked", "warn"],
    ["stale", "warn"],
    ["unknown", "warn"],
    ["checking", "ok"],
    ["healthy", "ok"],
  ];
  for (const [state, level] of rows)
    expect({ state, level: integrityLevel(state) }).toEqual({ state, level });
});

test("the line carries both times, whether or not either is known", () => {
  const c = defaults();
  const known = integrity(
    filesystem({ lastErrorAt: now - 31 * 3600000, lastErrorSize: 26 }),
    { scrubs: [report({ startedAt: now - 4 * day })] },
    now,
    c,
  );
  expect(known.checkAge).toBe(4 * 86400);
  expect(known.errorAge).toBe(31 * 3600);
  expect(known.errorSize).toBe(26);
  const unknown = integrity(filesystem(), { scrubs: [] }, now, c);
  expect(unknown.checkAge).toBeNull();
  expect(unknown.errorAge).toBeNull();
});

test("a scrub that stops early keeps the age of the finished one it replaced", () => {
  const c = defaults();
  // The reporter overwrote the finished report with this aborted one, so the
  // only report in storage now is the one that did not finish. The collector
  // remembers the finished report's start time separately.
  const scrubs = [report({ status: "aborted", problem: true })];
  const lastFinishedScrubAt = { fs: now - 10 * day };
  // Growth after the remembered check, and before the aborted attempt: the
  // card naming "no full check has ever run" would be wrong here.
  const grown = integrity(
    filesystem({ lastErrorAt: now - 5 * day, lastErrorSize: 26 }),
    { scrubs, lastFinishedScrubAt },
    now,
    c,
  );
  expect(grown.state).toBe("new-errors");
  expect(grown.checkAge).toBe(10 * 86400);
  // No growth at all: the remembered age still shows, but a check that
  // stopped early still cannot say the filesystem is sound.
  const quiet = integrity(
    filesystem(),
    { scrubs, lastFinishedScrubAt },
    now,
    c,
  );
  expect(quiet.state).toBe("unknown");
  expect(quiet.checkAge).toBe(10 * 86400);
  // Growth from before the remembered check is already covered by it, so it
  // is not new.
  const covered = integrity(
    filesystem({ lastErrorAt: now - 20 * day, lastErrorSize: 26 }),
    { scrubs, lastFinishedScrubAt },
    now,
    c,
  );
  expect(covered.state).toBe("unknown");
});

test("a report names a filesystem by its own identity, not by arriving first", () => {
  const c = defaults();
  const other = report({
    fsid: "somewhere-else",
    problem: true,
    uncorrectable: 9,
  });
  const mine = report({ fsid: "fs", startedAt: now - 2 * day });
  expect(integrity(filesystem(), { scrubs: [other, mine] }, now, c).state).toBe(
    "healthy",
  );
  // The newest report for this filesystem is the one that speaks for it.
  const newer = report({
    fsid: "fs",
    startedAt: now - day,
    problem: true,
    uncorrectable: 4,
  });
  expect(
    integrity(filesystem(), { scrubs: [mine, newer] }, now, c).blocks,
  ).toBe(4);
});

test("output vsys could not read names no file", () => {
  const c = defaults();
  // Text that failed the readable check but still carries a parseable
  // address. Standing behind that address would list damaged files under a
  // headline saying the state is unknown.
  const item = integrity(
    filesystem(),
    {
      scrubs: [
        report({
          readable: false,
          problem: true,
          addresses: [{ logical: 1, paths: ["/r/target/a"] }],
        }),
      ],
    },
    now,
    c,
  );
  expect(item.state).toBe("unknown");
  expect(item.groups).toEqual([]);
});

test("an unreadable record of past growth cannot report a healthy filesystem", () => {
  const c = defaults();
  const item = integrity(
    filesystem({ lastErrorKnown: false }),
    { scrubs: [report()] },
    now,
    c,
  );
  expect(item.state).toBe("unknown");
  expect(item.errorKnown).toBe(false);
  // The same filesystem with a record that loaded reads healthy, so the state
  // turns on the record and on nothing else here.
  expect(integrity(filesystem(), { scrubs: [report()] }, now, c).state).toBe(
    "healthy",
  );
});

test("a check that repaired every error it found leaves no damage", () => {
  const c = defaults();
  // Btrfs rebuilt the bad copies from a good one. The data is intact, so the
  // filesystem does not read as damaged, however many errors were corrected.
  const corrected = integrity(
    filesystem(),
    { scrubs: [report({ problem: true, corrected: 5, uncorrectable: 0 })] },
    now,
    c,
  );
  expect(corrected.state).toBe("healthy");
  // A problem report whose uncorrectable count vsys could not read says
  // nothing either way, so it stays damage.
  expect(
    integrity(
      filesystem(),
      { scrubs: [report({ problem: true, uncorrectable: null })] },
      now,
      c,
    ).state,
  ).toBe("damaged");
});

test("only a check that says it finished counts as a check", () => {
  const c = defaults();
  // Every other status word, including one nothing has enumerated, leaves the
  // state unknown rather than standing in for a completed check.
  for (const status of [
    "failed",
    "aborted",
    "cancelled",
    "interrupted",
    "not started",
    "something new",
    null,
  ])
    expect({
      status,
      state: integrity(filesystem(), { scrubs: [report({ status })] }, now, c)
        .state,
    }).toEqual({ status, state: "unknown" });
  expect(
    integrity(filesystem(), { scrubs: [report({ status: "running" })] }, now, c)
      .state,
  ).toBe("checking");
  expect(
    integrity(
      filesystem(),
      { scrubs: [report({ status: "finished" })] },
      now,
      c,
    ).state,
  ).toBe("healthy");
});

test("a report names its filesystem however it spells the identity", () => {
  const c = defaults();
  const shouted = report({ fsid: "FS", problem: true, uncorrectable: 4 });
  expect(integrity(filesystem(), { scrubs: [shouted] }, now, c).blocks).toBe(4);
});

test("a check that has not finished offers no damaged file to act on", () => {
  const c = defaults();
  // A running check can already have written addresses. Standing behind them
  // would list damaged files under a check that has not said what it found.
  const running = integrity(
    filesystem(),
    {
      scrubs: [
        report({
          status: "running",
          problem: true,
          uncorrectable: 26,
          addresses: [{ logical: 1, paths: ["/r/target/a"] }],
        }),
      ],
    },
    now,
    c,
  );
  expect(running.state).toBe("checking");
  expect(running.groups).toEqual([]);
  expect(running.blocks).toBeNull();
  // The same report, finished, is a result.
  const done = integrity(
    filesystem(),
    {
      scrubs: [
        report({
          problem: true,
          uncorrectable: 26,
          addresses: [{ logical: 1, paths: ["/r/target/a"] }],
        }),
      ],
    },
    now,
    c,
  );
  expect(done.state).toBe("damaged");
  expect(done.groups).toHaveLength(1);
});
