import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { present } from "../test/present";
import { capabilityReason } from "../ui/settings";
import { StorageCollector } from "./btrfs";
import { Reader } from "./io";
import {
  inodeLimit,
  KernelLog,
  kernelLogArgv,
  probeKernelLog,
  readKernelLog,
} from "./kernel-log";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

const earlier = "0ee5a5f5ca2d4aa788c28d0c35f717cd";
const current = "e9145d56d4c74c0ca5f12dba13f63996";
/** This boot's id as the kernel writes it, with the dashes journald drops. */
const currentDashed = "e9145d56-d4c7-4c0c-a5f1-2dba13f63996";
/** One journal entry as `journalctl --output=json` writes it. */
const entry = (boot: string, seconds: number, message: string): string =>
  JSON.stringify({
    MESSAGE: message,
    __REALTIME_TIMESTAMP: String(seconds * 1_000_000),
    __CURSOR: `s=x;i=${seconds}`,
    _BOOT_ID: boot,
  });
const mounted = (device: string, fsid: string) =>
  `BTRFS info (device ${device}): first mount of filesystem ${fsid}`;
const failed = (device: string, root: number, inode: number) =>
  `BTRFS warning (device ${device}): csum failed root ${root} ino ${inode} off 16629760 csum 0x4361855b expected csum 0x65c64f44 mirror 1`;
const fsA = "2ff9dd6d-c928-4458-9444-bffb6c01eacb";
const fsB = "71345faf-0e2f-4855-88f2-fd0ea2697ea5";

test("a failure is matched to the filesystem its own boot mounted on that device", async () => {
  // The earlier boot mounted fsA on nvme0n1p2. This boot enumerated the drives
  // in another order, and nvme0n1p2 is fsB now. The old failure is fsA's.
  const log = new KernelLog(async () =>
    [
      entry(earlier, 100, mounted("nvme0n1p2", fsA)),
      entry(earlier, 200, failed("nvme0n1p2", 257, 11)),
      // An earlier boot with no mount line names no filesystem vsys can stand
      // behind, so its failure is left out rather than guessed.
      entry(
        "1111aaaa1111aaaa1111aaaa1111aaaa",
        250,
        failed("nvme0n1p2", 5, 99),
      ),
      // This boot's line has no mount line, as on an older kernel, so this
      // boot's sysfs names the filesystem. The state word after the device is
      // the kernel's, and is not part of the name.
      entry(current, 300, failed("nvme0n1p2 state M", 257, 12)),
      "-- cursor: s=x;i=300",
    ].join("\n"),
  );
  const failures = await log.read(new Map([["nvme0n1p2", fsB]]), currentDashed);
  expect(failures).toEqual({
    [fsA]: [{ root: 257, inode: 11, at: 200_000 }],
    [fsB]: [{ root: 257, inode: 12, at: 300_000 }],
  });
});

test("each read starts after the last, and keeps every inode's newest failure", async () => {
  const asked: (string | null)[] = [];
  const answers = [
    [
      entry(current, 100, mounted("dm-0", fsA)),
      entry(current, 110, failed("dm-0", 257, 7)),
      entry(current, 120, failed("dm-0", 257, 7)),
      "-- cursor: first",
    ].join("\n"),
    // Nothing new: journalctl still names where it stopped.
    "-- cursor: second\n",
    [entry(current, 130, failed("dm-0", -9, 8)), "-- cursor: third"].join("\n"),
  ];
  const log = new KernelLog(async (cursor) => {
    asked.push(cursor);
    return answers.shift() ?? "";
  });
  const devices = new Map<string, string>();
  expect(await log.read(devices, currentDashed)).toEqual({
    [fsA]: [{ root: 257, inode: 7, at: 120_000 }],
  });
  await log.read(devices, currentDashed);
  // The data relocation tree's id is negative, and it is still a tree.
  expect(await log.read(devices, currentDashed)).toEqual({
    [fsA]: [
      { root: -9, inode: 8, at: 130_000 },
      { root: 257, inode: 7, at: 120_000 },
    ],
  });
  expect(asked).toEqual([null, "first", "second"]);
});

test("a read that cannot be parsed is asked again from the same place", async () => {
  const asked: (string | null)[] = [];
  const answers = [
    [entry(current, 100, mounted("dm-0", fsA)), "-- cursor: first"].join("\n"),
    ["{not json", "-- cursor: second"].join("\n"),
    "-- cursor: second\n",
  ];
  const log = new KernelLog(async (cursor) => {
    asked.push(cursor);
    return answers.shift() ?? "";
  });
  await log.read(new Map(), currentDashed);
  await expect(log.read(new Map(), currentDashed)).rejects.toThrow();
  await log.read(new Map(), currentDashed);
  expect(asked).toEqual([null, "first", "first"]);
});

test("a filesystem keeps its newest failures and no more", async () => {
  const lines = [entry(current, 1, mounted("dm-0", fsA))];
  for (let inode = 1; inode <= inodeLimit + 6; inode++)
    lines.push(entry(current, 10 + inode, failed("dm-0", 5, inode)));
  const log = new KernelLog(async () => lines.join("\n"));
  const failures = present(
    (await log.read(new Map(), currentDashed))[fsA],
    "fsA failures",
  );
  expect(failures).toHaveLength(inodeLimit);
  expect(failures[0]).toEqual({
    root: 5,
    inode: inodeLimit + 6,
    at: (16 + inodeLimit) * 1000,
  });
  expect(failures.at(-1)?.inode).toBe(7);
});

test("only a search that answered counts as a kernel log this user can read", () => {
  const sh = (script: string) => ["sh", "-c", script];
  // One kernel message came back: the journal is readable and searchable.
  expect(probeKernelLog(sh(`echo '{"MESSAGE":"Linux version"}'`))).toBeNull();
  // journalctl ran and found no kernel message: the user cannot see the
  // system journal. It exits 1, the way a search that matched nothing does.
  expect(probeKernelLog(sh("exit 1"))).toEqual({
    failure: "incomplete",
    detail: "sh exited 1 with no kernel message",
  });
  // journalctl ran and refused, in its own words. Joining a group fixes
  // nothing there, so it is a refusal rather than a journal out of sight.
  const refused = probeKernelLog(
    sh("echo 'Compiled without pattern matching support' >&2; exit 1"),
  );
  expect(refused).toEqual({
    failure: "unreadable",
    detail: "Compiled without pattern matching support",
  });
  const cap = (outcome: typeof refused) => ({
    id: "kernel-log" as const,
    available: false,
    failure: outcome?.failure ?? null,
    source: "journalctl",
    detail: outcome?.detail ?? "",
  });
  expect(capabilityReason(cap(refused))).toBe("journalctl refused the search");
  expect(capabilityReason(cap(probeKernelLog(sh("exit 1"))))).toContain(
    "systemd-journal group",
  );
  // Nothing ran at all.
  expect(probeKernelLog(["vsys-has-no-such-program"])?.failure).toBe("absent");
});

test("the search asks after the cursor only once there is one", () => {
  expect(kernelLogArgv(null).some((a) => a.startsWith("--after-cursor"))).toBe(
    false,
  );
  expect(kernelLogArgv("s=1")).toContain("--after-cursor=s=1");
  expect(kernelLogArgv(null)).toContain("_TRANSPORT=kernel");
});

test("the search journalctl runs keeps exactly the lines the parser reads", () => {
  const grep = kernelLogArgv(null)
    .find((arg) => arg.startsWith("--grep="))
    ?.slice("--grep=".length);
  expect(grep).toBeDefined();
  // The pattern is PCRE2; this one is also a JavaScript expression.
  const search = new RegExp(grep ?? "");
  expect(search.test(mounted("dm-0", fsA))).toBe(true);
  expect(search.test(failed("dm-0 state M", 257, 7))).toBe(true);
  expect(
    search.test("BTRFS info (device dm-0): using crc32c checksum algorithm"),
  ).toBe(false);
});

test("a search that matched nothing is an answer, and a refusal is not", async () => {
  const sh = (script: string) => ["sh", "-c", script];
  // Output, and the exit 1 a search matching nothing gives with no message.
  expect(await readKernelLog(null, sh("echo found"))).toBe("found\n");
  expect(await readKernelLog(null, sh("echo '-- cursor: c'; exit 1"))).toBe(
    "-- cursor: c\n",
  );
  // A message, or an exit no search gives, is a failure named in its words.
  await expect(
    readKernelLog(null, sh("echo 'Failed to seek' >&2; exit 1")),
  ).rejects.toThrow("Failed to seek");
  await expect(readKernelLog(null, sh("exit 2"))).rejects.toThrow(
    "sh exited 2",
  );
});

test("storage carries the kernel log's failures, and an unread log as unread", async () => {
  const f = fixture();
  fixtures.push(f);
  const root = join(f.config.btrfsRoot, fsA);
  mkdirSync(join(root, "devices"), { recursive: true });
  symlinkSync("/sys/devices/dm-0", join(root, "devices/dm-0"));
  f.write(
    join(f.config.procRoot, "sys/kernel/random/boot_id"),
    `${currentDashed}\n`,
  );
  const answer = [
    entry(current, 500, failed("dm-0", 257, 4242)),
    "-- cursor: one",
  ].join("\n");
  const read = new Reader();
  const storage = await new StorageCollector(
    new KernelLog(async () => answer),
  ).collect(read, f.config, 1000);
  // No mount line, so this boot's sysfs named the filesystem, and the boot
  // the line came from was read from procfs.
  expect(storage.csumFailures).toEqual({
    [fsA]: [{ root: 257, inode: 4242, at: 500_000 }],
  });
  // A search that failed is a source error, and the reading is unread rather
  // than a log of none.
  const failing = new Reader();
  const unread = await new StorageCollector(
    new KernelLog(async () => {
      throw new Error("journalctl exited 2");
    }),
  ).collect(failing, f.config, 1000);
  expect(unread.csumFailures).toBeNull();
  expect(failing.errors).toContainEqual({
    source: "journalctl",
    message: "journalctl exited 2",
  });
  // A search that fails after one succeeded loses nothing that one read: the
  // failure stays in the sample beside the source error.
  let fail = false;
  const resumed = new StorageCollector(
    new KernelLog(async () => {
      if (fail) throw new Error("journalctl exited 2");
      return answer;
    }),
  );
  await resumed.collect(new Reader(), f.config, 1000);
  fail = true;
  const later = new Reader();
  const held = await resumed.collect(later, f.config, 2000);
  expect(held.csumFailures).toEqual({
    [fsA]: [{ root: 257, inode: 4242, at: 500_000 }],
  });
  expect(later.errors.map((e) => e.source)).toContain("journalctl");
  // A collector given no log reads none, and says so the same way.
  const none = await new StorageCollector().collect(
    new Reader(),
    f.config,
    1000,
  );
  expect(none.csumFailures).toBeNull();
});

test("a stalled journalctl is killed within its deadline rather than hanging the sample", async () => {
  const started = Date.now();
  // A real child that never exits on its own, the shape a wedged journalctl
  // takes. A short deadline proves the kill rather than waiting it out.
  await expect(readKernelLog(null, ["sleep", "30"], 50)).rejects.toThrow(
    "exited 143",
  );
  // Killed well short of the child's own 30 second sleep.
  expect(Date.now() - started).toBeLessThan(2000);
});
