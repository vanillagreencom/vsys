/**
 * The kernel log as a second integrity source, independent of the scrub
 * reports. Btrfs logs every data read that fails its checksum as
 * `csum failed root R ino I`, which names the subvolume tree and the inode
 * with no privileged helper. Resolving the inode to a path needs root, so the
 * reading stays an inode until a check names the file.
 *
 * The message text is kernel prose, not an interface: no release promises its
 * wording. It stands in for the documented counters, `error_stats` under
 * `/sys/fs/btrfs`, which the collector also reads, because a counter gives a
 * count with no inode and no time it failed. A rewording leaves the lines
 * unmatched, so the log then names no failure the counter has not counted.
 *
 * journalctl's JSON output is the journal's documented interface, and every
 * entry carries `__REALTIME_TIMESTAMP` and `_BOOT_ID` whatever fields are
 * asked for. `--grep` keeps the read to the lines that matter: on a journal
 * holding a dozen boots that is a hundred kilobytes rather than thirty
 * megabytes. Each read after the first starts after the cursor the last one
 * ended on, so a sample pays for the entries since the previous sample.
 */

import type { CsumFailure } from "../model/types";
import type { Outcome } from "./capabilities";
import { spawnText } from "./io";

/**
 * Kernel lines that matter here: a failed checksum read, and the line naming
 * the filesystem a device mounted, which is how a line from an earlier boot is
 * matched to its filesystem. The capital letters make the match
 * case-sensitive, which journalctl decides from the pattern itself.
 */
const pattern = "BTRFS .*(csum failed root|first mount of filesystem)";
/** The newest inodes kept per filesystem. A dying disk logs thousands. */
export const inodeLimit = 64;
const base = [
  "journalctl",
  "--quiet",
  "--no-pager",
  "--output=json",
  "--output-fields=MESSAGE",
];
export const kernelLogArgv = (cursor: string | null): string[] => [
  ...base,
  "--show-cursor",
  `--grep=${pattern}`,
  ...(cursor === null ? [] : [`--after-cursor=${cursor}`]),
  "_TRANSPORT=kernel",
];
/**
 * One kernel message from this boot, searched for the way a read searches.
 * Every running system has logged kernel messages since it booted, so an
 * answer holding none means this user cannot read the system journal, which
 * on most distributions takes membership of a group such as
 * `systemd-journal`. Asking with the search also proves journalctl can
 * search at all, which needs the PCRE2 library it may be built without.
 */
export const kernelLogProbeArgv = [...base, "--dmesg", "--lines=1", "--grep=."];

/**
 * How long one journalctl search may run before the sample gives up on it. A
 * search can scan a journal holding many boots, slower than a single D-Bus
 * call, so this stands above `udisksTimeoutMs`; it still bounds the call so a
 * stalled journalctl never holds every future sample waiting on it.
 */
export const kernelLogTimeoutMs = 10_000;

/** journalctl exits 1 when a search matched nothing, and that is an answer. */
const answered = (status: number, error: string): boolean =>
  status === 0 || (status === 1 && error.trim() === "");

/**
 * Whether this user can search the kernel's messages in the journal. It runs
 * once, when vsys starts, beside the other probes, so it waits as they do.
 */
export function probeKernelLog(argv: string[] = kernelLogProbeArgv): Outcome {
  let result: { stdout: Uint8Array; stderr: Uint8Array; exitCode: number };
  try {
    result = Bun.spawnSync(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    // Nothing ran: the program is not on the path.
    return { failure: "absent", detail: String(error) };
  }
  const out = new TextDecoder().decode(result.stdout);
  const error = new TextDecoder().decode(result.stderr).trim();
  if (answered(result.exitCode, error) && out.trim() !== "") return null;
  // journalctl refusing in its own words is a refusal to read, and joining a
  // group fixes nothing that words like "Compiled without pattern matching"
  // describe. Silence with no message is the journal this user cannot see.
  return error
    ? { failure: "unreadable", detail: error }
    : {
        failure: "incomplete",
        detail: `${argv[0]} exited ${result.exitCode} with no kernel message`,
      };
}
/** One search of the kernel log, after the cursor when there is one. */
export async function readKernelLog(
  cursor: string | null,
  /** Injected so a test can run a stand-in for journalctl. */
  argv: string[] = kernelLogArgv(cursor),
): Promise<string> {
  const { out, error, status } = await spawnText(argv, kernelLogTimeoutMs);
  if (!answered(status, error))
    throw new Error(error.trim() || `${argv[0]} exited ${status}`);
  return out;
}

const mountLine =
  /^BTRFS \w+ \(device ([^\s):]+)[^)]*\): first mount of filesystem ([0-9a-f-]{36})\b/i;
const failureLine =
  /^BTRFS \w+ \(device ([^\s):]+)[^)]*\): csum failed root (-?\d+) ino (\d+)\b/;
const cursorLine = /^-- cursor: (\S+)$/;

/**
 * The failed checksum reads the kernel log holds, kept across samples. A
 * device name in the log is only as stable as one boot: NVMe drives can
 * enumerate in another order the next time, so a line from an earlier boot
 * is matched to its filesystem through that boot's own mount line. A line
 * from this boot whose mount line is not in the log, as on a kernel too old to
 * write one, is matched through the devices this boot's sysfs lists. A line
 * from an earlier boot with no mount line names no filesystem vsys can stand
 * behind, and is left out.
 */
export class KernelLog {
  private cursor: string | null = null;
  /** For each boot, the filesystem id each device name mounted. */
  private mounted = new Map<string, Map<string, string>>();
  /** For each filesystem id, each inode's newest failure. */
  private failures = new Map<string, Map<string, CsumFailure>>();
  /** Whether any search has completed, so `held()` is a reading. */
  private searched = false;
  constructor(
    private search: (cursor: string | null) => Promise<string> = readKernelLog,
  ) {}
  /**
   * Every failure held, newest first per filesystem. Null until a search has
   * completed: before that, vsys has not read the log at all. After one, a
   * later search that failed loses nothing the earlier ones read.
   */
  held(): Record<string, CsumFailure[]> | null {
    if (!this.searched) return null;
    return Object.fromEntries(
      [...this.failures].map(([fsid, inodes]) => [
        fsid,
        [...inodes.values()].sort((a, b) => b.at - a.at),
      ]),
    );
  }
  /**
   * Read what the log gained since the last read, and return every failure
   * held. `devices` maps this boot's device names to filesystem ids, and
   * `boot` is this boot's id, null where it could not be read. A search that
   * fails throws, and `held()` still answers with what was read before it.
   */
  async read(
    devices: Map<string, string>,
    boot: string | null,
  ): Promise<Record<string, CsumFailure[]>> {
    const text = await this.search(this.cursor);
    const thisBoot = boot?.replaceAll("-", "").toLowerCase() ?? null;
    let cursor = this.cursor;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const end = line.match(cursorLine)?.[1];
      if (end !== undefined) {
        cursor = end;
        continue;
      }
      const entry = JSON.parse(line) as Record<string, unknown>;
      // A message that is not valid UTF-8 arrives as an array of bytes, and
      // no line this reads is one of those.
      if (typeof entry.MESSAGE !== "string") continue;
      const bootId =
        typeof entry._BOOT_ID === "string" ? entry._BOOT_ID.toLowerCase() : "";
      const mount = entry.MESSAGE.match(mountLine);
      const device = mount?.[1];
      const filesystem = mount?.[2];
      if (device !== undefined && filesystem !== undefined) {
        const names = this.mounted.get(bootId) ?? new Map<string, string>();
        names.set(device, filesystem.toLowerCase());
        this.mounted.set(bootId, names);
        continue;
      }
      const failure = entry.MESSAGE.match(failureLine);
      const failureDevice = failure?.[1];
      if (failure === null || failureDevice === undefined) continue;
      const at = Number(entry.__REALTIME_TIMESTAMP) / 1000;
      if (!Number.isFinite(at))
        throw new Error("Kernel log entry carries no time");
      const fsid =
        this.mounted.get(bootId)?.get(failureDevice) ??
        (bootId === thisBoot ? devices.get(failureDevice) : undefined);
      if (fsid === undefined) continue;
      const root = Number(failure[2]);
      const inode = Number(failure[3]);
      const inodes = this.failures.get(fsid) ?? new Map<string, CsumFailure>();
      const key = `${root}/${inode}`;
      if ((inodes.get(key)?.at ?? -1) <= at)
        inodes.set(key, { root, inode, at });
      this.failures.set(fsid, inodes);
    }
    // The cursor moves only once the whole answer parsed, so a read that
    // failed part way is asked again rather than skipped.
    this.cursor = cursor;
    this.searched = true;
    for (const [fsid, inodes] of this.failures) {
      // Only the newest are kept, so the map stays as small as what a
      // sample carries.
      const newest = [...inodes.values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, inodeLimit);
      this.failures.set(
        fsid,
        new Map(newest.map((f) => [`${f.root}/${f.inode}`, f])),
      );
    }
    return this.held() ?? {};
  }
}
