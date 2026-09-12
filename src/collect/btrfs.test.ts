import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { point } from "../store/point";
import { emptySnapshot, fixture } from "../test/fixture";
import { btrfsMounts, StorageCollector, scrubProblem } from "./btrfs";
import { Reader } from "./io";
import { parseMounts } from "./mounts";

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
  expect(first.volumes[0].delta["1/corruption_errs"]).toBe(0);
  f.write(
    file,
    "corruption_errs 5\nwrite_errs 0\nread_errs 0\nflush_errs 0\ngeneration_errs 0",
  );
  const second = await collector.collect(r, f.config, 2000);
  expect(second.volumes[0].delta["1/corruption_errs"]).toBe(3);
  expect(second.volumes[0].sinceStart["1/corruption_errs"]).toBe(3);
  f.write(
    file,
    "corruption_errs 6\nwrite_errs 0\nread_errs 0\nflush_errs 0\ngeneration_errs 0",
  );
  const third = await collector.collect(r, f.config, 3000);
  expect(third.volumes[0].delta["1/corruption_errs"]).toBe(1);
  expect(third.volumes[0].sinceStart["1/corruption_errs"]).toBe(4);
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
    ["scrub aborted", true],
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
  expect(first.scrubs[0].fsid).toBe(uuid);
  expect(first.scrubs[0].uncorrectable).toBe(26);
  expect(first.scrubs[0].addresses).toEqual([
    { logical: 953118621696, paths: [kept, gone] },
  ]);
  // The reader deletes one of the two names. It leaves the list; the name
  // still on disk stays, because the damage is still there.
  unlinkSync(gone);
  const second = await collector.collect(r, f.config, 2000);
  expect(second.scrubs[0].addresses).toEqual([
    { logical: 953118621696, paths: [kept] },
  ]);
  expect(r.errors).toEqual([]);
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
  expect((await first.collect(r, f.config, 1000)).volumes[0].lastErrorAt).toBe(
    null,
  );
  f.write(file, counters(1390));
  const grown = await first.collect(r, f.config, 5000);
  expect(grown.volumes[0].lastErrorAt).toBe(5000);
  expect(grown.volumes[0].lastErrorSize).toBe(26);
  // A restart, and a sample a day and a half later: past the history window
  // and past the process that saw the growth.
  const later = await new StorageCollector().collect(r, f.config, 135000000);
  expect(later.volumes[0].lastErrorAt).toBe(5000);
  expect(later.volumes[0].lastErrorSize).toBe(26);
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
  expect(s.volumes[0].fsid).toBe("fsid");
  expect(s.volumes[0].errors["1/corruption_errs"]).toBe(2);
  expect(r.errors).toEqual([]);
});
