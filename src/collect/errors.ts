import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * When a filesystem's corruption counter last grew. The history window is a
 * day and a quiet counter can be older than that, so this outlives both the
 * window and the process: without it "last new error 31 h ago" becomes "no
 * errors", which is the reading that hid the damage in the first place.
 */
export interface ErrorRecord {
  /** The counter the previous sample read, which growth is measured against. */
  counter: number;
  /** When it last grew, null while no growth has ever been observed. */
  at: number | null;
  /** How far it grew that time. */
  size: number | null;
  /**
   * When the reading before that growth was taken, which still read the
   * counter below it. The growth happened after this and by `at`; null where
   * that reading came from the file rather than this process.
   */
  before: number | null;
  /**
   * When the reading from the file that growth was measured against was
   * taken. The counter read no higher then, so the growth happened after it,
   * but readings after it that changed nothing were never written, so it
   * bounds the growth only loosely. Null where `before` holds the bound, and
   * where that reading carries no time.
   */
  storedBefore: number | null;
  /**
   * When this reading was taken. A record is one observation of one counter,
   * so a merge takes the later reading whole rather than mixing a counter
   * from one with a growth time from another.
   */
  seen: number;
}

/**
 * A reboot zeroes the counters. That is a new baseline, never a repair, so the
 * recorded growth stays and only the baseline moves.
 */
export class ErrorMemory {
  private records = new Map<string, ErrorRecord>();
  /**
   * Filesystems whose held record is a reading this process took. This
   * process holds every reading it takes, so only those bound the next growth
   * to one sample interval; the file holds the last reading written, and the
   * readings after it that changed nothing never were.
   */
  private readonly readHere = new Set<string>();
  private loaded = false;
  private dirty = false;
  /**
   * False once a read failed for any reason but the file not being there. A
   * missing file is an empty memory, which is a reading; unreadable text is
   * not, and everything downstream must say so rather than report no errors.
   */
  available = true;
  /** Whether the file on disk could be read. A write never overwrites one that could not. */
  readable = true;
  constructor(private readonly path: string) {}
  /**
   * A missing or unreadable file starts empty and the caller reports the
   * failure. The records are built aside and committed whole, so a file that
   * fails halfway leaves no half-read memory behind to be written back out.
   */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.read();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        this.readable = false;
        this.available = false;
      }
      throw e;
    }
  }
  private read(): void {
    const raw = readFileSync(this.path, "utf8");
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Error memory must be an object");
    const read = new Map<string, ErrorRecord>();
    for (const [fsid, record] of Object.entries(value)) {
      const r = record as Partial<ErrorRecord>;
      if (typeof r?.counter !== "number" || !Number.isFinite(r.counter))
        throw new Error(`Invalid counter for ${fsid}`);
      read.set(fsid, {
        counter: r.counter,
        at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : null,
        size:
          typeof r.size === "number" && Number.isFinite(r.size) ? r.size : null,
        before:
          typeof r.before === "number" && Number.isFinite(r.before)
            ? r.before
            : null,
        storedBefore:
          typeof r.storedBefore === "number" && Number.isFinite(r.storedBefore)
            ? r.storedBefore
            : null,
        // A record written before this field existed loses every merge to a
        // reading taken now, which is the reading that is current.
        seen:
          typeof r.seen === "number" && Number.isFinite(r.seen) ? r.seen : 0,
      });
    }
    this.records = read;
  }
  /**
   * Record what the counter reads now and return what is known about its last
   * growth. The first reading of a filesystem establishes a baseline and
   * claims no error time: a counter already above zero says damage happened,
   * not when.
   *
   * Every reading is held as the latest one, so the next growth is bounded
   * by the reading just before it. Growth after a reading from the file has
   * no such bound, only the time that reading was written.
   */
  observe(fsid: string, counter: number, time: number): ErrorRecord {
    const prior = this.records.get(fsid);
    const here = this.readHere.has(fsid);
    const record: ErrorRecord =
      prior === undefined
        ? {
            counter,
            at: null,
            size: null,
            before: null,
            storedBefore: null,
            seen: time,
          }
        : counter > prior.counter
          ? {
              counter,
              at: time,
              size: counter - prior.counter,
              before: here ? prior.seen : null,
              // A record written before `seen` existed loads it as zero,
              // which is no time at all.
              storedBefore: here || prior.seen === 0 ? null : prior.seen,
              seen: time,
            }
          : { ...prior, counter, seen: time };
    this.records.set(fsid, record);
    this.readHere.add(fsid);
    if (
      !prior ||
      prior.counter !== record.counter ||
      prior.at !== record.at ||
      prior.size !== record.size
    )
      this.dirty = true;
    return record;
  }
  /**
   * Written whole and moved into place, so an interrupted write loses nothing.
   * A write that failed leaves the memory dirty, so the next sample tries
   * again: a full disk or a read-only state directory would otherwise discard
   * the one reading this class exists to keep.
   */
  save(): void {
    // A file that could not be read is never overwritten: the baselines this
    // process holds would replace a record a person can still repair, and
    // would turn an unknown last-error time into a confident one.
    if (!this.dirty || !this.readable) return;
    // Two vsys processes watching one host each hold the map they loaded, and
    // the one that renames last would otherwise drop the other's newer growth
    // time. Merging the file as it stands now keeps the later of the two.
    // A refusal is raised rather than returned: the caller reports it, the
    // memory stays dirty, and the next sample tries again. Returning quietly
    // would drop the reading with no word anywhere.
    if (!this.merge())
      throw new Error(`Error memory on disk could not be read: ${this.path}`);
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      `${JSON.stringify(Object.fromEntries(this.records))}\n`,
      {
        mode: 0o600,
      },
    );
    renameSync(temp, this.path);
    this.dirty = false;
    // What this process holds now survives it, so its readings stand again.
    this.available = this.readable;
  }
  /** A write that did not happen leaves the memory unbacked until one does. */
  failed(): void {
    this.available = false;
  }
  /**
   * Fold what is on disk now into what this process holds. A growth time is
   * only ever later than the one before it, and a counter only rises until a
   * reboot resets both processes alike, so the newer of each wins and neither
   * process loses what the other saw.
   */
  private merge(): boolean {
    let stored: Map<string, ErrorRecord>;
    const other = new ErrorMemory(this.path);
    try {
      other.load();
      stored = other.records;
    } catch {
      // A file that is merely absent is the first write, and this process's
      // own records stand. One that exists and cannot be read is refused the
      // same way our own unreadable load is: it may hold a growth time this
      // process never saw.
      return other.readable;
    }
    for (const [fsid, theirs] of stored) {
      const mine = this.records.get(fsid);
      if (!mine) {
        this.records.set(fsid, theirs);
        continue;
      }
      // The later reading wins whole. Mixing them would pair one process's
      // counter with another's growth time: taking the higher counter, in
      // particular, restores a pre-reboot high-water mark and hides every
      // error counted after the reboot until the counter passes it again.
      if (theirs.seen > mine.seen) {
        this.records.set(fsid, theirs);
        this.readHere.delete(fsid);
      }
    }
    return true;
  }
}
