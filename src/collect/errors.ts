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
}

/**
 * A reboot zeroes the counters. That is a new baseline, never a repair, so the
 * recorded growth stays and only the baseline moves.
 */
export class ErrorMemory {
  private records = new Map<string, ErrorRecord>();
  private loaded = false;
  private dirty = false;
  constructor(private readonly path: string) {}
  /**
   * A missing or unreadable file starts empty and the caller reports the
   * failure. The records are built aside and committed whole, so a file that
   * fails halfway leaves no half-read memory behind to be written back out.
   */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
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
      });
    }
    this.records = read;
  }
  /**
   * Record what the counter reads now and return what is known about its last
   * growth. The first reading of a filesystem establishes a baseline and
   * claims no error time: a counter already above zero says damage happened,
   * not when.
   */
  observe(fsid: string, counter: number, time: number): ErrorRecord {
    const seen = this.records.get(fsid);
    const record: ErrorRecord =
      seen === undefined
        ? { counter, at: null, size: null }
        : counter > seen.counter
          ? { counter, at: time, size: counter - seen.counter }
          : { ...seen, counter };
    if (
      !seen ||
      seen.counter !== record.counter ||
      seen.at !== record.at ||
      seen.size !== record.size
    ) {
      this.records.set(fsid, record);
      this.dirty = true;
    }
    return record;
  }
  /** Written whole and moved into place, so an interrupted write loses nothing. */
  save(): void {
    if (!this.dirty) return;
    this.dirty = false;
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
  }
}
