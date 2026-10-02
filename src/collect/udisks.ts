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
 * different identity, that stopped or started reporting one at all, or that
 * the listing no longer names, drops the held reading rather than keep
 * serving it, and so does a listing that could not itself be read.
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
 * Whether a held drive and the fresh target under its name are provably the
 * same physical drive, a confirmed change, or neither provable: `changed`
 * also covers a name the held reading never answered for, which has no
 * prior to compare and so is always queried fresh. A differing `identity`
 * (`null` on either side counts, since a drive that stopped or started
 * reporting one is not provably the drive that was held) is `changed`.
 * Where both report no identity at all, `identity` alone cannot tell them
 * apart — `null !== null` is false — so `detected` corroborates instead:
 * equal and known on both sides is `same`, unequal and both known is
 * `changed`, and unknown on either side is `unprovable` — no signal at all
 * ties this name to the drive now behind it, or rules it out.
 */
function compareDrive(
  prior: UdisksDrive | undefined,
  target: Target,
): "same" | "changed" | "unprovable" {
  if (prior === undefined) return "changed";
  if (target.identity !== prior.identity) return "changed";
  if (target.identity !== null) return "same";
  if (prior.detected !== null && target.detected !== null)
    return prior.detected === target.detected ? "same" : "changed";
  return "unprovable";
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
 * `compareDrive` sorts every fresh target against its held counterpart, by
 * name, into three groups, and only the first changes what the next sample
 * asks over the bus:
 *
 * - `changed` (a confirmed swap, or a name with no held counterpart at all)
 *   is queried fresh, scoped to that drive alone — every other held drive
 *   keeps serving its own reading untouched, so one swapped or newly seen
 *   drive never forces a machine-wide re-query.
 * - `unprovable` (neither side has an identity, and `detected` is unknown on
 *   at least one side, so nothing ties this name to the drive now behind
 *   it, or rules it out) reads as unknown rather than either keep serving
 *   the held drive's numbers or ask again: a repeat ask would not make the
 *   pair any more provable, so it is never queried, and the hold's clock
 *   runs on undisturbed for every other, provable drive.
 * - `same` keeps the held value, unchanged, with no query.
 *
 * A name the held reading answered for that the fresh listing no longer
 * names at all is simply absent from that sorted result, so it drops out of
 * the served reading on its own. Once any name queries fresh, the hold's
 * clock restarts from this sample, as a full read below would; an
 * `unprovable` name alone does not restart it, so a drive that never gives
 * either signal does not hold every other drive's clock hostage — the
 * ordinary `udisksHoldMs` cycle still reaches it, each cycle giving it one
 * sample's worth of a real reading before the within-hold checks that
 * follow read it as unprovable again.
 *
 * A listing that could not itself be read proves nothing either way, so it
 * is read as a sign to drop the held reading too: this sample reports that
 * failure as its own outcome at once, without asking the listing again
 * within this same call. A later sample, while the hold still has time
 * left, takes the full read below and asks the listing fresh; if the
 * failure persists there, it is that later sample's own outcome in turn,
 * rather than the held reading's old, unrelated outcome standing in for it.
 *
 * A held reading with no drives at all — kept from a failed first read, or
 * from two listing failures in a row, each dropping the held reading in turn
 * until the second one's own empty result is what gets held, or simply from
 * a real system that then had zero SMART-capable drives — is read as stale
 * by any fresh listing naming at least one target, without asking
 * `compareDrive` to sort it: an empty held reading has no prior drive to
 * compare against, so that sort would vacuously report nothing changed
 * forever. This also covers a drive hot-plugged in after a genuinely
 * driveless hold started, not only a failure's recovery.
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
        // The swap-check listing itself failed: that is this sample's own
        // outcome. The held reading is dropped outright rather than kept as
        // an empty-drives placeholder — a compare against held.drives by
        // iterating it would read an empty array as "nothing to compare"
        // and vacuously pass as unchanged, letting this stale failure answer
        // for every sample until the hold expires. Dropping it sends a
        // single next sample through the non-held branch below, which runs
        // a genuine readUdisks() and recovers if the bus is back by then; a
        // bus still down on that next sample fails readUdisks() the same way
        // and is held again, so two consecutive failures still ride out the
        // rest of the hold. Either way, this call alone no longer repeats
        // the identical listing call readUdisks() would otherwise make.
        this.held = null;
        return { drives: [], outcome: listing.outcome };
      }
      // An empty held reading cannot be proven stale by sorting: with no
      // prior drive to compare against, every fresh target would vacuously
      // sort as having nothing to compare. Any fresh listing naming at least
      // one target already proves it stale on its own, with nothing left to
      // compare by name.
      const emptyHeldProvenStale =
        this.held.reading.drives.length === 0 && listing.targets.length > 0;
      if (!emptyHeldProvenStale) {
        const priorByName = new Map(
          this.held.reading.drives.map((d) => [d.name, d]),
        );
        const freshNames = new Set(listing.targets.map((t) => t.name));
        const goneDrive = this.held.reading.drives.some(
          (d) => !freshNames.has(d.name),
        );
        const toQuery: Target[] = [];
        const unprovable = new Set<string>();
        for (const target of listing.targets) {
          const verdict = compareDrive(priorByName.get(target.name), target);
          if (verdict === "changed") toQuery.push(target);
          else if (verdict === "unprovable") unprovable.add(target.name);
        }
        if (toQuery.length === 0 && unprovable.size === 0 && !goneDrive)
          return this.held.reading;
        // The clock restarts only where a real query ran: an unprovable or
        // gone name alone changes what this sample serves, not when the
        // SMART data behind every other drive was last actually asked for.
        const heldAt = toQuery.length > 0 ? at : this.held.at;
        const refreshed = await queryDrives(this.run, this.timeoutMs, toQuery);
        const refreshedByName = new Map(
          refreshed.drives.map((d) => [d.name, d]),
        );
        const drives: UdisksDrive[] = listing.targets.map((target) => {
          const fresh = refreshedByName.get(target.name);
          if (fresh) return fresh;
          if (unprovable.has(target.name))
            return {
              name: target.name,
              model: null,
              written: null,
              identity: target.identity,
              detected: target.detected,
            };
          const prior = priorByName.get(target.name);
          if (prior) return prior;
          // compareDrive sorted this target as neither changed nor
          // unprovable, which only happens with a held counterpart (`same`
          // needs `prior !== undefined`), so this is unreachable.
          throw new Error(
            `udisks: target ${target.name} resolved to neither a fresh, unprovable, nor held reading`,
          );
        });
        this.held = {
          at: heldAt,
          reading: { drives, outcome: refreshed.outcome },
        };
        return this.held.reading;
      }
    }
    const reading = await readUdisks(this.run, this.timeoutMs);
    this.held = { at, reading };
    return reading;
  }
}
