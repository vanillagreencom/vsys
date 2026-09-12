import { expect, test } from "bun:test";
import { parseScrub } from "./scrub";

/** The report the privileged helper writes when a scrub found damage. */
const damaged = `btrfs scrub finished, csum=26 (uncorrectable is normal on a single drive): /
UUID:             2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6
Scrub started:    Fri Sep 11 13:25:54 2026
Status:           finished
Duration:         0:02:02
Total to scrub:   793.87GiB
Rate:             6.51GiB/s
Error summary:    csum=26
  Corrected:      0
  Uncorrectable:  26
  Unverified:     0

Damaged files: 6 damaged block addresses from the kernel log.
Delete every path listed under an address, not the first: one block can have several names.
logical 953118621696:
  /repo/target/debug/build/glib-sys/build-script-build
  /repo/target/debug/build/glib-sys/build_script_build-c664
logical 1597612883968:
  (no file: free space, or already deleted)
`;

test("a report names its filesystem, its check and every path of each address", () => {
  const report = parseScrub(damaged);
  expect(report.uuid).toBe("2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6");
  expect(report.status).toBe("finished");
  expect(report.uncorrectable).toBe(26);
  expect(report.corrected).toBe(0);
  expect(report.startedAt).toBe(Date.parse("Fri Sep 11 13:25:54 2026"));
  // Both names of the first address, because one extent under two names is
  // one piece of damage and removing the first leaves it on disk.
  expect(report.addresses).toEqual([
    {
      logical: 953118621696,
      paths: [
        "/repo/target/debug/build/glib-sys/build-script-build",
        "/repo/target/debug/build/glib-sys/build_script_build-c664",
      ],
    },
    { logical: 1597612883968, paths: [] },
  ]);
});

test("the parser anchors on the address heading, not on the prose above it", () => {
  // Every line the helper writes as prose, reworded. The addresses still read.
  const reworded = damaged
    .replace(/^btrfs scrub.*$/m, "check over, found trouble on the root disk")
    .replace(/^Damaged files:.*$/m, "Damaged files: what the kernel resolved")
    .replace(/^Delete every path.*$/m, "remove all of these together");
  expect(parseScrub(reworded).addresses).toEqual(parseScrub(damaged).addresses);
});

test("an indented line outside an address is not taken as a damaged path", () => {
  const report = parseScrub(`Damaged files: none resolved
  /this/is/prose/under/no/address
logical 12:
  /real/path
`);
  expect(report.addresses).toEqual([{ logical: 12, paths: ["/real/path"] }]);
});

test("a report with no damaged-file section lists no files rather than none", () => {
  // The distinction the reader depends on: the older format cannot name files,
  // which is not the same as a check that found none.
  const old = parseScrub(`UUID:             2ff9dd6d-1b2c-4d5e-8f90-a1b2c3d4e5f6
Scrub started:    Fri Sep 11 13:25:54 2026
Status:           finished
Error summary:    no errors found
`);
  expect(old.addresses).toBeNull();
  expect(old.uncorrectable).toBeNull();
  expect(parseScrub(damaged).addresses).not.toBeNull();
});

test("fields the report did not carry stay null rather than becoming zero", () => {
  const empty = parseScrub("nothing a scrub ever wrote\n");
  expect(empty).toEqual({
    uuid: null,
    startedAt: null,
    status: null,
    uncorrectable: null,
    corrected: null,
    addresses: null,
  });
  // A start time that is not a time is unread, never the epoch.
  expect(parseScrub("Scrub started:    never\n").startedAt).toBeNull();
});

test("a field the report states twice holds no single reading", () => {
  // A per-device listing repeats the label. Taking the first would report one
  // device's count as the whole filesystem's.
  const twice = parseScrub(`Status:           finished
  Corrected:      0
  Uncorrectable:  26
  Corrected:      0
  Uncorrectable:  9
`);
  expect(twice.uncorrectable).toBeNull();
  expect(twice.corrected).toBeNull();
  expect(twice.status).toBe("finished");
});
