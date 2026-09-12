import { readdir, realpath, stat, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Scrub, Storage, Volume } from "../model/types";
import { collectDevices } from "./devices";
import { ErrorMemory } from "./errors";
import { pairs, type Reader } from "./io";
import { type MountInfo, readMounts } from "./mounts";
import { ScratchCollector } from "./scratch";
import { counted, parseScrub, stated } from "./scrub";
import type { CollectionConfig } from "./settings";

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
  if (/\b(aborted|canceled|cancelled|failed)\b/i.test(raw)) return true;
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
 * The paths of a damaged address that are still on disk, and which of them no
 * longer name what the check read.
 *
 * A path vsys cannot stat is kept: an unreadable directory is not proof the
 * file is gone, and dropping it would tell the reader to delete less than the
 * address holds. A path written since the check began is kept too, because
 * dropping it would hide damage, but it is named as changed: the block it sat
 * in can have been freed and reused, so the file under that name now may be a
 * healthy one a delete command would destroy.
 */
async function present(
  paths: string[],
  startedAt: number | null,
): Promise<{ paths: string[]; changed: string[] }> {
  const kept = await Promise.all(
    paths.map(async (path) => {
      try {
        const stats = await stat(path);
        return {
          path,
          // Without a check time nothing can be compared against it, so no
          // path is called unchanged.
          changed: startedAt === null || stats.mtimeMs >= startedAt,
        };
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ENOENT"
          ? null
          : { path, changed: true };
      }
    }),
  );
  const found = kept.filter((entry) => entry !== null);
  return {
    paths: found.map((entry) => entry.path),
    changed: found.filter((entry) => entry.changed).map((entry) => entry.path),
  };
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

/** Counter baselines belong to a filesystem/device, not a mount alias. */
export class StorageCollector {
  private initial = new Map<string, number>();
  private last = new Map<string, number>();
  private scratch = new ScratchCollector();
  private memory: ErrorMemory | null = null;
  private memoryPath = "";
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
  ): Promise<Storage> {
    const storage: Storage = {
      mountsAvailable: mountInfo !== null,
      devices: collectDevices(r, c),
      volumes: [],
      scratch: [],
      sessions: [],
      scrubs: [],
    };
    const devices = new Map<string, string>();
    const memory = this.errorMemory(r, c.errorMemoryPath);
    const growth = new Map<
      string,
      { at: number | null; size: number | null }
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
        lastErrorKnown: memory.available,
        ...((fsid ? counters.get(fsid) : undefined) ?? {
          errors: {},
          delta: {},
          sinceStart: {},
          countersAvailable: false,
        }),
      });
    }
    try {
      for (const entry of await readdir(c.scrubDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(c.scrubDir, entry.name);
        const text = r.text(path);
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
            uncorrectable: null,
            corrected: null,
            addresses: null,
          });
          continue;
        }
        const report = parseScrub(text);
        // A path the report named can be gone: the reader deleted the file
        // this screen told them to delete. Only what is still on disk is
        // listed, so the list empties as the work is done.
        const addresses =
          report.addresses === null
            ? null
            : await Promise.all(
                report.addresses.map(async (address) => ({
                  logical: address.logical,
                  ...(await present(address.paths, report.startedAt)),
                })),
              );
        const found: Omit<Scrub, "problem" | "readable"> = {
          path,
          text,
          fsid: report.uuid,
          startedAt: report.startedAt,
          status: report.status,
          uncorrectable: report.uncorrectable,
          corrected: report.corrected,
          addresses,
        };
        try {
          storage.scrubs.push({
            ...found,
            readable: true,
            problem: scrubProblem(text),
          });
        } catch (e) {
          r.error(path, e);
          storage.scrubs.push({ ...found, readable: false, problem: true });
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        r.error(c.scrubDir, e);
    }
    const scratch = await this.scratch.collect(c, time, waitForScratch);
    storage.scratch = scratch.scratch;
    storage.sessions = scratch.sessions;
    storage.scratchTime = scratch.time;
    storage.scratchPending = this.scratch.pending;
    r.errors.push(...scratch.errors);
    return storage;
  }
}
