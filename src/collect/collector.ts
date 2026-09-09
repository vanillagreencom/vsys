import { realpathSync } from "node:fs";
import { join } from "node:path";
import { AlertEngine } from "../model/alerts";
import { lanes } from "../model/lanes";
import type { Capability, Snapshot } from "../model/types";
import { StorageCollector } from "./btrfs";
import { probeCapabilities } from "./capabilities";
import { collectDeviceWrites, collectGroups } from "./cgroups";
import { Reader } from "./io";
import { kernelCgroupRoot, readMounts } from "./mounts";
import { ProcessCollector } from "./procs";
import { SccacheCollector } from "./sccache";
import type { CollectionConfig } from "./settings";
import { collectSystem } from "./system";

/** The scheduler awaits each sample, so ticks cannot overlap. */
export class Collector {
  private previous?: Snapshot;
  private storage = new StorageCollector();
  private engine = new AlertEngine();
  private processes: ProcessCollector;
  private controller = new AbortController();
  /** Probed once: a kernel interface does not appear or vanish between ticks. */
  private capabilities: Capability[];
  constructor(
    readonly config: CollectionConfig,
    ticksPerSecond: number,
    pageSize: number,
    private live = false,
    /** Absent unless a caller supplies one, so no test spawns a build cache. */
    readonly sccache?: SccacheCollector,
  ) {
    this.processes = new ProcessCollector(ticksPerSecond, pageSize);
    this.capabilities = probeCapabilities(config);
  }
  close(): void {
    this.controller.abort();
    this.storage.close();
  }
  async sample(
    time = Date.now(),
    measure?: (source: string, durationMs: number) => void,
  ): Promise<Snapshot> {
    this.controller.signal.throwIfAborted();
    const start = performance.now();
    let previousMark = start;
    const mark = (source: string) => {
      if (measure) {
        const now = performance.now();
        measure(source, now - previousMark);
        previousMark = now;
      }
    };
    const r = new Reader();
    const c = this.config;
    const elapsed = this.previous ? time - this.previous.time : 0;
    const mountInfo = readMounts(r, c.procRoot);
    let kernelRoot: string | undefined;
    try {
      kernelRoot = kernelCgroupRoot(
        realpathSync(c.cgroupRoot),
        mountInfo ?? [],
      );
    } catch (error) {
      r.error(c.cgroupRoot, error);
    }
    mark("mounts");
    const system = collectSystem(r, c);
    mark("system");
    const groups = collectGroups(
      r,
      c.cgroupRoot,
      this.previous?.groups ?? [],
      elapsed,
    );
    if (kernelRoot !== undefined)
      for (const group of groups)
        group.kernelPath = join(kernelRoot, group.path);
    mark("cgroups");
    const procs = await this.processes.collect(
      r,
      c,
      groups,
      this.previous?.procs ?? [],
      elapsed,
      system.uptime,
      this.controller.signal,
    );
    mark("processes");
    const storage = await this.storage.collect(
      r,
      c,
      time,
      mountInfo,
      !this.live,
    );
    // Device totals cover the whole machine, so they are read above the watched tree.
    storage.deviceWrites = collectDeviceWrites(r, c.cgroupTop);
    this.controller.signal.throwIfAborted();
    mark("storage");
    const sccache = await this.sccache?.collect(r, time);
    this.controller.signal.throwIfAborted();
    mark("sccache");
    const s: Snapshot = {
      capabilities: this.capabilities,
      time,
      durationMs: performance.now() - start,
      system,
      groups,
      procs,
      storage,
      lanes: lanes(groups, procs, c, system.cores),
      alerts: [],
      errors: r.errors,
      ...(sccache ? { sccache } : {}),
    };
    s.alerts = this.engine.evaluate(s, c);
    mark("model");
    s.durationMs = performance.now() - start;
    this.previous = s;
    return s;
  }
}

/**
 * getconf reads libc's clock and page units; no machine-specific constants.
 * The predecessor's build cache reader is carried over, so its counts stay
 * measured since vsys started rather than since the last settings change.
 */
export async function createCollector(
  c: CollectionConfig,
  live = true,
  previous?: { sccache?: SccacheCollector },
): Promise<Collector> {
  const read = async (name: string) => {
    const child = Bun.spawn(["getconf", name], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const n = Number(out.trim());
    if (code !== 0 || !Number.isInteger(n) || n <= 0)
      throw new Error(`getconf ${name} failed: ${error}`);
    return n;
  };
  const [ticks, pages] = await Promise.all([read("CLK_TCK"), read("PAGESIZE")]);
  const sccache = previous?.sccache ?? new SccacheCollector();
  return new Collector(c, ticks, pages, live, sccache);
}
