import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { volumeSnapshot } from "../test/fixture";
import {
  damageCounts,
  globMatch,
  type IntegrityState,
  integrity,
  integrityLevel,
  volumesByDevice,
} from "./integrity";
import type { Scrub, Volume } from "./types";
import type { Level } from "./verdict";

const day = 86400000;
const now = 1_760_000_000_000;
/** One filesystem with a readable counter, named so a report can match it. */
function filesystem(overrides: Partial<Volume> = {}) {
  return volumesByDevice([
    volumeSnapshot("/", {
      fsid: "fs",
      errors: { "1/corruption_errs": 0 },
      countersAvailable: true,
      ...overrides,
    }),
  ])[0];
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

test("a glob crosses directories only where it says it does", () => {
  const rows: [string, string, boolean][] = [
    ["**/target/**", "/repo/target/debug/x", true],
    ["**/target/**", "/target/debug/x", true],
    // The must-fail direction: a file named target is not a target directory,
    // and a directory whose name merely ends in target is not one either.
    ["**/target/**", "/repo/target", false],
    ["**/target/**", "/repo/mytarget/debug/x", false],
    ["**/node_modules/**", "/a/b/node_modules/c/d", true],
    ["**/.cache/**", "/home/r/.cache/x", true],
    ["**/.cache/**", "/home/r/cache/x", false],
    ["/repo/*/x", "/repo/one/x", true],
    ["/repo/*/x", "/repo/one/two/x", false],
    ["/repo/?.txt", "/repo/a.txt", true],
    ["/repo/?.txt", "/repo/ab.txt", false],
  ];
  for (const [pattern, path, matches] of rows)
    expect({ pattern, path, matches: globMatch(pattern, path) }).toEqual({
      pattern,
      path,
      matches,
    });
});

test("an address is build output only when every name under it is", () => {
  const c = defaults();
  const item = integrity(
    filesystem(),
    [
      report({
        problem: true,
        uncorrectable: 3,
        addresses: [
          {
            logical: 1,
            paths: ["/r/target/debug/a", "/r/target/debug/b"],
          },
          // One name outside build output makes the whole address data: the
          // delete command removes every name, so calling this safe would
          // invite the reader to delete the letter with the object file.
          { logical: 2, paths: ["/r/target/debug/c", "/home/r/letter.txt"] },
          { logical: 3, paths: [] },
        ],
      }),
    ],
    now,
    c,
  );
  expect(item.groups.map((group) => group.kind)).toEqual([
    "build",
    "other",
    "none",
  ]);
  expect(damageCounts(item)).toEqual({
    files: 4,
    build: 1,
    other: 1,
    free: 1,
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
    expect({ name, state: integrity(group, scrubs, now, c).state }).toEqual({
      name,
      state,
    });
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
    [report({ startedAt: now - 4 * day })],
    now,
    c,
  );
  expect(known.checkAge).toBe(4 * 86400);
  expect(known.errorAge).toBe(31 * 3600);
  expect(known.errorSize).toBe(26);
  const unknown = integrity(filesystem(), [], now, c);
  expect(unknown.checkAge).toBeNull();
  expect(unknown.errorAge).toBeNull();
});

test("a report names a filesystem by its own identity, not by arriving first", () => {
  const c = defaults();
  const other = report({
    fsid: "somewhere-else",
    problem: true,
    uncorrectable: 9,
  });
  const mine = report({ fsid: "fs", startedAt: now - 2 * day });
  expect(integrity(filesystem(), [other, mine], now, c).state).toBe("healthy");
  // The newest report for this filesystem is the one that speaks for it.
  const newer = report({
    fsid: "fs",
    startedAt: now - day,
    problem: true,
    uncorrectable: 4,
  });
  expect(integrity(filesystem(), [mine, newer], now, c).blocks).toBe(4);
});

test("output vsys could not read names no file and offers no delete", () => {
  const c = defaults();
  // Text that failed the readable check but still carries a parseable
  // address. Standing behind that address would put a delete command under a
  // headline saying the state is unknown.
  const item = integrity(
    filesystem(),
    [
      report({
        readable: false,
        problem: true,
        addresses: [{ logical: 1, paths: ["/r/target/a"] }],
      }),
    ],
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
    [report()],
    now,
    c,
  );
  expect(item.state).toBe("unknown");
  expect(item.errorKnown).toBe(false);
  // The same filesystem with a record that loaded reads healthy, so the state
  // turns on the record and on nothing else here.
  expect(integrity(filesystem(), [report()], now, c).state).toBe("healthy");
});

test("a check that repaired every error it found leaves no damage", () => {
  const c = defaults();
  // Btrfs rebuilt the bad copies from a good one. The data is intact, so the
  // filesystem does not read as damaged, however many errors were corrected.
  const corrected = integrity(
    filesystem(),
    [report({ problem: true, corrected: 5, uncorrectable: 0 })],
    now,
    c,
  );
  expect(corrected.state).toBe("healthy");
  // A problem report whose uncorrectable count vsys could not read says
  // nothing either way, so it stays damage.
  expect(
    integrity(
      filesystem(),
      [report({ problem: true, uncorrectable: null })],
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
      state: integrity(filesystem(), [report({ status })], now, c).state,
    }).toEqual({ status, state: "unknown" });
  expect(
    integrity(filesystem(), [report({ status: "running" })], now, c).state,
  ).toBe("checking");
  expect(
    integrity(filesystem(), [report({ status: "finished" })], now, c).state,
  ).toBe("healthy");
});

test("a report names its filesystem however it spells the identity", () => {
  const c = defaults();
  const shouted = report({ fsid: "FS", problem: true, uncorrectable: 4 });
  expect(integrity(filesystem(), [shouted], now, c).blocks).toBe(4);
});
