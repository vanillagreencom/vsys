// Proof tests for the storage findings in review/cloud-defect-review.md.
// Every test here FAILS on the reviewed commit; each failure is the defect.
// Run from the repository root:
//   PATH="$PWD/node_modules/.bin:$PATH" bun test review/tests/storage.test.tsx
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageCollector } from "../../src/collect/btrfs";
import { Reader } from "../../src/collect/io";
import { scanScratch } from "../../src/collect/scratch-scan";
import { defaults } from "../../src/config/config";
import { integrities } from "../../src/model/integrity";
import { emptySnapshot, fixture } from "../../src/test/fixture";
import { mount } from "../../src/test/harness";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

// The kernel counts every checksum mismatch a scrub finds in corruption_errs,
// repaired or not (fs/btrfs/scrub.c, scrub_stripe_report_errors). vsys dates
// that growth at the sample that sees it, which is after the report's
// `Scrub started`, so a finished scrub that repaired every error on a
// RAID1/DUP filesystem leaves it in `new-errors` (danger) until the next scrub.
test("a scrub that corrected every error it found is not new errors since that scrub", async () => {
  const f = fixture();
  fixtures.push(f);
  const uuid = "2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6";
  const root = join(f.config.btrfsRoot, uuid);
  mkdirSync(join(root, "devices"), { recursive: true });
  symlinkSync("/sys/devices/test", join(root, "devices/test"));
  const stats = (n: number) =>
    `corruption_errs ${n}\nwrite_errs 0\nread_errs 0\nflush_errs 0\ngeneration_errs 0`;
  const file = join(root, "devinfo/1/error_stats");
  f.write(
    join(f.config.procRoot, "self/mountinfo"),
    `1 0 0:1 / ${f.root} rw - btrfs /dev/test rw`,
  );
  const started = Date.parse("Fri Sep 11 13:25:54 2026");
  const collector = new StorageCollector();
  const r = new Reader();
  f.write(file, stats(0));
  f.write(
    join(f.config.scrubDir, "root.result"),
    `btrfs scrub finished, no errors: /
UUID:             ${uuid}
Scrub started:    Tue Aug 11 13:25:54 2026
Status:           finished
Error summary:    no errors found
`,
  );
  await collector.collect(r, f.config, started - 60_000);
  // Five minutes into the scrub it has found and repaired three bad copies.
  f.write(file, stats(3));
  await collector.collect(r, f.config, started + 5 * 60_000);
  f.write(
    join(f.config.scrubDir, "root.result"),
    `btrfs scrub finished, csum=3 (uncorrectable is normal on a single drive): /
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
  const now = started + 40 * 60_000;
  const snapshot = emptySnapshot();
  snapshot.storage = await collector.collect(r, f.config, now);
  snapshot.time = now;
  const [item] = integrities(snapshot, f.config);
  expect(item?.complete).toBe(true);
  // Received "new-errors".
  expect(item?.state).not.toBe("new-errors");
});

// btrfs-progs prints `Status: interrupted` for a scrub whose process ended
// without recording a cancel (a shutdown or reboot mid-scrub), and the
// shipped reporter writes "did not complete (interrupted)" above it.
// scrubProblem() knows only aborted/canceled/failed, so the row reads "clean"
// and the `scrub` alert never fires.
test("an interrupted scrub report is not a clean one", async () => {
  const f = fixture();
  fixtures.push(f);
  f.write(join(f.config.procRoot, "self/mountinfo"), "");
  f.write(
    join(f.config.scrubDir, "-.result"),
    `btrfs scrub did not complete (interrupted): /
UUID:             2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6
Scrub started:    Fri Sep 11 13:25:54 2026
Status:           interrupted
Duration:         0:03:10
Total to scrub:   500.00GiB
Rate:             1.00GiB/s
Error summary:    no errors found
`,
  );
  const storage = await new StorageCollector().collect(
    new Reader(),
    f.config,
    1000,
  );
  const s = emptySnapshot();
  s.storage.scrubs = storage.scrubs;
  const t = await mount(s, f.config, { width: 140, height: 30 });
  let line: string | undefined;
  try {
    await t.press("5");
    line = t
      .frame()
      .split("\n")
      .find((l) => l.includes("-.result"));
  } finally {
    await t.close();
  }
  expect({ problem: storage.scrubs[0]?.problem, clean: line?.includes("clean") })
    .toEqual({ problem: true, clean: false });
});

// A configured scratch root that could not be read has no modification time,
// and the Storage row draws "0s ago" for it (record() sets age 0 when it has
// no stat; the row falls back to that age).
test("an unreadable scratch root shows no age it never read", async () => {
  const base = mkdtempSync(join(tmpdir(), "vsys-review-"));
  try {
    const missing = join(base, "configured-root");
    const { scan } = await scanScratch(
      [{ path: missing, origin: "configured" }],
      Date.now(),
      { sliceMs: 4, dutyPercent: 100 },
    );
    const [row] = scan.scratch;
    expect(row?.bytes).toBeNull();
    expect(row?.error).not.toBeNull();
    const s = emptySnapshot();
    s.storage.scratch = scan.scratch;
    s.storage.scratchTime = s.time;
    const c = defaults();
    c.scratchDirs = [missing];
    const t = await mount(s, c, { width: 160, height: 40 });
    let line: string | undefined;
    try {
      await t.press("5");
      line = t
        .frame()
        .split("\n")
        .find((l) => l.includes("configured-root"));
    } finally {
      await t.close();
    }
    expect(line).toBeDefined();
    // Received "... not avail…  0s ago  ENOENT: ...".
    expect(line).not.toMatch(/\b0s ago/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
