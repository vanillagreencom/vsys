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
