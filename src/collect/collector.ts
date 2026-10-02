import { realpathSync } from "node:fs";
import { join } from "node:path";
import { agentToolsPath, loadAgentTools } from "../config/agent-tools";
import { AlertEngine } from "../model/alerts";
import { lanes } from "../model/lanes";
import type { Capability, Snapshot } from "../model/types";
import { StorageCollector } from "./btrfs";
import {
  type Outcome,
  probeAgentSlice,
  probeCapabilities,
  probeTmux,
  unitDirs,
} from "./capabilities";
import { collectDeviceWrites, collectGroups } from "./cgroups";
import { Reader } from "./io";
import { kernelCgroupRoot, readMounts } from "./mounts";
import { ProcessThread } from "./process-thread";
import { ProcessCollector, type ProcessSource } from "./procs";
import { SccacheCollector } from "./sccache";
import { agentScratchDirs } from "./scratch";
import type { CollectionConfig } from "./settings";
import { collectSystem } from "./system";
import { ownPaneSet, type PaneSet, readPanes } from "./tmux";

export interface SampleOptions {
  /** Skip scratch collection for cheap consumers that must treat it as unknown. */
  skipScratch?: boolean;
}
/**
 * Reading the tmux server: the probe that decides the capability, and the one
 * call per sample that resolves every lane's pane. A collector given none
 * reads no tmux at all, which is what keeps tmux out of the test suite; the
 * program always supplies one.
 */
export interface TmuxReader {
  probe: () => Outcome;
  panes: () => Promise<PaneSet>;
}
const noTmux: Outcome = {
  failure: "absent",
  detail: "this collector was given no tmux reader",
};

/** The scheduler awaits each sample, so ticks cannot overlap. */
export class Collector {
  private previous?: Snapshot;
  private storage = new StorageCollector();
  private engine = new AlertEngine();
  private processes: ProcessSource;
  private controller = new AbortController();
  /**
   * Probed once: a kernel interface does not appear or vanish between ticks.
   * The agent slice is not one of these and is read with each sample's groups.
   * tmux is the exception, and only half of it. Whether tmux is on the path is
   * as static as the rest; whether a server answers is not, and this program
   * is a dashboard for agents that start after it.
   */
  private capabilities: Capability[];
  /** tmux is installed, so a read is worth attempting however it went last. */
  private tmuxOnPath: boolean;
  /** A server answered the last time vsys asked, the startup probe included. */
  private tmuxServed: boolean;
  constructor(
    readonly config: CollectionConfig,
    ticksPerSecond: number,
    pageSize: number,
    private live = false,
    /** Absent unless a caller supplies one, so no test spawns a build cache. */
    readonly sccache?: SccacheCollector,
    /** Absent unless a caller supplies one, so no test spawns tmux. */
    private tmux?: TmuxReader,
    /**
     * The program reads processes on a thread of its own; a collector given
     * none reads them in its caller's thread, with the same code.
     */
    processes?: ProcessSource,
    /**
     * Where the agent slice's unit file is looked for. Empty unless a caller
     * supplies them, so no test reads the host's systemd configuration.
     */
    private units: string[] = [],
  ) {
    this.processes =
      processes ?? new ProcessCollector(config, ticksPerSecond, pageSize);
    this.capabilities = probeCapabilities(
      config,
      tmux?.probe ?? (() => noTmux),
    );
    const probed = this.capabilities.find((cap) => cap.id === "tmux");
    this.tmuxOnPath = probed !== undefined && probed.failure !== "absent";
    this.tmuxServed = probed?.available === true;
  }
  /** What the last read says about the server, carried into the next sample. */
  private recordTmux(outcome: Outcome): void {
    this.capabilities = this.capabilities.map((cap) =>
      cap.id === "tmux"
        ? {
            ...cap,
            available: outcome === null,
            failure: outcome?.failure ?? null,
            detail: outcome?.detail ?? "",
          }
        : cap,
    );
  }
  close(): void {
    this.controller.abort();
    this.processes.close();
    this.storage.close();
  }
  async sample(
    time = Date.now(),
    measure?: (source: string, durationMs: number) => void,
    options: SampleOptions = {},
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
    const processes = await this.processes.collect(
      {
        time,
        uptime: system.uptime,
        groups: groups.map((g) => ({ pids: g.pids, kernelPath: g.kernelPath })),
      },
      this.controller.signal,
    );
    const procs = processes.procs;
    r.errors.push(...processes.errors);
    mark("processes");
    const storage = await this.storage.collect(
      r,
      c,
      time,
      mountInfo,
      !this.live,
      options.skipScratch ?? false,
      agentScratchDirs(procs),
    );
    // Device totals cover the whole machine, so they are read above the watched tree.
    storage.deviceWrites = collectDeviceWrites(r, c.cgroupTop);
    this.controller.signal.throwIfAborted();
    mark("storage");
    const sccache = await this.sccache?.collect(r, time);
    this.controller.signal.throwIfAborted();
    mark("sccache");
    // One read for the whole server, however many lanes ask for an address.
    // A server that stops answering mid-run leaves the addresses empty rather
    // than failing the sample: a pane address is a convenience, not a reading.
    //
    // The read is attempted whenever tmux is installed, not only when a server
    // answered at startup. Gating on the startup probe froze a machine that
    // had no server yet into never having one, which is the ordinary order for
    // a dashboard whose agents start after it. The read is its own probe:
    // measured on this machine, a refused `list-panes` costs 1.06 ms at the
    // median against 1.26 ms for one that answers, so asking is cheaper than
    // asking twice.
    //
    // The pane vsys draws in is in vsys's own environment, not in the
    // server's answer, so it stands whether or not one came: a sample that
    // lost the addresses must not lose the one lane the Terminal section may
    // never capture, which is vsys's own screen.
    let panes = ownPaneSet();
    if (this.tmux && this.tmuxOnPath)
      try {
        panes = await this.tmux.panes();
        this.recordTmux(null);
        this.tmuxServed = true;
      } catch (error) {
        // A server that never answered is a capability with a reason, which
        // Settings shows. Reporting it as an unreadable source instead would
        // put `1 sources unreadable` on the status line for the whole life of
        // a machine that has tmux installed and simply is not running it.
        // Losing a server that was answering is the thing worth a line.
        if (this.tmuxServed) r.error("tmux list-panes", error);
        this.tmuxServed = false;
        this.recordTmux({
          failure: "incomplete",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    mark("tmux");
    const capabilities = [
      ...this.capabilities,
      probeAgentSlice(c, groups, this.units),
    ];
    const s: Snapshot = {
      capabilities,
      time,
      durationMs: performance.now() - start,
      system,
      groups,
      procs,
      storage,
      lanes: lanes(groups, procs, c, system.cores, panes, capabilities),
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
 * The desktop paths come from the shared agent-tool data and its overlay,
 * read again for every collector built.
 */
export async function createCollector(
  c: CollectionConfig,
  live = true,
  previous?: { sccache?: SccacheCollector },
  toolsPath = agentToolsPath,
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
  const [ticks, pages, tools] = await Promise.all([
    read("CLK_TCK"),
    read("PAGESIZE"),
    loadAgentTools(toolsPath),
  ]);
  const { desktopExePrefixes, bundledCliSuffixes } = tools;
  const sccache = previous?.sccache ?? new SccacheCollector();
  // The program reads the real tmux server; a collector built any other way
  // reads none, which is what keeps tmux out of the test suite.
  return new Collector(
    c,
    ticks,
    pages,
    live,
    sccache,
    { probe: probeTmux, panes: readPanes },
    new ProcessThread(c, ticks, pages, {
      desktopExePrefixes,
      bundledCliSuffixes,
    }),
    unitDirs(),
  );
}
