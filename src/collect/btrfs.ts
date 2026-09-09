import { readdir, realpath, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "../config/config";
import type { Storage, Volume } from "../model/types";
import { collectDevices } from "./devices";
import { pairs, type Reader } from "./io";
import { type MountInfo, readMounts } from "./mounts";
import { ScratchCollector } from "./scratch";

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
  if (/\buncorrectable\b/i.test(raw) && !/Uncorrectable:\s+0\b/i.test(raw))
    return true;
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

/** Counter baselines belong to a filesystem/device, not a mount alias. */
export class StorageCollector {
  private initial = new Map<string, number>();
  private last = new Map<string, number>();
  private scratch = new ScratchCollector();
  close(): void {
    this.scratch.close();
  }
  async collect(
    r: Reader,
    c: Config,
    time: number,
    mountInfo: MountInfo[] | null = readMounts(r, c.procRoot),
    waitForScratch = true,
  ): Promise<Storage> {
    const { devices: blockDevices, smartAvailable } = collectDevices(r, c);
    const storage: Storage = {
      mountsAvailable: mountInfo !== null,
      smartAvailable,
      devices: blockDevices,
      volumes: [],
      scratch: [],
      sessions: [],
      scrubs: [],
    };
    const devices = new Map<string, string>();
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
      storage.volumes.push({
        ...mount,
        fsid,
        free,
        total,
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
        if (text === null) continue;
        try {
          storage.scrubs.push({ path, text, problem: scrubProblem(text) });
        } catch (e) {
          r.error(path, e);
          storage.scrubs.push({ path, text, problem: true });
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
