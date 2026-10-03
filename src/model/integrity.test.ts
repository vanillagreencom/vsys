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

test("damage known only from a remembered check counts as unread, never zero", () => {
  const c = defaults();
  // The current report stopped early, so it has no addresses of its own; the
  // only reason this filesystem is damaged is the remembered finished check.
  const item = integrity(
    filesystem(),
    {
      scrubs: [report({ status: "aborted", problem: true })],
      lastFinishedScrub: { fs: { at: now - 3 * day, damaged: true } },
    },
    now,
    c,
  );
  expect(item.state).toBe("damaged");
  expect(item.groups).toEqual([]);
  expect(damageCounts(item)).toEqual({
    files: null,
    free: null,
    unresolved: null,
    unnamed: null,
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
  // remembers the finished report separately, well inside the stale limit,
  // and it found no damage.
  const scrubs = [report({ status: "aborted", problem: true })];
  const lastFinishedScrub = { fs: { at: now - 3 * day, damaged: false } };
  // Growth after the remembered check, and before the aborted attempt: the
  // card naming "no full check has ever run" would be wrong here.
  const grown = integrity(
    filesystem({ lastErrorAt: now - 1 * day, lastErrorSize: 26 }),
    { scrubs, lastFinishedScrub },
    now,
    c,
  );
  expect(grown.state).toBe("new-errors");
  expect(grown.checkAge).toBe(3 * 86400);
  // No growth at all: a check that stopped early leaves the remembered
  // finished check standing, so the filesystem reads as sound as it was then
  // rather than as unknown.
  const quiet = integrity(filesystem(), { scrubs, lastFinishedScrub }, now, c);
  expect(quiet.state).toBe("healthy");
  expect(quiet.checkAge).toBe(3 * 86400);
  // Growth from before the remembered check is already covered by it, so it
  // is not new and the remembered check still stands for soundness.
  const covered = integrity(
    filesystem({ lastErrorAt: now - 5 * day, lastErrorSize: 26 }),
    { scrubs, lastFinishedScrub },
    now,
    c,
  );
  expect(covered.state).toBe("healthy");
});

test("a scrub report gone from disk still stands on a remembered finished check", () => {
  const c = defaults();
  // The report file itself is gone (deleted, or the directory transiently
  // unreadable), so storage carries no scrub for this filesystem at all. The
  // collector's memory of the last finished one must not read as if nothing
  // had ever been checked.
  const lastFinishedScrub = { fs: { at: now - 2 * 3600000, damaged: false } };
  const item = integrity(
    filesystem(),
    { scrubs: [], lastFinishedScrub },
    now,
    c,
  );
  expect(item.state).not.toBe("never-checked");
  expect(item.state).toBe("healthy");
  expect(item.checkAge).toBe(2 * 3600);
});

test("a remembered finished check that found damage is never promoted to healthy or stale", () => {
  const c = defaults();
  const lastFinishedScrub = { fs: { at: now - 3 * day, damaged: true } };
  // The current report vanished entirely (deleted, or the directory
  // transiently unreadable). The remembered damage must still speak.
  const gone = integrity(
    filesystem(),
    { scrubs: [], lastFinishedScrub },
    now,
    c,
  );
  expect(gone.state).toBe("damaged");
  expect(gone.state).not.toBe("healthy");
  expect(gone.state).not.toBe("stale");
  // The current report exists but stopped early, finding nothing of its own.
  // The remembered damage still must not be silently cleared.
  const aborted = integrity(
    filesystem(),
    {
      scrubs: [report({ status: "aborted", problem: true })],
      lastFinishedScrub,
    },
    now,
    c,
  );
  expect(aborted.state).toBe("damaged");
  expect(aborted.state).not.toBe("healthy");
  expect(aborted.state).not.toBe("stale");
  // A later report that itself finishes clean moves the memory forward and
  // clears the remembered damage.
  const healed = integrity(
    filesystem(),
    { scrubs: [report({ startedAt: now - 3600000 })], lastFinishedScrub },
    now,
    c,
  );
  expect(healed.state).toBe("healthy");
});

test("a finished report that moved backward in time never outranks the remembered check", () => {
  const c = defaults();
  const lastFinishedScrub = { fs: { at: now - 3 * day, damaged: true } };
  // A restored older report: it is itself finished and reports real damage of
  // its own, but it started before the remembered finished check that found
  // damage. It must not read as the authoritative, newer check, so its own
  // damage data must not surface either.
  const older = integrity(
    filesystem(),
    {
      scrubs: [
        report({
          startedAt: now - 5 * day,
          problem: true,
          uncorrectable: 3,
          addresses: [{ logical: 1, paths: ["/r/target/x"] }],
        }),
      ],
      lastFinishedScrub,
    },
    now,
    c,
  );
  expect(older.state).toBe("damaged");
  expect(older.checkAge).toBe(3 * 86400);
  expect(older.groups).toEqual([]);
  expect(older.blocks).toBeNull();
  expect(damageCounts(older)).toEqual({
    files: null,
    free: null,
    unresolved: null,
    unnamed: null,
  });
  // A report exactly as new as the remembered check speaks for itself.
  const tied = integrity(
    filesystem(),
    {
      scrubs: [report({ startedAt: now - 3 * day })],
      lastFinishedScrub,
    },
    now,
    c,
  );
  expect(tied.state).toBe("healthy");
  expect(tied.checkAge).toBe(3 * 86400);
  // Mirror polarity: the remembered check is clean, and the backward-moved
  // report is the one reporting damage. The stale report still does not
  // outrank the newer, clean, remembered check.
  const staleDamage = integrity(
    filesystem(),
    {
      scrubs: [
        report({
          startedAt: now - 5 * day,
          problem: true,
          uncorrectable: 3,
          addresses: [{ logical: 1, paths: ["/r/target/x"] }],
        }),
      ],
      lastFinishedScrub: { fs: { at: now - 3 * day, damaged: false } },
    },
    now,
    c,
  );
  expect(staleDamage.state).toBe("healthy");
  expect(staleDamage.groups).toEqual([]);
  expect(staleDamage.blocks).toBeNull();
});

test("a finished report with no readable start time still speaks for itself", () => {
  const c = defaults();
  // The report finished and carries real damage, but its own start time could
  // not be read. An unknown start time is not known to be older than the
  // remembered check, so the report still stands behind its own data, and a
  // clean remembered check must not mask the damage it found.
  const undatedDamage = integrity(
    filesystem(),
    {
      scrubs: [
        report({
          startedAt: null,
          problem: true,
          uncorrectable: 3,
          addresses: [{ logical: 1, paths: ["/r/target/x"] }],
        }),
      ],
      lastFinishedScrub: { fs: { at: now - 3 * day, damaged: false } },
    },
    now,
    c,
  );
  expect(undatedDamage.state).toBe("damaged");
  expect(undatedDamage.blocks).toBe(3);
  expect(undatedDamage.groups).toEqual([
    { logical: 1, paths: ["/r/target/x"], kind: "files" },
  ]);
  // The accepted scope boundary: an undated report that finished clean still
  // clears a remembered damaged check, rather than letting the memory of
  // damage outrank a newer, if undated, clean result. It reads "unknown"
  // rather than "healthy", because a report with no start time dates no
  // check, which matches pre-existing behavior for a dateless report.
  const undatedClean = integrity(
    filesystem(),
    {
      scrubs: [report({ startedAt: null })],
      lastFinishedScrub: { fs: { at: now - 3 * day, damaged: true } },
    },
    now,
    c,
  );
  expect(undatedClean.state).toBe("unknown");
});

test("the remembered check, not the aborted one, decides which logged failures are new", () => {
  const c = defaults();
  const scrubs = [report({ status: "aborted", problem: true })];
  const lastFinishedScrub = { fs: { at: now - 3 * day, damaged: false } };
  const before = { root: 257, inode: 1, at: now - 4 * day };
  const after = { root: 257, inode: 2, at: now - 1 * day };
  const item = integrity(
    filesystem(),
    { scrubs, lastFinishedScrub, csumFailures: { fs: [before, after] } },
    now,
    c,
  );
  // The failure before the remembered check is already covered by it; only
  // the one after is unread damage.
  expect(item.logged).toEqual([after]);
  expect(item.state).toBe("new-errors");
  expect(item.errorSource).toBe("kernel-log");
  // With only the covered failure, the remembered check still stands.
  const onlyBefore = integrity(
    filesystem(),
    { scrubs, lastFinishedScrub, csumFailures: { fs: [before] } },
    now,
    c,
  );
  expect(onlyBefore.logged).toEqual([]);
  expect(onlyBefore.state).toBe("healthy");
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

test("growth a finished scrub could have counted is that scrub's finding, not new errors", () => {
  const c = defaults();
  // The scrub started an hour ago and ran thirty minutes. The kernel counts
  // every mismatch the scrub finds, and vsys dates that growth at the sample
  // that saw it, which follows the scrub's end when no vsys process watched
  // it. The reading before that sample bounds when the growth happened.
  const startedAt = now - 3600000;
  const endedAt = startedAt + 30 * 60000;
  const ahead = startedAt - 60000;
  const during = now - 40 * 60000;
  const after = now - 20 * 60000;
  const scrub = (overrides: Partial<Scrub> = {}) =>
    report({
      problem: true,
      startedAt,
      duration: 30 * 60000,
      corrected: 3,
      uncorrectable: 0,
      ...overrides,
    });
  const grew = (at: number, before: number | null, size: number | null) => ({
    lastErrorAt: at,
    lastErrorBefore: before,
    lastErrorSize: size,
  });
  const rows: [string, Partial<Volume>, Scrub[], IntegrityState][] = [
    [
      "growth seen during the run that the scrub corrected",
      grew(during, ahead, 3),
      [scrub()],
      "healthy",
    ],
    [
      "growth first seen after the run, the reading before it taken during the run",
      grew(after, during, 3),
      [scrub()],
      "healthy",
    ],
    [
      "growth first seen after the run, the reading before it taken before the run",
      grew(after, ahead, 3),
      [scrub()],
      "healthy",
    ],
    [
      "the reading before the growth taken the moment the run ended",
      grew(after, endedAt, 3),
      [scrub()],
      "healthy",
    ],
    [
      "the reading before the growth taken after the run ended",
      grew(after, endedAt + 1, 3),
      [scrub()],
      "new-errors",
    ],
    [
      "growth larger than the scrub counted",
      grew(during, ahead, 4),
      [scrub()],
      "new-errors",
    ],
    [
      "a report that does not say how long it ran",
      grew(during, ahead, 3),
      [scrub({ duration: null })],
      "new-errors",
    ],
    [
      "a report whose corrected count is unread",
      grew(during, ahead, 3),
      [scrub({ corrected: null })],
      "new-errors",
    ],
    [
      "growth whose size is unread",
      grew(during, ahead, null),
      [scrub()],
      "new-errors",
    ],
    [
      "growth whose reading before it is unread",
      grew(during, null, 3),
      [scrub()],
      "new-errors",
    ],
  ];
  for (const [name, volume, scrubs, state] of rows)
    expect({
      name,
      state: integrity(filesystem(volume), { scrubs }, now, c).state,
    }).toEqual({ name, state });
  // The remembered check covers the same growth once a later scrub that
  // stopped early overwrote its report.
  const remembered = (covers: { endedAt: number; errors: number }) =>
    integrity(
      filesystem(grew(after, during, 3)),
      {
        scrubs: [report({ status: "aborted", problem: true, startedAt: now })],
        lastFinishedScrub: { fs: { at: startedAt, damaged: false, covers } },
      },
      now,
      c,
    ).state;
  expect(remembered({ endedAt, errors: 3 })).toBe("healthy");
  expect(remembered({ endedAt: during - 1, errors: 3 })).toBe("new-errors");
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
