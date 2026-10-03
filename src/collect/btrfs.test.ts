import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type IntegrityState, integrities } from "../model/integrity";
import { point } from "../store/point";
import { emptySnapshot, fixture } from "../test/fixture";
import { btrfsMounts, StorageCollector, scrubProblem } from "./btrfs";
import { Reader } from "./io";
import { parseMounts } from "./mounts";
import { ScratchCollector } from "./scratch";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
test("mount options retain both mount and superblock read-only flags", () => {
  expect(
    btrfsMounts(
      parseMounts(
        "1 0 0:1 / /mnt/a\\040b rw,nosuid - btrfs /dev/test ro,compress=zstd\n",
      ),
    )[0],
  ).toEqual({
    mount: "/mnt/a b",
    device: "/dev/test",
    readOnly: true,
    options: ["rw", "nosuid", "ro", "compress=zstd"],
  });
  expect(
    btrfsMounts(parseMounts("1 0 0:1 / / rw - ext4 /dev/test rw")),
  ).toEqual([]);
});
test("counter deltas use device identity and preserve startup baseline", async () => {
  const f = fixture();
  fixtures.push(f);
  const root = join(f.config.btrfsRoot, "fsid");
  mkdirSync(join(root, "devices"), { recursive: true });
  symlinkSync("/sys/devices/test", join(root, "devices/test"));
  const file = join(root, "devinfo/1/error_stats");
  f.write(
    file,
    "corruption_errs 2\nwrite_errs 0\nread_errs 0\nflush_errs 0\ngeneration_errs 0",
  );
  f.write(
    join(f.config.procRoot, "self/mountinfo"),
    `1 0 0:1 / ${f.root} rw - btrfs /dev/test rw`,
  );
  const collector = new StorageCollector();
  const r = new Reader();
  const first = await collector.collect(r, f.config, 1000);
  expect(first.volumes[0]?.delta["1/corruption_errs"]).toBe(0);
  f.write(
    file,
    "corruption_errs 5\nwrite_errs 0\nread_errs 0\nflush_errs 0\ngeneration_errs 0",
  );
  const second = await collector.collect(r, f.config, 2000);
  expect(second.volumes[0]?.delta["1/corruption_errs"]).toBe(3);
  expect(second.volumes[0]?.sinceStart["1/corruption_errs"]).toBe(3);
  f.write(
    file,
    "corruption_errs 6\nwrite_errs 0\nread_errs 0\nflush_errs 0\ngeneration_errs 0",
  );
  const third = await collector.collect(r, f.config, 3000);
  expect(third.volumes[0]?.delta["1/corruption_errs"]).toBe(1);
  expect(third.volumes[0]?.sinceStart["1/corruption_errs"]).toBe(4);
  expect(r.errors).toEqual([]);
  unlinkSync(file);
  const missing = await collector.collect(r, f.config, 4000);
  const snapshot = emptySnapshot();
  snapshot.storage = missing;
  expect(point(snapshot, f.config).corruption).toBeNull();
});
test("scrub errors and unknown output cannot report healthy", () => {
  for (const [text, problem] of [
    ["Error summary: no errors found", false],
    ["Error summary: 2 errors", true],
    ["Status: aborted", true],
    ["read_errors=0 csum_errors=1", true],
  ] as const)
    expect(scrubProblem(text)).toBe(problem);
  expect(() => scrubProblem("unexpected output")).toThrow();
});
test("aborted scrub stays a problem even when no errors were counted", () => {
  expect(
    scrubProblem(
      "Status: aborted\nError summary: no errors found\nUncorrectable: 0",
    ),
  ).toBe(true);
});
test("an interrupted scrub report is not a clean one", async () => {
  const f = fixture();
  fixtures.push(f);
  f.write(
    join(f.config.scrubDir, "-.result"),
    `btrfs scrub did not complete (interrupted): /
UUID:             2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6
Scrub started:    Fri Sep 11 13:25:54 2026
Status:           interrupted
Duration:         0:03:10
Error summary:    no errors found
`,
  );
  const storage = await new StorageCollector().collect(
    new Reader(),
    f.config,
    1000,
  );
  expect(storage.scrubs[0]?.status).toBe("interrupted");
  expect(storage.scrubs[0]?.problem).toBe(true);
});
test("a report is matched to its filesystem and lists only files still there", async () => {
  const f = fixture();
  fixtures.push(f);
  const uuid = "2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6";
  const root = join(f.config.btrfsRoot, uuid);
  mkdirSync(join(root, "devices"), { recursive: true });
  symlinkSync("/sys/devices/test", join(root, "devices/test"));
  f.write(
    join(root, "devinfo/1/error_stats"),
    "corruption_errs 26\nwrite_errs 0\nread_errs 0\nflush_errs 0\ngeneration_errs 0",
  );
  f.write(
    join(f.config.procRoot, "self/mountinfo"),
    `1 0 0:1 / ${f.root} rw - btrfs /dev/test rw`,
  );
  const kept = join(f.root, "target/debug/build-script-build");
  const gone = join(f.root, "target/debug/build_script_build-c664");
  f.write(kept, "");
  f.write(gone, "");
  f.write(
    join(f.config.scrubDir, "root.result"),
    `btrfs scrub finished, csum=26: /
UUID:             ${uuid}
Scrub started:    Fri Sep 11 13:25:54 2026
Status:           finished
Error summary:    csum=26
  Corrected:      0
  Uncorrectable:  26

Damaged files: 1 damaged block address from the kernel log.
logical 953118621696:
  ${kept}
  ${gone}
`,
  );
  const r = new Reader();
  const collector = new StorageCollector();
  const first = await collector.collect(r, f.config, 1000);
  expect(first.scrubs[0]?.fsid).toBe(uuid);
  expect(first.scrubs[0]?.uncorrectable).toBe(26);
  expect(first.scrubs[0]?.addresses).toEqual([
    { logical: 953118621696, paths: [kept, gone] },
  ]);
  // The reader removes one of the two names. It leaves the list; the name
  // still on disk stays, because the damage is still there.
  unlinkSync(gone);
  const second = await collector.collect(r, f.config, 2000);
  expect(second.scrubs[0]?.addresses).toEqual([
    { logical: 953118621696, paths: [kept] },
  ]);
  expect(r.errors).toEqual([]);
});

test("a later scrub that stops early keeps the memory of the one it overwrote", async () => {
  const f = fixture();
  fixtures.push(f);
  const uuid = "2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6";
  const root = join(f.config.btrfsRoot, uuid);
  mkdirSync(join(root, "devices"), { recursive: true });
  symlinkSync("/sys/devices/test", join(root, "devices/test"));
  f.write(
    join(root, "devinfo/1/error_stats"),
    "corruption_errs 0\nwrite_errs 0\nread_errs 0\nflush_errs 0\ngeneration_errs 0",
  );
  f.write(
    join(f.config.procRoot, "self/mountinfo"),
    `1 0 0:1 / ${f.root} rw - btrfs /dev/test rw`,
  );
  // Mixed case, as btrfs itself prints it, so the memory only matches this
  // test if the collector lowercases the UUID before keying its memory.
  const reportedUuid = "2FF9DD6D-1b2c-4D5E-8f90-A1B2C3D4E5F6";
  const reportPath = join(f.config.scrubDir, "root.result");
  f.write(
    reportPath,
    `btrfs scrub finished, no errors found: /
UUID:             ${reportedUuid}
Scrub started:    Fri Sep 11 13:25:54 2026
Status:           finished
Error summary:    no errors found
`,
  );
  const r = new Reader();
  const collector = new StorageCollector();
  const first = await collector.collect(r, f.config, 1000);
  const key = uuid.toLowerCase();
  const finishedAt = first.scrubs[0]?.startedAt;
  expect(finishedAt).toBeTypeOf("number");
  expect(first.lastFinishedScrub?.[key]).toEqual({
    at: finishedAt as number,
    damaged: false,
    covers: null,
  });
  // The reporter's one report for this filesystem is overwritten by a scrub
  // that stops early. Nothing on disk still says the earlier one finished.
  f.write(
    reportPath,
    `btrfs scrub aborted after 00:00:01, interrupted: /
UUID:             ${reportedUuid}
Scrub started:    Sat Sep 12 09:00:00 2026
Status:           aborted
Error summary:    no errors found
`,
  );
  const second = await collector.collect(r, f.config, 2000);
  expect(second.scrubs[0]?.status).toBe("aborted");
  // The collector's own memory still holds the finished report's time and outcome.
  expect(second.lastFinishedScrub?.[key]).toEqual({
    at: finishedAt as number,
    damaged: false,
    covers: null,
  });
});

test("a finished scrub that found damage is remembered as damaged", async () => {
  const f = fixture();
  fixtures.push(f);
  const uuid = "2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6";
  const root = join(f.config.btrfsRoot, uuid);
  mkdirSync(join(root, "devices"), { recursive: true });
  symlinkSync("/sys/devices/test", join(root, "devices/test"));
  f.write(
    join(root, "devinfo/1/error_stats"),
    "corruption_errs 1\nwrite_errs 0\nread_errs 0\nflush_errs 0\ngeneration_errs 0",
  );
  f.write(
    join(f.config.procRoot, "self/mountinfo"),
    `1 0 0:1 / ${f.root} rw - btrfs /dev/test rw`,
  );
  const reportPath = join(f.config.scrubDir, "root.result");
  f.write(
    reportPath,
    `btrfs scrub finished, csum=1: /
UUID:             ${uuid}
Scrub started:    Fri Sep 11 13:25:54 2026
Status:           finished
Error summary:    csum=1
  Corrected:      0
  Uncorrectable:  1
`,
  );
  const r = new Reader();
  const collector = new StorageCollector();
  const first = await collector.collect(r, f.config, 1000);
  const key = uuid.toLowerCase();
  const finishedAt = first.scrubs[0]?.startedAt;
  expect(finishedAt).toBeTypeOf("number");
  expect(first.lastFinishedScrub?.[key]).toEqual({
    at: finishedAt as number,
    damaged: true,
    covers: null,
  });
  // A scrub that stops early overwrites the report naming that damage.
  // Nothing on disk still says the filesystem was ever found damaged.
  f.write(
    reportPath,
    `btrfs scrub aborted after 00:00:01, interrupted: /
UUID:             ${uuid}
Scrub started:    Sat Sep 12 09:00:00 2026
Status:           aborted
Error summary:    no errors found
`,
  );
  const second = await collector.collect(r, f.config, 2000);
  // The collector's memory still says that finished check found damage.
  expect(second.lastFinishedScrub?.[key]?.damaged).toBe(true);
});

const started = Date.parse("Fri Sep 11 13:25:54 2026");
/**
 * A filesystem whose scrub from `started` ran thirty minutes and corrected
 * three errors, with a writer for its corruption counter.
 */
function corrected() {
  const f = fixture();
  fixtures.push(f);
  const uuid = "2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6";
  const root = join(f.config.btrfsRoot, uuid);
  mkdirSync(join(root, "devices"), { recursive: true });
  symlinkSync("/sys/devices/test", join(root, "devices/test"));
  f.write(
    join(f.config.procRoot, "self/mountinfo"),
    `1 0 0:1 / ${f.root} rw - btrfs /dev/test rw`,
  );
  const reportPath = join(f.config.scrubDir, "root.result");
  f.write(
    reportPath,
    `btrfs scrub finished, csum=3: /
UUID:             ${uuid}
Scrub started:    Fri Sep 11 13:25:54 2026
Status:           finished
Duration:         0:30:00
Error summary:    csum=3
  Corrected:      3
  Uncorrectable:  0
  Unverified:     0
`,
  );
  const count = (n: number) =>
    f.write(
      join(root, "devinfo/1/error_stats"),
      `corruption_errs ${n}\nwrite_errs 0\nread_errs 0\nflush_errs 0\ngeneration_errs 0`,
    );
  return { f, uuid, reportPath, count };
}

test("a scrub that corrected every error it found is not new errors since that scrub", async () => {
  const { f, uuid, reportPath, count } = corrected();
  const collector = new StorageCollector();
  const r = new Reader();
  const state = async (time: number) => {
    const s = emptySnapshot();
    s.storage = await collector.collect(r, f.config, time);
    s.time = time;
    return { storage: s.storage, item: integrities(s, f.config)[0] };
  };
  count(0);
  await collector.collect(r, f.config, started - 60_000);
  // Five minutes into the scrub, the kernel has counted the three bad
  // copies it found and repaired.
  count(3);
  await collector.collect(r, f.config, started + 5 * 60_000);
  const finished = await state(started + 40 * 60_000);
  expect(finished.item?.complete).toBe(true);
  expect(finished.item?.state).toBe("healthy");
  expect(finished.storage.lastFinishedScrub?.[uuid]?.covers).toEqual({
    startedAt: started,
    endedAt: started + 30 * 60_000,
    errors: 3,
    csum: 3,
  });
  // A later scrub that stops early overwrites the report, and the
  // remembered check still accounts for the growth it found.
  f.write(
    reportPath,
    `btrfs scrub aborted after 00:00:01, interrupted: /
UUID:             ${uuid}
Scrub started:    Fri Sep 11 15:00:00 2026
Status:           aborted
Error summary:    no errors found
`,
  );
  expect((await state(started + 100 * 60_000)).item?.state).toBe("healthy");
  // Growth after the scrub ended is new however many it corrected.
  count(4);
  expect((await state(started + 110 * 60_000)).item?.state).toBe("new-errors");
});

test("a scrub covers growth this process bounded by its end, or its exact csum count from a baseline saved before it", async () => {
  // Each step reads the counter, minutes from the scrub's start, from the
  // same collector or a new one reading what the last saved, and names the
  // state it must read, or null.
  const rows: [string, [number, number, boolean, IntegrityState | null][]][] = [
    [
      "growth first seen after the scrub by the process that read before it",
      [
        [-1, 0, false, null],
        [40, 3, false, "healthy"],
      ],
    ],
    [
      "growth seen during the scrub, then more a new process sees a week later",
      [
        [-1, 0, false, null],
        [5, 3, false, null],
        [40, 3, true, "healthy"],
        [10080, 4, true, "new-errors"],
      ],
    ],
    [
      "a baseline saved an hour before the scrub, then growth a new process sees three days later",
      [
        [-60, 0, false, null],
        [4320, 1, true, "new-errors"],
      ],
    ],
    [
      "a baseline saved before the scrub, then the scrub's count a new process sees after it",
      [
        [-60, 0, false, null],
        [40, 3, true, "healthy"],
      ],
    ],
    [
      "the same, then a later new process days later still at the scrub's count",
      [
        [-60, 0, false, null],
        [40, 3, true, "healthy"],
        [4320, 3, true, "healthy"],
      ],
    ],
    [
      "a baseline saved before the scrub, then one more than its count a new process sees days later",
      [
        [-60, 0, false, null],
        [4320, 4, true, "new-errors"],
      ],
    ],
    [
      "a baseline saved after the scrub started, then its count a new process sees after it",
      [
        [5, 0, false, null],
        [40, 3, true, "new-errors"],
      ],
    ],
  ];
  for (const [name, steps] of rows) {
    const { f, count } = corrected();
    const r = new Reader();
    let collector = new StorageCollector();
    for (const [minutes, counter, fresh, want] of steps) {
      if (fresh) collector = new StorageCollector();
      count(counter);
      const s = emptySnapshot();
      s.time = started + minutes * 60_000;
      s.storage = await collector.collect(r, f.config, s.time);
      const state = integrities(s, f.config)[0]?.state;
      if (want)
        expect({ name, minutes, state }).toEqual({
          name,
          minutes,
          state: want,
        });
    }
  }
});

test("a stored reading is dated when the counter was read, not when its sample began", async () => {
  const { f, count } = corrected();
  const r = new Reader();
  // A sample that began a moment before the scrub started read the counter
  // after it, with the scrub's first error already counted.
  count(1);
  await new StorageCollector().collect(
    r,
    f.config,
    started - 1000,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => started + 1000,
  );
  // A new process after the scrub sees the scrub's other two errors and one
  // failure after it: growth of the csum count that is not the scrub's own.
  count(4);
  const s = emptySnapshot();
  s.time = started + 40 * 60_000;
  s.storage = await new StorageCollector().collect(r, f.config, s.time);
  expect(integrities(s, f.config)[0]?.state).toBe("new-errors");
});

test("a stale finished report never moves the remembered time backward", async () => {
  const f = fixture();
  fixtures.push(f);
  const uuid = "2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6";
  const root = join(f.config.btrfsRoot, uuid);
  mkdirSync(join(root, "devices"), { recursive: true });
  symlinkSync("/sys/devices/test", join(root, "devices/test"));
  f.write(
    join(root, "devinfo/1/error_stats"),
    "corruption_errs 0\nwrite_errs 0\nread_errs 0\nflush_errs 0\ngeneration_errs 0",
  );
  f.write(
    join(f.config.procRoot, "self/mountinfo"),
    `1 0 0:1 / ${f.root} rw - btrfs /dev/test rw`,
  );
  const reportPath = join(f.config.scrubDir, "root.result");
  f.write(
    reportPath,
    `btrfs scrub finished, no errors found: /
UUID:             ${uuid}
Scrub started:    Sat Sep 12 09:00:00 2026
Status:           finished
Error summary:    no errors found
`,
  );
  const r = new Reader();
  const collector = new StorageCollector();
  const first = await collector.collect(r, f.config, 1000);
  const key = uuid.toLowerCase();
  const latest = first.lastFinishedScrub?.[key]?.at;
  expect(latest).toBeTypeOf("number");
  // A stale or replayed report for the same filesystem, finished earlier than
  // the one already remembered. The memory holds the latest finish, not the
  // latest read.
  f.write(
    reportPath,
    `btrfs scrub finished, no errors found: /
UUID:             ${uuid}
Scrub started:    Fri Sep 11 13:25:54 2026
Status:           finished
Error summary:    no errors found
`,
  );
  const second = await collector.collect(r, f.config, 2000);
  expect(second.scrubs[0]?.startedAt).toBeLessThan(latest as number);
  expect(second.lastFinishedScrub?.[key]?.at).toBe(latest as number);
});

test("the last new error outlives the process that observed it", async () => {
  const f = fixture();
  fixtures.push(f);
  const root = join(f.config.btrfsRoot, "fsid");
  mkdirSync(join(root, "devices"), { recursive: true });
  symlinkSync("/sys/devices/test", join(root, "devices/test"));
  const file = join(root, "devinfo/1/error_stats");
  const counters = (corruption: number) =>
    `corruption_errs ${corruption}\nwrite_errs 0\nread_errs 0\nflush_errs 0\ngeneration_errs 0`;
  f.write(file, counters(1364));
  f.write(
    join(f.config.procRoot, "self/mountinfo"),
    `1 0 0:1 / ${f.root} rw - btrfs /dev/test rw`,
  );
  const r = new Reader();
  const first = new StorageCollector();
  // A counter already above zero says damage happened, not when.
  expect((await first.collect(r, f.config, 1000)).volumes[0]?.lastErrorAt).toBe(
    null,
  );
  f.write(file, counters(1390));
  const grown = await first.collect(r, f.config, 5000);
  expect(grown.volumes[0]?.lastErrorAt).toBe(5000);
  expect(grown.volumes[0]?.lastErrorSize).toBe(26);
  // A restart, and a sample a day and a half later: past the history window
  // and past the process that saw the growth.
  const later = await new StorageCollector().collect(r, f.config, 135000000);
  expect(later.volumes[0]?.lastErrorAt).toBe(5000);
  expect(later.volumes[0]?.lastErrorSize).toBe(26);
  expect(r.errors).toEqual([]);
});

test("device mapper aliases resolve to filesystem counters", async () => {
  const f = fixture();
  fixtures.push(f);
  const fs = join(f.config.btrfsRoot, "fsid");
  mkdirSync(join(fs, "devices"), { recursive: true });
  symlinkSync("/sys/devices/test", join(fs, "devices/test"));
  f.write(
    join(fs, "devinfo/1/error_stats"),
    "corruption_errs 2\nread_errs 0\nflush_errs 0\ngeneration_errs 0\nwrite_errs 0",
  );
  const device = join(f.root, "dev/test");
  f.write(device, "");
  const alias = join(f.root, "mapper/data");
  mkdirSync(join(f.root, "mapper"));
  symlinkSync(device, alias);
  f.write(
    join(f.config.procRoot, "self/mountinfo"),
    `1 0 0:1 / ${f.root} rw - btrfs ${alias} rw`,
  );
  const r = new Reader();
  const s = await new StorageCollector().collect(r, f.config, 1000);
  expect(s.volumes[0]?.fsid).toBe("fsid");
  expect(s.volumes[0]?.errors["1/corruption_errs"]).toBe(2);
  expect(r.errors).toEqual([]);
});

test("a hidden file in the report directory is not a report", async () => {
  const f = fixture();
  fixtures.push(f);
  // The reporter writes under a hidden name and renames the report whole, so
  // a hidden file is one still being written or one a stopped run left.
  f.write(
    join(f.config.scrubDir, ".root.result.tmp"),
    "UUID: 2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6\nStatus: finished\n",
  );
  f.write(
    join(f.config.scrubDir, "root.result"),
    "UUID: 2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6\nStatus: finished\n\nDamaged files: 1\nlogical 7:\n  (not resolved: subvol snap could not be accessed: not mounted)\n",
  );
  const storage = await new StorageCollector().collect(
    new Reader(),
    f.config,
    1000,
  );
  expect(storage.scrubs.map((scrub) => scrub.path)).toEqual([
    join(f.config.scrubDir, "root.result"),
  ]); // The mark that the address could not be resolved reaches the sample.
  expect(storage.scrubs[0]?.addresses).toEqual([
    { logical: 7, paths: [], resolved: false },
  ]);
});

test("a name that differs from a healthy one by an end space is never listed", async () => {
  const f = fixture();
  fixtures.push(f);
  // A healthy file, and a report whose last line names it with a trailing
  // space: read trimmed, that line would list the healthy file as damaged.
  const healthy = join(f.root, "target", "victim");
  f.write(healthy, "healthy");
  f.write(
    join(f.config.scrubDir, "root.result"),
    `UUID: 2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6\nStatus: finished\n\nDamaged files: 1\nlogical 7:\n  ${healthy} `,
  );
  const storage = await new StorageCollector().collect(
    new Reader(),
    f.config,
    1000,
  );
  expect(storage.scrubs[0]?.addresses).toEqual([
    { logical: 7, paths: [], resolved: false },
  ]);
});

test("an unreadable report stays a report rather than vanishing", async () => {
  const f = fixture();
  fixtures.push(f);
  const path = join(f.config.scrubDir, "root.result");
  f.write(path, "");
  chmodSync(path, 0o000);
  const r = new Reader();
  const storage = await new StorageCollector().collect(r, f.config, 1000);
  chmodSync(path, 0o600);
  // Losing the row would take its problem card with it and leave the reader
  // with no sign that a check had run at all.
  expect(storage.scrubs).toEqual([
    {
      path,
      text: "",
      readable: false,
      problem: true,
      fsid: null,
      startedAt: null,
      status: null,
      duration: null,
      uncorrectable: null,
      corrected: null,
      csum: null,
      addresses: null,
    },
  ]);
  expect(r.errors.map((e) => e.source)).toEqual([path]);
});

test("a report stating a count twice cannot report clean", () => {
  // A per-device listing: one device found nothing, another found damage.
  // Reading the first would let that zero speak for the whole filesystem.
  expect(() =>
    scrubProblem(`Status:           finished
  Corrected:      0
  Uncorrectable:  0
  Corrected:      0
  Uncorrectable:  26
`),
  ).toThrow();
  // Stated once, the count is the reading, in both directions.
  expect(
    scrubProblem(
      "Status: finished\n  Corrected:      0\n  Uncorrectable:  0\n",
    ),
  ).toBe(false);
  expect(
    scrubProblem(
      "Status: finished\n  Corrected:      5\n  Uncorrectable:  0\n",
    ),
  ).toBe(true);
});

test("a count the report carries but cannot state cannot report clean", () => {
  // The label is there once, and its value is not a number. Defaulting that
  // to zero would call a malformed result clean.
  expect(() =>
    scrubProblem(
      "Status: finished\n  Corrected:      0\n  Uncorrectable:  invalid\n",
    ),
  ).toThrow();
});

test("storage hands the scan the agent directories and keeps the defaults it found absent", async () => {
  const f = fixture();
  fixtures.push(f);
  const asked: string[][] = [];
  const original = ScratchCollector.prototype.collect;
  // The scan itself is pinned in its own suite; this pins what storage
  // passes to it and carries back from it.
  ScratchCollector.prototype.collect = async (_c, agentDirs, time) => {
    asked.push(agentDirs);
    return {
      scratch: [],
      sessions: [],
      absent: ["/default"],
      time,
      errors: [],
    };
  };
  try {
    const storage = await new StorageCollector().collect(
      new Reader(),
      f.config,
      1000,
      null,
      true,
      false,
      ["/agent"],
    );
    expect(asked).toEqual([["/agent"]]);
    expect(storage.scratchAbsent).toEqual(["/default"]);
  } finally {
    ScratchCollector.prototype.collect = original;
  }
});
