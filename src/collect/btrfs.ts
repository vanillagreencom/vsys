import type { Dirent } from "node:fs";
import { readdir, realpath, stat, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  FinishedScrub,
  Scrub,
  ScrubCoverage,
  Storage,
  Volume,
} from "../model/types";
import { classify, type Outcome } from "./capabilities";
import { collectDevices, smartReports } from "./devices";
import { ErrorMemory } from "./errors";
import { pairs, type Reader } from "./io";
import type { KernelLog } from "./kernel-log";
import { type MountInfo, readMounts } from "./mounts";
import { ScratchCollector } from "./scratch";
import { counted, isReportName, parseScrub, stated } from "./scrub";
import type { CollectionConfig } from "./settings";
import type { Udisks } from "./udisks";

/** Either a mount restriction or a superblock restriction makes a mount read-only. */
export function btrfsMounts(
  mountInfo: MountInfo[],
): Pick<Volume, "mount" | "device" | "options" | "readOnly">[] {
  return mountInfo
    .filter((m) => m.type === "btrfs")
    .map((m) => ({
      mount: m.mount,
      device: m.device,
      options: m.options,
      readOnly: m.options.includes("ro"),
    }));
}

/** Reject unknown scrub output instead of calling it healthy. */
export function scrubProblem(raw: string): boolean {
  // The same rule integrity() uses: only a report that says it finished, or
  // one still running, carries a result worth reading past the status word.
  // Any other status, interrupted included, is a problem on its own.
  const status = parseScrub(raw).status;
  if (status !== null && status !== "finished" && status !== "running")
    return true;
  // The counted-error lines under the summary are the reading wherever the
  // report carries them. A label it states more than once, as a per-device
  // listing does, holds no single count: reading the first would let one
  // device's zero speak for a filesystem another device found damage on.
  const labels = ["Corrected", "Uncorrectable"].filter(
    (name) => stated(raw, name) > 0,
  );
  if (labels.some((name) => !counted(raw, name)))
    throw new Error("Scrub result states a count it does not carry");
  if (labels.length) {
    const report = parseScrub(raw);
    return (report.corrected ?? 0) > 0 || (report.uncorrectable ?? 0) > 0;
  }
  if (/\buncorrectable\b/i.test(raw)) return true;
  const count = raw.match(/Error summary:\s*(\d+)/i);
  if (count) return Number(count[1]) > 0;
  if (/Error summary:\s+no errors found/i.test(raw)) return false;
  const stats = [
    ...raw.matchAll(
      /(?:read|csum|verify|super|malloc|uncorrectable|corrected)_errors[=:]\s*(\d+)/g,
    ),
  ];
  if (stats.length) return stats.some((m) => Number(m[1]) > 0);
  throw new Error("Unrecognized scrub result");
}

/**
 * Whether a FINISHED scrub's own numbers count as damage: an address still
 * listed, an uncorrectable block, or a problem report whose count could not
 * be read. The one rule both the live report and a remembered one are judged
 * by, so a check that is only remembered reads no differently from one still
 * live.
 */
export function scrubFoundDamage(outcome: {
  addressCount: number;
  uncorrectable: number | null | undefined;
  problem: boolean;
}): boolean {
  return (
    outcome.addressCount > 0 ||
    (outcome.uncorrectable ?? 0) > 0 ||
    (outcome.problem &&
      (outcome.uncorrectable === null || outcome.uncorrectable === undefined))
  );
}

/**
 * The counter growth a FINISHED scrub's own numbers account for, judged by
 * the same one rule for the live report and a remembered one. A report that
 * does not carry its start, its duration, or both counts dates or counts no
 * growth, so it covers none. Its csum count is carried as read: an unread one
 * leaves the rest of the coverage standing.
 */
export function scrubCoverage(report: {
  startedAt?: number | null;
  duration?: number | null;
  corrected?: number | null;
  uncorrectable?: number | null;
  csum?: number | null;
}): ScrubCoverage | null {
  const { startedAt, duration, corrected, uncorrectable } = report;
  if (
    startedAt == null ||
    duration == null ||
    corrected == null ||
    uncorrectable == null
  )
    return null;
  return {
    startedAt,
    endedAt: startedAt + duration,
    errors: corrected + uncorrectable,
    csum: report.csum ?? null,
  };
}

/**
 * The paths of a damaged address that are still on disk. A path vsys cannot
 * stat is kept: an unreadable directory is not proof the file is gone, and
 * dropping it would list less than the address holds.
 */
async function present(paths: string[]): Promise<string[]> {
  const kept = await Promise.all(
    paths.map(async (path) => {
      try {
        await stat(path);
        return path;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : path;
      }
    }),
  );
  return kept.filter((path) => path !== null);
}
/**
 * The corruption counter for a whole filesystem: the sum over its devices,
 * which is what a reader means by "this filesystem found damage". Null while
 * any device failed to report, because a missing counter is not a zero.
 */
export function corruptionTotal(
  errors: Record<string, number>,
  available: boolean,
): number | null {
  if (!available) return null;
  const raised = Object.entries(errors).filter(([kind]) =>
    kind.endsWith("/corruption_errs"),
  );
  return raised.length
    ? raised.reduce((sum, [, value]) => sum + value, 0)
    : null;
}

/**
 * Each filesystem's last finished scrub, by lowercased filesystem id, held so
 * a predecessor and the successor a settings change builds from it can share
 * one memory instead of each holding a copy. A sample still finishing on the
 * predecessor when the successor is built keeps writing to this same object,
 * so a report that lands after the handoff is never stranded on a copy the
 * successor cannot see. `advance` is the only writer, and it never moves a
 * filesystem's entry backward: a stopped-early report leaves it standing.
 */
export class FinishedScrubMemory {
  private byFsid: Map<string, FinishedScrub>;
  constructor(seed?: Record<string, FinishedScrub>) {
    this.byFsid = new Map(Object.entries(seed ?? {}));
  }
  get(key: string): FinishedScrub | undefined {
    return this.byFsid.get(key);
  }
  advance(key: string, scrub: FinishedScrub): void {
    const remembered = this.byFsid.get(key);
    if (remembered === undefined || scrub.at > remembered.at)
      this.byFsid.set(key, scrub);
  }
  snapshot(): Record<string, FinishedScrub> {
    return Object.fromEntries(this.byFsid);
  }
}

/** Counter baselines belong to a filesystem/device, not a mount alias. */
export class StorageCollector {
  /**
   * The kernel log, where this user can search it. A collector built without
   * one reads no journal, which is what keeps the machine's own log out of
   * the test suite.
   */
  constructor(
    private kernelLog: KernelLog | null = null,
    /**
     * udisks, asked for lifetime writes where no drive report directory can
     * be listed. A collector built without one never asks the system bus.
     */
    private udisks: Udisks | null = null,
    /**
     * The predecessor's own `FinishedScrubMemory`, shared rather than copied,
     * so a settings change that replaces this collector while the
     * predecessor's sample is still finishing never reads a stopped-early
     * report as if nothing had ever finished, or ever found damage: whichever
     * of the two collectors next reaches a finished report, both see it.
     */
    sharedFinishedScrub?: FinishedScrubMemory,
  ) {
    this.finishedScrub = sharedFinishedScrub ?? new FinishedScrubMemory();
  }
  private initial = new Map<string, number>();
  private last = new Map<string, number>();
  private scratch = new ScratchCollector();
  private memory: ErrorMemory | null = null;
  private memoryPath = "";
  /**
   * Carried across samples because the reporter keeps one report per
   * filesystem and a check that stops early overwrites it; this process's
   * own memory of the last one that finished, outcome included, is otherwise
   * lost.
   */
  private finishedScrub: FinishedScrubMemory;
  /** The live memory handle, to share with a successor built from this one. */
  finishedScrubMemory(): FinishedScrubMemory {
    return this.finishedScrub;
  }
  /**
   * The scrub report directory as the last collection's read of it found it:
   * null where the listing answered, the failure where it did not, and
   * undefined until a collection has listed it. The directory appears while
   * vsys runs, when the reader installs the reporter vsys offers, so the
   * collector takes the capability from this read rather than reading the
   * directory a second time, synchronously, on the sample path.
   */
  scrubDir: Outcome | undefined = undefined;
  /**
   * The drive report directory as the last collection's listing found it,
   * for the same reason: installing the drive reporter vsys offers creates it
   * while vsys runs.
   */
  smartDir: Outcome | undefined = undefined;
  close(): void {
    this.scratch.close();
  }
  /**
   * The remembered growth times, reloaded when the configured path changes. A
   * file that cannot be read leaves the memory empty rather than stopping
   * collection: an unknown last-error time is still better than a wrong one.
   */
  private errorMemory(r: Reader, path: string): ErrorMemory {
    if (!this.memory || this.memoryPath !== path) {
      this.memory = new ErrorMemory(path);
      this.memoryPath = path;
      try {
        this.memory.load();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") r.error(path, e);
      }
    }
    return this.memory;
  }
  async collect(
    r: Reader,
    c: CollectionConfig,
    time: number,
    mountInfo: MountInfo[] | null = readMounts(r, c.procRoot),
    waitForScratch = true,
    skipScratch = false,
    /** The temporary directories running agents name, measured as scratch. */
    agentScratch: string[] = [],
    skipKernelLog = false,
  ): Promise<Storage> {
    const smart = smartReports(r, c);
    this.smartDir = smart.outcome;
    // The author's timer leaves its reports where `smartDir` points, so a
    // listing that answers keeps udisks out of the reading entirely.
    const udisks =
      smart.outcome !== null && this.udisks ? await this.udisks.read() : null;
    const storage: Storage = {
      mountsAvailable: mountInfo !== null,
      devices: collectDevices(r, c, smart.reports, udisks?.drives ?? null),
      ...(udisks ? { udisks: udisks.outcome } : {}),
      volumes: [],
      scratch: [],
      sessions: [],
      scrubs: [],
    };
    const devices = new Map<string, string>();
    /** This boot's block device names, as the kernel log writes them. */
    const names = new Map<string, string>();
    const memory = this.errorMemory(r, c.errorMemoryPath);
    const growth = new Map<
      string,
      {
        at: number | null;
        size: number | null;
        before: number | null;
        storedBefore: number | null;
      }
    >();
    const counters = new Map<
      string,
      {
        errors: Record<string, number>;
        delta: Record<string, number>;
        sinceStart: Record<string, number>;
        countersAvailable: boolean;
      }
    >();
    for (const fsid of r
      .dirs(c.btrfsRoot, true)
      .filter((n) => n !== "features")) {
      const root = join(c.btrfsRoot, fsid);
      try {
        for (const entry of await readdir(join(root, "devices"))) {
          const link = r.link(join(root, "devices", entry));
          if (link) {
            names.set(entry, fsid);
            devices.set(`/dev/${entry}`, fsid);
            devices.set(
              resolve(root, "devices", link).split("/").at(-1) ?? entry,
              fsid,
            );
          }
        }
      } catch (e) {
        r.error(join(root, "devices"), e);
      }
      const values = {
        errors: {} as Record<string, number>,
        delta: {} as Record<string, number>,
        sinceStart: {} as Record<string, number>,
        countersAvailable: true,
      };
      const devinfo = r.dirs(join(root, "devinfo"));
      if (!devinfo.length) values.countersAvailable = false;
      for (const device of devinfo) {
        const file = join(root, "devinfo", device, "error_stats");
        const raw = r.text(file);
        if (raw === null) {
          values.countersAvailable = false;
          continue;
        }
        try {
          const parsed = pairs(raw);
          for (const kind of [
            "write_errs",
            "read_errs",
            "flush_errs",
            "corruption_errs",
            "generation_errs",
          ])
            if (parsed[kind] === undefined)
              throw new Error(`Missing counter: ${kind}`);
          for (const [kind, value] of Object.entries(parsed)) {
            const key = `${fsid}/${device}/${kind}`;
            const initial = this.initial.get(key) ?? value;
            const last = this.last.get(key) ?? value;
            if (value < last) r.error(file, `Counter reset: ${kind}`);
            this.initial.set(key, value < initial ? value : initial);
            this.last.set(key, value);
            const name = `${device}/${kind}`;
            values.errors[name] = value;
            values.delta[name] = Math.max(0, value - last);
            values.sinceStart[name] = Math.max(0, value - initial);
          }
        } catch (e) {
          values.countersAvailable = false;
          r.error(file, e);
        }
      }
      counters.set(fsid, values);
      // The counter a reader asks about is the filesystem's, so growth is
      // remembered per filesystem rather than per device: a second member
      // device reporting the same damage is one event, not two.
      const corruption = corruptionTotal(
        values.errors,
        values.countersAvailable,
      );
      if (corruption !== null)
        growth.set(fsid, memory.observe(fsid, corruption, time));
    }
    storage.csumFailures = null;
    if (this.kernelLog && !skipKernelLog)
      try {
        storage.csumFailures = await this.kernelLog.read(
          names,
          r.text(join(c.procRoot, "sys/kernel/random/boot_id")),
        );
      } catch (e) {
        r.error("journalctl", e);
        // What earlier searches read still stands; the log is unread only
        // where no search has ever completed.
        storage.csumFailures = this.kernelLog.held();
      }
    try {
      memory.save();
    } catch (e) {
      // The growth times this sample holds live only in this process until a
      // write succeeds, so nothing downstream may read them as durable.
      memory.failed();
      r.error(c.errorMemoryPath, e);
    }
    for (const mount of btrfsMounts(mountInfo ?? []).filter(
      (m) => !c.btrfsMounts.length || c.btrfsMounts.includes(m.mount),
    )) {
      let fsid =
        devices.get(mount.device) ??
        devices.get(mount.device.split("/").at(-1) ?? "") ??
        null;
      if (!fsid) {
        try {
          const canonical = await realpath(mount.device);
          fsid =
            devices.get(canonical) ??
            devices.get(canonical.split("/").at(-1) ?? "") ??
            null;
        } catch (error) {
          r.error(mount.device, error);
        }
      }
      if (!fsid)
        r.error(
          mount.mount,
          "Cannot match btrfs device to filesystem counters",
        );
      let free: number | null = null;
      let total: number | null = null;
      try {
        const fs = await statfs(mount.mount);
        free = fs.bavail * fs.bsize;
        total = fs.blocks * fs.bsize;
      } catch (e) {
        r.error(mount.mount, e);
      }
      const seen = fsid ? growth.get(fsid) : undefined;
      storage.volumes.push({
        ...mount,
        fsid,
        free,
        total,
        lastErrorAt: seen?.at ?? null,
        lastErrorSize: seen?.size ?? null,
        lastErrorBefore: seen?.before ?? null,
        lastErrorStoredBefore: seen?.storedBefore ?? null,
        lastErrorKnown: memory.available,
        ...((fsid ? counters.get(fsid) : undefined) ?? {
          errors: {},
          delta: {},
          sinceStart: {},
          countersAvailable: false,
        }),
      });
    }
    this.scrubDir = undefined;
    try {
      let entries: Dirent[];
      try {
        entries = await readdir(c.scrubDir, { withFileTypes: true });
        this.scrubDir = null;
      } catch (e) {
        this.scrubDir = classify(e);
        throw e;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !isReportName(entry.name)) continue;
        const path = join(c.scrubDir, entry.name);
        const text = r.exact(path);
        // A report vsys cannot read is not a report that is not there. Losing
        // the row would take its problem card with it and leave the reader
        // with no sign that a check had run at all. `r.text` has already
        // recorded why the read failed.
        if (text === null) {
          storage.scrubs.push({
            path,
            text: "",
            readable: false,
            problem: true,
            fsid: null,
            startedAt: null,
            status: null,
            duration: null,
            uncorrectable: null,
            corrected: null,
            csum: null,
            addresses: null,
          });
          continue;
        }
        const report = parseScrub(text);
        // A path the report named can be gone: the reader removed or rebuilt
        // the file since the check. Only what is still on disk is listed, so
        // the list empties as the reader restores what it held.
        const addresses =
          report.addresses === null
            ? null
            : await Promise.all(
                report.addresses.map(async (address) => ({
                  ...address,
                  paths: await present(address.paths),
                })),
              );
        const found: Omit<Scrub, "problem" | "readable"> = {
          path,
          text,
          fsid: report.uuid,
          startedAt: report.startedAt,
          status: report.status,
          duration: report.duration,
          uncorrectable: report.uncorrectable,
          corrected: report.corrected,
          csum: report.csum,
          addresses,
        };
        try {
          const problem = scrubProblem(text);
          storage.scrubs.push({ ...found, readable: true, problem });
          // The reporter keeps one report per filesystem, so a later scrub
          // that stops early overwrites the very report that proved this one
          // sound, outcome included. Only a finished reading ever moves this
          // memory, and `advance` never moves it backward: a stopped-early
          // report leaves it standing.
          if (
            report.uuid &&
            report.status === "finished" &&
            typeof report.startedAt === "number"
          ) {
            this.finishedScrub.advance(report.uuid.toLowerCase(), {
              at: report.startedAt,
              damaged: scrubFoundDamage({
                addressCount: addresses?.length ?? 0,
                uncorrectable: report.uncorrectable,
                problem,
              }),
              covers: scrubCoverage(report),
            });
          }
        } catch (e) {
          r.error(path, e);
          storage.scrubs.push({ ...found, readable: false, problem: true });
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        r.error(c.scrubDir, e);
    }
    storage.lastFinishedScrub = this.finishedScrub.snapshot();
    if (!skipScratch) {
      const scratch = await this.scratch.collect(
        c,
        agentScratch,
        time,
        waitForScratch,
      );
      storage.scratch = scratch.scratch;
      storage.sessions = scratch.sessions;
      storage.scratchAbsent = scratch.absent;
      storage.scratchTime = scratch.time;
      storage.scratchPending = this.scratch.pending;
      r.errors.push(...scratch.errors);
    } else {
      storage.scratchTime = null;
      storage.scratchPending = false;
    }
    return storage;
  }
}
