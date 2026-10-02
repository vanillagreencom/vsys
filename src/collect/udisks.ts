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
 * udisks itself refreshes these from the drive on its own schedule, so each
 * drive's SMART query is held for `udisksHoldMs` rather than asked for again
 * every sample. The listing of which drive answers to which kernel name is
 * asked again every sample regardless, because it costs udisksd only a
 * lookup in its own object cache; a kernel name that now answers with a
 * different identity, that stopped or started reporting one at all, that the
 * listing no longer names, or that the held reading has no drive for, drops
 * the held reading rather than keep serving it, and so does a listing that
 * could not itself be read.
 */

import type { Outcome } from "./capabilities";
import { killGraceMs, spawnText } from "./io";

const service = "org.freedesktop.UDisks2";
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
  /**
   * The drive's serial, or its WWN where udisks reports no serial; null
   * where udisks reports neither. A held reading is checked against this on
   * the next sample, because a kernel name survives a hot swap and this
   * does not.
   */
  identity: string | null;
  /**
   * `Drive.TimeDetected`, null where udisks gives none. Checked against the
   * held reading only where `identity` is null on both sides, since two
   * drives neither reporting a Serial nor a WWN cannot otherwise be told
   * apart under one kernel name.
   */
  detected: number | null;
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
/**
 * `Drive.TimeDetected`: usec since the Epoch the currently-plugged drive was
 * detected; `0` is the Epoch itself, not a time any attached drive could
 * report, so it reads as no usable value rather than a real timestamp.
 * Serial and WWN already tell two drives apart; this is the one signal
 * udisks still gives when a drive reports neither, since a swap under one
 * kernel name changes it even where the drive's identity stays `null` on
 * both sides.
 */
const timeDetected = (v: Variant | undefined): number | null =>
  typeof v?.data === "number" && Number.isSafeInteger(v.data) && v.data > 0
    ? v.data
    : null;
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
  identity: string | null;
  detected: number | null;
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
    const drv = owner["org.freedesktop.UDisks2.Drive"];
    const model = text(drv?.Model);
    const identity = text(drv?.Serial) ?? text(drv?.WWN);
    const detected = timeDetected(drv?.TimeDetected);
    targets.push({ name, model, drive, iface, identity, detected });
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
    targets.map(async ({ name, model, drive, iface, identity, detected }) => {
      let answer: Awaited<ReturnType<Run>>;
      try {
        answer = await withDeadline(
          run(udisksAttributesArgv(drive, iface), timeoutMs),
          timeoutMs,
        );
      } catch (error) {
        noteRefusal(error instanceof Error ? error.message : String(error));
        return { name, model, written: null, identity, detected };
      }
      if (answer.timedOut) {
        noteRefusal(timeoutDetail(timeoutMs));
        return { name, model, written: null, identity, detected };
      }
      if (answer.status !== 0) {
        noteRefusal(answer.error.trim());
        return { name, model, written: null, identity, detected };
      }
      try {
        const written =
          iface === nvmeInterface
            ? nvmeWritten(answer.out)
            : ataWritten(answer.out);
        return { name, model, written, identity, detected };
      } catch (error) {
        noteRefusal(String(error));
        return { name, model, written: null, identity, detected };
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
 * Whether a target carries any signal `identitySwapped` can compare: an
 * identity, or — where it has none — a known `TimeDetected`. A target with
 * neither is never provably the same drive from one sample to the next, no
 * matter what is compared, so it never enters the held reading or a SMART
 * query at all; `unprovableRow` renders its row fresh, as unknown, every
 * sample instead, at no query cost.
 */
function isProvable(target: Target): boolean {
  return target.identity !== null || target.detected !== null;
}

/**
 * An unprovable target's row: udisks gives nothing that ties this kernel
 * name to any one physical drive, so its model and lifetime writes stay
 * unknown rather than risk serving a departed drive's numbers under it, or
 * spending a query that could not make the pair any more provable anyway.
 */
function unprovableRow(target: Target): UdisksDrive {
  return {
    name: target.name,
    model: null,
    written: null,
    identity: null,
    detected: null,
  };
}

/**
 * Whether the fresh, provable-only targets prove the held (also
 * provable-only) reading stale: a fresh target the held reading has no row
 * for, since that drive was never queried; a name both name now answers a
 * different identity for (`null` on either side counts, since a drive that
 * stopped or started reporting one is not provably the drive that was held),
 * or, where both report none, a different `detected`; or a name the held
 * reading answered for that the fresh provable targets no longer name at all
 * — gone, or turned unprovable itself. Every target reaching this check is
 * already provable by construction, so the case neither side has any
 * signal at all never arises here; that case is `isProvable`'s to filter out
 * before this runs.
 *
 * A target with no held row forces one fresh query only: `queryDrives`
 * returns a row for every target it is given, its own failed call included,
 * so the next sample finds that row and compares against it.
 */
function identitySwapped(held: UdisksReading, targets: Target[]): boolean {
  const priorByName = new Map(held.drives.map((d) => [d.name, d]));
  const freshNames = new Set(targets.map((t) => t.name));
  return (
    targets.some((target) => {
      const prior = priorByName.get(target.name);
      if (prior === undefined) return true;
      if (target.identity !== prior.identity) return true;
      return target.identity === null && target.detected !== prior.detected;
    }) || held.drives.some((d) => !freshNames.has(d.name))
  );
}

/**
 * The listing's targets merged into one reading, in listing order: a
 * provable target takes its row from `provable` (which answers for exactly
 * the provable targets, held or freshly queried), and an unprovable one is
 * rendered fresh by `unprovableRow`. Every provable target has a row there:
 * a held reading is served only when `identitySwapped` found a held row for
 * each, and a fresh one comes from `queryDrives` over these same targets. A
 * provable target with no row would read as unknown rather than invent or
 * withhold one.
 */
function mergeReading(
  provable: UdisksReading,
  targets: Target[],
): UdisksReading {
  const provableByName = new Map(provable.drives.map((d) => [d.name, d]));
  return {
    drives: targets.map((target) => {
      if (!isProvable(target)) return unprovableRow(target);
      return (
        provableByName.get(target.name) ?? {
          name: target.name,
          model: null,
          written: null,
          identity: target.identity,
          detected: target.detected,
        }
      );
    }),
    outcome: provable.outcome,
  };
}

/**
 * One collector's udisks reading, held for `udisksHoldMs` on the clock it is
 * given. A collector given none never asks udisks, which keeps the system bus
 * out of the test suite.
 *
 * The hold hides the expensive part — asking each drive for its own SMART
 * attributes — but never the listing: `listUdisks` is udisksd answering from
 * its own object cache, not a drive query, so re-reading it every sample
 * costs nothing the hold exists to save, and it is what notices a kernel
 * name now sitting behind a different serial, WWN or `TimeDetected`, or a
 * held name the listing no longer answers for at all.
 *
 * The held reading, and the hold's one shared clock, cover only the
 * provable targets `isProvable` selects — a drive udisks gives neither a
 * Serial, a WWN nor a `TimeDetected` for is rare enough that the accepted
 * answer for it is simpler than chasing it: it never enters this mechanism
 * at all, is never queried, and `unprovableRow` renders its row fresh, as
 * unknown, every single sample — no clock, no held reading, no query ever
 * runs for it, so it can never serve a departed drive's numbers and never
 * costs udisks anything either. `mergeReading` is what puts its row back
 * beside the provable ones in the reading this method returns.
 *
 * Among the provable targets, a kernel name whose identity changed, that
 * gained or lost it entirely, or that the fresh provable targets no longer
 * name at all, drops the whole held (provable) reading and reads it fresh
 * rather than serving the departed drive's numbers; a same-identity re-read
 * keeps serving the held one. A listing that could not itself be read is
 * read as a sign to drop the held reading too, never as proof nothing
 * changed. A provable target the held reading has no row for, a drive newly
 * attached or newly reporting a Serial, a WWN or a `TimeDetected`, drops it
 * the same way, so that drive is read in the sample it first appears.
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
    if (this.held && at - this.held.at < udisksHoldMs) {
      const listing = await listUdisks(this.run, this.timeoutMs);
      if (listing.targets === null) {
        this.held = null;
        return { drives: [], outcome: listing.outcome };
      }
      const provableTargets = listing.targets.filter(isProvable);
      if (!identitySwapped(this.held.reading, provableTargets))
        return mergeReading(this.held.reading, listing.targets);
    }
    const listing = await listUdisks(this.run, this.timeoutMs);
    if (listing.targets === null) {
      this.held = null;
      return { drives: [], outcome: listing.outcome };
    }
    const provableTargets = listing.targets.filter(isProvable);
    const reading = await queryDrives(
      this.run,
      this.timeoutMs,
      provableTargets,
    );
    this.held = { at, reading };
    return mergeReading(reading, listing.targets);
  }
}
