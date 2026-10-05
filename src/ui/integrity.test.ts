import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { integrity, volumesByDevice } from "../model/integrity";
import type { Capability, CsumFailure, Scrub } from "../model/types";
import { volumeSnapshot } from "../test/fixture";
import { present } from "../test/present";
import {
  blocksText,
  clearedText,
  damageAdvice,
  integrityLine,
  integrityWords,
  loggedText,
  noDamageText,
  unnamedText,
} from "./integrity";

const day = 86400000;
const now = 1_760_000_000_000;
const c = defaults();
function state(scrubs: Scrub[], lastErrorAt: number | null = null) {
  return integrity(
    present(
      volumesByDevice([
        volumeSnapshot("/", {
          fsid: "fs",
          errors: { "1/corruption_errs": 1390 },
          countersAvailable: true,
          lastErrorAt,
          lastErrorSize: lastErrorAt === null ? null : 26,
        }),
      ])[0],
      "root device",
    ),
    { scrubs },
    now,
    c,
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

test("the line answers both questions without opening anything", () => {
  // The case that started this: a counter flat for 31 hours, a check four days
  // old. A flat counter is not a healthy disk, and the line says so.
  const line = integrityLine(
    state([report({ startedAt: now - 4 * day })], now - 31 * 3600000),
  );
  expect(line).toBe(
    "New errors since last check · last full check 4.0d ago (scrub report) · last new error 31.0h ago (error counter)",
  );
  // Nothing checked, nothing recorded: both times say so rather than reading
  // as zero or as healthy.
  expect(integrityLine(state([]))).toBe(
    "Never checked · last full check never · last new error none (error counter)",
  );
});

test("the line names the source of each time it gives", () => {
  const failure: CsumFailure = { root: 257, inode: 4242, at: now - 7200000 };
  const absent: Capability = {
    id: "scrub",
    available: false,
    failure: "absent",
    source: "/run/btrfs-scrub",
    detail: "ENOENT: no such file or directory",
  };
  const item = (
    scrubs: Scrub[],
    csumFailures: Record<string, CsumFailure[]> | null,
    countersAvailable = true,
  ) =>
    integrity(
      present(
        volumesByDevice([
          volumeSnapshot("/", {
            fsid: "fs",
            errors: countersAvailable ? { "1/corruption_errs": 0 } : {},
            countersAvailable,
          }),
        ])[0],
        "root device",
      ),
      { scrubs, csumFailures },
      now,
      c,
    );
  const rows: [string, string][] = [
    [
      integrityLine(item([report()], { fs: [failure] })),
      "New errors since last check · last full check 24.0h ago (scrub report) · last new error 2.0h ago (kernel log)",
    ],
    [
      integrityLine(item([report()], {})),
      "Healthy · last full check 24.0h ago (scrub report) · last new error none (error counter, kernel log)",
    ],
    [
      integrityLine(item([report()], null)),
      "Healthy · last full check 24.0h ago (scrub report) · last new error none (error counter)",
    ],
    [
      integrityLine(item([], { fs: [failure] }), absent),
      "New errors since last check · last full check never · last new error 2.0h ago (kernel log)",
    ],
    [
      integrityLine(item([], null), absent),
      "Never checked: no readable scrub report directory · last full check never · last new error none (error counter)",
    ],
    // A counter vsys could not read recorded nothing either way, so "none"
    // names only the log, and with neither read the time is not available.
    [
      integrityLine(item([report()], {}, false)),
      "Damage state unknown · last full check 24.0h ago (scrub report) · last new error none (kernel log)",
    ],
    [
      integrityLine(item([report()], null, false)),
      "Damage state unknown · last full check 24.0h ago (scrub report) · last new error not available",
    ],
  ];
  for (const [line, expected] of rows) expect(line).toBe(expected);
  expect(loggedText(failure, now)).toBe(
    "inode 4242 in subvolume 257, logged 2.0h ago",
  );
});

test("no words but Healthy say the filesystem was checked and found sound", () => {
  expect(integrityWords(state([report()], null))).toBe("Healthy");
  expect(integrityWords(state([]))).toBe("Never checked");
  expect(integrityWords(state([report({ startedAt: now - 40 * day })]))).toBe(
    "Not checked in 40.0d",
  );
  expect(integrityWords(state([report({ status: "running" })]))).toBe(
    "Checking now",
  );
  expect(
    integrityWords(state([report({ readable: false, problem: true })])),
  ).toBe("Damage state unknown");
});

test("the damaged-file headline counts possibly damaged files and the blocks none covers", () => {
  const addresses = [
    { logical: 1, paths: ["/r/target/a", "/r/target/b"] },
    { logical: 2, paths: ["/home/r/letter.txt"] },
  ];
  const named = state([report({ problem: true, uncorrectable: 2, addresses })]);
  expect(integrityWords(named)).toBe("Damage found: 3 possibly damaged files");
  // The check counted more blocks than the report names, so the files listed
  // are not all of the damage, and the headline says how many are not.
  const partial = state([
    report({ problem: true, uncorrectable: 26, addresses }),
  ]);
  expect(integrityWords(partial)).toBe(
    "Damage found: 3 possibly damaged files, 24 blocks unnamed",
  );
  expect(unnamedText(partial)).toBe(
    "The check counted 24 more damaged blocks than its report names, so the files above are not all of the damage.",
  );
  expect(unnamedText(named)).toBeUndefined();
  // An address the reporter could not name is unnamed damage too.
  const unresolved = state([
    report({
      problem: true,
      uncorrectable: 3,
      addresses: [...addresses, { logical: 3, paths: [], resolved: false }],
    }),
  ]);
  expect(integrityWords(unresolved)).toBe(
    "Damage found: 3 possibly damaged files, 1 block unnamed",
  );
  // A report naming no address under a counted block names none of them,
  // which is not a filesystem with nothing left.
  const none = state([
    report({ problem: true, uncorrectable: 3, addresses: [] }),
  ]);
  expect(noDamageText(none)).toBe(
    "The check counted 3 damaged blocks and its report names none of them, so no file is offered.",
  );
});

test("every name of an address is listed, and each address says what it names", () => {
  const item = state([
    report({
      problem: true,
      addresses: [
        {
          logical: 953118621696,
          paths: [
            "/r/target/debug/build/glib-sys/build-script-build",
            "/r/target/debug/build/glib-sys/build_script_build-c664",
          ],
        },
        { logical: 2, paths: ["/home/r/letter.txt"] },
        { logical: 3, paths: [] },
        { logical: 4, paths: [], resolved: false },
      ],
    }),
  ]);
  // Both names of one extent are listed: the check read the block, and either
  // name can be the file the damage sits in.
  expect(present(item.groups[0], "build output group").paths).toEqual([
    "/r/target/debug/build/glib-sys/build-script-build",
    "/r/target/debug/build/glib-sys/build_script_build-c664",
  ]);
  // Build output and a letter read alike: the block start names no file
  // exactly, so neither is called safe to remove.
  expect(item.groups.map(damageAdvice)).toEqual([
    "possibly damaged",
    "possibly damaged",
    "free space or already deleted, clears on the next check",
    "its files could not be named",
  ]);
});

test("an absent damaged-file list never reads as a check that found none", () => {
  // Three different facts, told apart: nothing checked, a report that cannot
  // name files, and a check that named none.
  expect(noDamageText(state([]))).toBe(
    "No check has reported on this filesystem, so no file is named.",
  );
  expect(noDamageText(state([report({ addresses: null })]))).toBe(
    "The report carries no damaged-file section, so it names no file. That is not a report of none.",
  );
  expect(noDamageText(state([report()]))).toBe(
    "No damaged address is left on this filesystem.",
  );
});

test("a block count vsys did not read never reads as a count of none", () => {
  // Three different facts, told apart, because a zero here would say the last
  // check looked and found nothing.
  expect(blocksText(state([]))).toBe(
    "not available: no check has reported on this filesystem",
  );
  expect(blocksText(state([report({ uncorrectable: null })]))).toBe(
    "not available: the report carried no count",
  );
  expect(
    blocksText(state([report({ uncorrectable: 26, problem: true })])),
  ).toBe("26 by the last full check");
});

test("an unreadable record of past growth is not a record of no errors", () => {
  const unreadable = integrity(
    present(
      volumesByDevice([
        volumeSnapshot("/", {
          fsid: "fs",
          errors: { "1/corruption_errs": 1390 },
          countersAvailable: true,
          lastErrorKnown: false,
        }),
      ])[0],
      "root device",
    ),
    { scrubs: [report()] },
    now,
    c,
  );
  expect(integrityLine(unreadable)).toContain("last new error not available");
  // The kernel log dated a failure, so the line gives it with its source even
  // though the counter's record could not be read.
  const logged = integrity(
    present(
      volumesByDevice([
        volumeSnapshot("/", {
          fsid: "fs",
          errors: { "1/corruption_errs": 1390 },
          countersAvailable: true,
          lastErrorKnown: false,
        }),
      ])[0],
      "root device",
    ),
    {
      scrubs: [],
      csumFailures: { fs: [{ root: 5, inode: 9, at: now - 7200000 }] },
    },
    now,
    c,
  );
  expect(integrityLine(logged)).toBe(
    "New errors since last check · last full check never · last new error 2.0h ago (kernel log)",
  );
  expect(integrityLine(state([report()]))).toContain(
    "last new error none (error counter)",
  );
});

test("nothing parsed from unreadable output is reported as a reading", () => {
  // The report happens to carry a count and an address-shaped line, but its
  // output as a whole could not be read, so neither is a reading.
  const item = state([
    report({
      readable: false,
      problem: true,
      uncorrectable: 26,
      addresses: [{ logical: 1, paths: ["/r/target/a"] }],
    }),
  ]);
  expect(integrityWords(item)).toBe("Damage state unknown");
  expect(blocksText(item)).toBe("not available: the report could not be read");
  expect(noDamageText(item)).toBe(
    "The report could not be read, so nothing in it names a file.",
  );
});

test("a finished report superseded by a newer remembered check is not told it never finished", () => {
  // A restored older report: it finished and carries its own damage data, but
  // it started before the newer finished check vsys remembers. Its own count
  // and file list must not speak for the filesystem, and the reader must not
  // be told the check never finished when it did.
  const item = integrity(
    present(
      volumesByDevice([
        volumeSnapshot("/", {
          fsid: "fs",
          errors: { "1/corruption_errs": 0 },
          countersAvailable: true,
        }),
      ])[0],
      "root device",
    ),
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
  expect(blocksText(item)).toBe(
    "not available: a newer finished check is remembered instead, so this report's own count does not speak for it",
  );
  expect(noDamageText(item)).toBe(
    "A newer finished check is remembered instead, so this report's own file list does not speak for the damage.",
  );
});

test("a remembered finished check speaks when its current report is unavailable", () => {
  // The scrub report itself has vanished, but the collector remembers a
  // finished check for this filesystem, found via its own damaged flag. The
  // integrity card's age line already names that remembered check, so the
  // block count and file-list sentences must say what it found rather than
  // claiming nothing has reported, or that the current report's absence is
  // confirmed to be a removal rather than merely unavailable.
  const clean = integrity(
    present(
      volumesByDevice([
        volumeSnapshot("/", {
          fsid: "fs",
          errors: { "1/corruption_errs": 0 },
          countersAvailable: true,
        }),
      ])[0],
      "root device",
    ),
    {
      scrubs: [],
      lastFinishedScrub: { fs: { at: now - 2 * day, damaged: false } },
    },
    now,
    c,
  );
  expect(blocksText(clean)).toBe(
    "not available: a remembered finished check found no damage, but its current report is unavailable, so no count was kept",
  );
  expect(noDamageText(clean)).toBe(
    "A remembered finished check found no damage, and its current report is unavailable, so no file is named.",
  );
  const damaged = integrity(
    present(
      volumesByDevice([
        volumeSnapshot("/", {
          fsid: "fs",
          errors: { "1/corruption_errs": 0 },
          countersAvailable: true,
        }),
      ])[0],
      "root device",
    ),
    {
      scrubs: [],
      lastFinishedScrub: { fs: { at: now - 2 * day, damaged: true } },
    },
    now,
    c,
  );
  expect(blocksText(damaged)).toBe(
    "not available: a remembered finished check found damage, but its current report is unavailable, so no count was kept",
  );
  expect(noDamageText(damaged)).toBe(
    "A remembered finished check found damage, but its current report is unavailable, so no file is named for it.",
  );
});

test("an unreadable report that cannot be matched to a filesystem is not read as a gone report", () => {
  // readdir succeeded (the scrub directory capability stays available), but
  // this filesystem's own report file could not be read, so the collector
  // pushes it with fsid: null and readable: false. reportFor() matches by
  // fsid, so a null-fsid entry attaches to no filesystem, and item.scrub
  // stays null exactly as if no report had ever been written. vsys has not
  // established that the report is gone -- it may exist on disk right now,
  // just unreadable and unmatched -- so the remembered-check sentence must
  // say "unavailable", never "gone".
  const unreadableFsidNull: Scrub = {
    path: "/run/btrfs-scrub/root.result",
    text: "",
    readable: false,
    problem: true,
    fsid: null,
    startedAt: null,
    status: null,
    uncorrectable: null,
    corrected: null,
    addresses: null,
  };
  const item = integrity(
    present(
      volumesByDevice([
        volumeSnapshot("/", {
          fsid: "fs",
          errors: { "1/corruption_errs": 0 },
          countersAvailable: true,
        }),
      ])[0],
      "root device",
    ),
    {
      scrubs: [unreadableFsidNull],
      lastFinishedScrub: { fs: { at: now - 2 * day, damaged: true } },
    },
    now,
    c,
  );
  const available: Capability = {
    id: "scrub",
    available: true,
    failure: null,
    source: "/run/btrfs-scrub",
    detail: "",
  };
  expect(item.scrub).toBeNull();
  expect(blocksText(item, available)).toBe(
    "not available: a remembered finished check found damage, but its current report is unavailable, so no count was kept",
  );
  expect(noDamageText(item, available)).toBe(
    "A remembered finished check found damage, but its current report is unavailable, so no file is named for it.",
  );
});

test("a failed directory read is never read as a report that is gone", () => {
  // The directory listing itself failed this sample (or has never run), so
  // storage.scrubs is empty for a reason that has nothing to do with whether
  // a report exists: vsys must say the read failed, not that the remembered
  // check's report is gone, even where a finished check is remembered.
  const failedScrub: Capability = {
    id: "scrub",
    available: false,
    failure: "unreadable",
    source: "/run/btrfs-scrub",
    detail: "EACCES: permission denied",
  };
  const withMemory = integrity(
    present(
      volumesByDevice([
        volumeSnapshot("/", {
          fsid: "fs",
          errors: { "1/corruption_errs": 0 },
          countersAvailable: true,
        }),
      ])[0],
      "root device",
    ),
    {
      scrubs: [],
      lastFinishedScrub: { fs: { at: now - 2 * day, damaged: true } },
    },
    now,
    c,
  );
  expect(blocksText(withMemory, failedScrub)).toBe(
    "not available: /run/btrfs-scrub exists but cannot be read",
  );
  expect(noDamageText(withMemory, failedScrub)).toBe(
    "/run/btrfs-scrub exists but cannot be read, so no file is named.",
  );
  // No memory either: same read-failure wording, not "no check has reported".
  const noMemory = state([]);
  expect(blocksText(noMemory, failedScrub)).toBe(
    "not available: /run/btrfs-scrub exists but cannot be read",
  );
  expect(noDamageText(noMemory, failedScrub)).toBe(
    "/run/btrfs-scrub exists but cannot be read, so no file is named.",
  );
});

test("a check that has not finished counted nothing, and its report is not blamed", () => {
  // A running check is a different fact from a report that omitted its count.
  const running = state([report({ status: "running", uncorrectable: 26 })]);
  expect(blocksText(running)).toBe("not available: the check has not finished");
  expect(noDamageText(running)).toBe(
    "The check has not finished, so it has named no file yet.",
  );
  // A finished report that carried no count is still that.
  expect(blocksText(state([report({ uncorrectable: null })]))).toBe(
    "not available: the report carried no count",
  );
});

test("cleared failures a year apart never read as one day", () => {
  const year = 365 * day;
  const at = now - 20 * day;
  const oneDay = { first: at, last: at, checkedAt: now - 3600000 };
  expect(clearedText({ ...oneDay, first: at - year })).not.toBe(
    clearedText(oneDay),
  );
});
