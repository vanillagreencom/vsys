/**
 * udisks2 as the unprivileged source of drive lifetime writes, read only where
 * no drive report directory exists. udisks runs as root and answers the
 * logged-in user over the system bus; its D-Bus interface is the documented
 * one, and `busctl --json=short` prints the replies as JSON.
 *
 * Two methods give a lifetime write total, and neither is documented to ask
 * polkit for authorization:
 *
 * - `org.freedesktop.UDisks2.NVMe.Controller.SmartGetAttributes`, udisks 2.10
 *   and later, returns `total_data_written`: bytes, which udisks derives from
 *   the drive's data units written.
 * - `org.freedesktop.UDisks2.Drive.Ata.SmartGetAttributes` returns each
 *   attribute's interpreted value and its unit, never the raw counter. Only
 *   attribute 241, `total-lbas-written`, given in sectors is a byte count; any
 *   other unit for it stays unknown rather than scaled by a guess.
 *
 * udisks itself refreshes these from the drive on its own schedule, so a read
 * is held for `udisksHoldMs` rather than asked for again every sample.
 */

import type { Outcome } from "./capabilities";
import { killGraceMs, spawnText } from "./io";

/** The D-Bus service that answers in the SMART capability's place when it supplies a drive's lifetime writes. */
export const udisksService = "org.freedesktop.UDisks2";
const service = udisksService;
const nvmeInterface = "org.freedesktop.UDisks2.NVMe.Controller";
const ataInterface = "org.freedesktop.UDisks2.Drive.Ata";
const busctl = ["busctl", "--system", "--json=short", "call", service];
export const udisksObjectsArgv = [
  ...busctl,
  "/org/freedesktop/UDisks2",
  "org.freedesktop.DBus.ObjectManager",
  "GetManagedObjects",
];
export const udisksAttributesArgv = (drive: string, iface: string) => [
  ...busctl,
  drive,
  iface,
  "SmartGetAttributes",
  "a{sv}",
  "0",
];
/** How long one read of udisks stands before the next sample asks again. */
export const udisksHoldMs = 10 * 60 * 1000;
/**
 * How long one busctl call may run before the sample gives up on it. A
 * stalled SMART query, over D-Bus through a spun-down drive or a USB
 * bridge, must not hold every future sample waiting on it.
 */
export const udisksTimeoutMs = 5000;
/** `withDeadline`'s own clock gave up on a `run` that never settled at all. */
class RunnerAbandoned extends Error {}
/** How `timeout did not answer` reads for a given deadline, in one place. */
const timeoutDetail = (ms: number) => `busctl did not answer within ${ms} ms`;
/**
 * A margin above the longest a real `spawnText(argv, ms)` can take once its
 * own deadline fires: `ms` to the kill, `killGraceMs` more to the SIGKILL
 * escalation, plus a cushion for the child actually exiting. `withDeadline`'s
 * own clock stays above that span so it never fires before a real call's own
 * `timedOut` outcome does — racing the same `ms` against spawnText's own
 * timer let a real timeout resolve as an ordinary, unexplained result purely
 * by which timer callback ran first. This margin exists only to abandon an
 * injected `run` that never resolves at all, never to detect a real timeout,
 * so its own message carries no borrowed `timeoutDetail` wording: the two
 * outcomes are different events and must not read alike.
 */
const deadlineMarginMs = killGraceMs + 500;
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    const abandonMs = ms + deadlineMarginMs;
    timer = setTimeout(
      () =>
        reject(
          new RunnerAbandoned(
            `busctl runner abandoned after ${abandonMs} ms with no response`,
          ),
        ),
      abandonMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
/** A sector, the unit udisks gives `total-lbas-written` in. */
const SECTOR = 512;
/** udisks' `pretty_unit` for a value counted in sectors. */
const SECTORS_UNIT = 3;

/** One whole-disk block device udisks knows a SMART-capable drive behind. */
export interface UdisksDrive {
  /** The `/sys/block` name, from the block device's node. */
  name: string;
  model: string | null;
  written: number | null;
}
export interface UdisksReading {
  drives: UdisksDrive[];
  /** Null where udisks answered; otherwise why vsys could not ask it. */
  outcome: Outcome;
}
type Run = typeof spawnText;

/**
 * What busctl's refusal means, matched against its own words. A system with
 * no bus, or no udisks on it, has no such interface; anything else is a
 * source that would not answer this user.
 */
const absentPatterns: RegExp[] = [
  // "Failed to connect to bus: No such file or directory". Matched
  // positively, so a permission-denied or operation-not-permitted refusal
  // from a bus that is actually reachable falls to unreadable instead.
  /^Failed to connect to (?:system scope )?bus(?: via \S+ transport)?: No such file or directory/m,
  // "Call failed: The name org.freedesktop.UDisks2 was not provided by any .service files"
  /was not provided by any \.service files/,
  // "Call failed: Unit udisks2.service not found."
  /Unit udisks2\.service not found/,
];
export function classifyBusctl(error: string): Outcome {
  const detail = error.trim();
  return {
    failure: absentPatterns.some((p) => p.test(detail))
      ? "absent"
      : "unreadable",
    detail,
  };
}

/** A busctl variant as JSON: its signature and its value. */
type Variant = { type: string; data: unknown };
type Properties = Record<string, Variant>;
type Objects = Record<string, Record<string, Properties>>;
function payload(out: string): unknown[] {
  const parsed = JSON.parse(out) as { data?: unknown };
  if (!Array.isArray(parsed.data))
    throw new Error("busctl answered with no data array");
  return parsed.data;
}
const text = (v: Variant | undefined): string | null =>
  typeof v?.data === "string" && v.data.trim() ? v.data.trim() : null;
/** A device node arrives as its bytes with a trailing zero. */
function node(v: Variant | undefined): string | null {
  if (!Array.isArray(v?.data)) return null;
  const bytes = v.data.filter((b): b is number => typeof b === "number");
  const path = String.fromCharCode(...bytes.filter((b) => b !== 0));
  return path.startsWith("/dev/") ? path.slice(5) : null;
}

/** NVMe `total_data_written`, already bytes. */
export function nvmeWritten(out: string): number | null {
  const [attributes] = payload(out) as [Properties | undefined];
  const value = attributes?.total_data_written?.data;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}
/**
 * ATA attribute 241 in bytes, where udisks gives it in sectors. Each row is
 * `(id, name, flags, value, worst, threshold, pretty, pretty_unit, expansion)`.
 */
export function ataWritten(out: string): number | null {
  const [rows] = payload(out) as [unknown[][] | undefined];
  const row = rows?.find((r) => r[0] === 241 && r[1] === "total-lbas-written");
  if (!row || row[7] !== SECTORS_UNIT) return null;
  const pretty = row[6];
  return typeof pretty === "number" && Number.isSafeInteger(pretty * SECTOR)
    ? pretty * SECTOR
    : null;
}

/** A drive object path and the SMART interface it answers on. */
interface Target {
  name: string;
  model: string | null;
  drive: string;
  iface: string;
}
/**
 * Whole-disk block devices and the drive behind each. A partition names the
 * same drive as its disk and is left out; a block device with no drive, as a
 * device mapper target has, is not a drive vsys can ask about.
 */
export function udisksTargets(out: string): Target[] {
  const [objects] = payload(out) as [Objects | undefined];
  if (!objects) return [];
  const targets: Target[] = [];
  for (const interfaces of Object.values(objects)) {
    const block = interfaces["org.freedesktop.UDisks2.Block"];
    if (!block || interfaces["org.freedesktop.UDisks2.Partition"]) continue;
    const name = node(block.Device);
    const drive = text(block.Drive);
    const owner = drive ? objects[drive] : undefined;
    if (!name || !drive || !owner) continue;
    const iface = owner[nvmeInterface]
      ? nvmeInterface
      : owner[ataInterface]
        ? ataInterface
        : null;
    if (!iface) continue;
    const model = text(owner["org.freedesktop.UDisks2.Drive"]?.Model);
    targets.push({ name, model, drive, iface });
  }
  return targets.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The listing alone, busctl's cheapest call: udisksd answers it from its own
 * object cache, never by asking a drive anything. Returns the targets it
 * named, or why the listing itself could not be read.
 */
async function listUdisks(
  run: Run,
  timeoutMs: number,
): Promise<
  { targets: Target[]; outcome: null } | { targets: null; outcome: Outcome }
> {
  let listed: Awaited<ReturnType<Run>>;
  try {
    listed = await withDeadline(run(udisksObjectsArgv, timeoutMs), timeoutMs);
  } catch (error) {
    if (error instanceof RunnerAbandoned)
      return {
        targets: null,
        outcome: { failure: "unreadable", detail: error.message },
      };
    // Nothing ran. A confirmed-missing executable surfaces its own errno,
    // ENOENT; anything else that stopped busctl from starting — EAGAIN at
    // the process limit, EACCES, ... — is a launch failure, distinct from a
    // confirmed absence, because the executable may be there all along.
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
      targets: null,
      outcome: {
        failure: code === "ENOENT" ? "absent" : "unreadable",
        detail: String(error),
      },
    };
  }
  if (listed.timedOut)
    return {
      targets: null,
      outcome: { failure: "unreadable", detail: timeoutDetail(timeoutMs) },
    };
  if (listed.status !== 0)
    return { targets: null, outcome: classifyBusctl(listed.error) };
  try {
    return { targets: udisksTargets(listed.out), outcome: null };
  } catch (error) {
    return {
      targets: null,
      outcome: { failure: "malformed", detail: String(error) },
    };
  }
}

/**
 * Each target's SmartGetAttributes. A drive whose own call fails — by
 * refusal, by timeout, or by a launch failure that kept the call from even
 * starting — keeps its row with lifetime writes unknown rather than take
 * down every other drive's reading with it. When every drive failed, the
 * first refusal is the reading's outcome, because a source that answered for
 * no drive has not given what the reading needs.
 */
async function queryDrives(
  run: Run,
  timeoutMs: number,
  targets: Target[],
): Promise<UdisksReading> {
  const refusals: string[] = [];
  let firstRefusal: string | undefined;
  const noteRefusal = (detail: string) => {
    refusals.push(detail);
    firstRefusal ??= detail;
  };
  const drives = await Promise.all(
    targets.map(async ({ name, model, drive, iface }) => {
      let answer: Awaited<ReturnType<Run>>;
      try {
        answer = await withDeadline(
          run(udisksAttributesArgv(drive, iface), timeoutMs),
          timeoutMs,
        );
      } catch (error) {
        noteRefusal(error instanceof Error ? error.message : String(error));
        return { name, model, written: null };
      }
      if (answer.timedOut) {
        noteRefusal(timeoutDetail(timeoutMs));
        return { name, model, written: null };
      }
      if (answer.status !== 0) {
        noteRefusal(answer.error.trim());
        return { name, model, written: null };
      }
      try {
        const written =
          iface === nvmeInterface
            ? nvmeWritten(answer.out)
            : ataWritten(answer.out);
        return { name, model, written };
      } catch (error) {
        noteRefusal(String(error));
        return { name, model, written: null };
      }
    }),
  );
  const outcome: Outcome =
    targets.length > 0 &&
    refusals.length === targets.length &&
    firstRefusal !== undefined
      ? { failure: "incomplete", detail: firstRefusal }
      : null;
  return { drives, outcome };
}

/**
 * The drives udisks answers for, read through busctl: the listing, then each
 * target's SmartGetAttributes.
 */
export async function readUdisks(
  run: Run = spawnText,
  timeoutMs: number = udisksTimeoutMs,
): Promise<UdisksReading> {
  const listing = await listUdisks(run, timeoutMs);
  if (listing.targets === null) return { drives: [], outcome: listing.outcome };
  return queryDrives(run, timeoutMs, listing.targets);
}

/**
 * One collector's udisks reading, held for `udisksHoldMs` on the clock it is
 * given. A collector given none never asks udisks, which keeps the system bus
 * out of the test suite.
 */
export class Udisks {
  private held: { at: number; reading: UdisksReading } | null = null;
  constructor(
    private run: Run = spawnText,
    private now: () => number = () => performance.now(),
    private timeoutMs: number = udisksTimeoutMs,
  ) {}
  async read(): Promise<UdisksReading> {
    const at = this.now();
    if (this.held && at - this.held.at < udisksHoldMs) return this.held.reading;
    const reading = await readUdisks(this.run, this.timeoutMs);
    this.held = { at, reading };
    return reading;
  }
}
