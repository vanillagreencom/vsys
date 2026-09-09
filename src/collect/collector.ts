import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/config";
import { AlertEngine } from "../model/alerts";
import { lanes } from "../model/lanes";
import type { Snapshot } from "../model/types";
import { StorageCollector } from "./btrfs";
import { collectGroups } from "./cgroups";
import { Reader } from "./io";
import { kernelCgroupRoot, readMounts } from "./mounts";
import { ProcessCollector } from "./procs";
import { collectSystem } from "./system";

/** The scheduler awaits each sample, so ticks cannot overlap. */
export class Collector {
  private previous?: Snapshot;
  private storage = new StorageCollector();
  private engine = new AlertEngine();
  private processes: ProcessCollector;
  private controller = new AbortController();
  constructor(
    readonly config: Config,
    ticksPerSecond: number,
    pageSize: number,
    private live = false,
  ) {
    this.processes = new ProcessCollector(ticksPerSecond, pageSize);
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
    this.controller.signal.throwIfAborted();
    mark("storage");
    const s: Snapshot = {
      time,
      durationMs: performance.now() - start,
      system,
      groups,
      procs,
      storage,
      lanes: lanes(groups, procs, c),
      alerts: [],
      errors: r.errors,
    };
    s.alerts = this.engine.evaluate(s, c);
    mark("model");
    s.durationMs = performance.now() - start;
    this.previous = s;
    return s;
  }
}

/** getconf reads libc's clock and page units; no machine-specific constants. */
export async function createCollector(
  c: Config,
  live = true,
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
  return new Collector(c, ticks, pages, live);
}
