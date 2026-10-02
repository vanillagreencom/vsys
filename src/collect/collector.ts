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
  probeIoStat,
  probeTmux,
  unitDirs,
} from "./capabilities";
import { collectDeviceWrites, collectGroups } from "./cgroups";
import { Reader } from "./io";
import { KernelLog, probeKernelLog } from "./kernel-log";
import { kernelCgroupRoot, readMounts } from "./mounts";
import { ProcessThread } from "./process-thread";
import { ProcessCollector, type ProcessSource } from "./procs";
import { SccacheCollector } from "./sccache";
import { agentScratchDirs } from "./scratch";
import type { CollectionConfig } from "./settings";
import { collectSystem } from "./system";
import { ownPaneSet, type PaneSet, readPanes } from "./tmux";
import { Udisks } from "./udisks";

export interface SampleOptions {
  /** Skip scratch collection for cheap consumers that must treat it as unknown. */
  skipScratch?: boolean;
  /**
   * Skip the kernel log for the same consumers. A collector's first search
   * reads every boot the journal holds, which a one-shot run pays in full.
   */
  skipKernelLog?: boolean;
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
/**
 * Searching the kernel log: the probe that decides the capability, and the
 * log each sample searches from the cursor the last search ended on. A
 * collector given none reads no journal, which keeps the machine's own log
 * out of the test suite; the program always supplies one.
 */
export interface KernelLogReader {
  probe: () => Outcome;
  log: KernelLog;
}
const noKernelLog: Outcome = {
  failure: "absent",
  detail: "this collector was given no kernel log reader",
};

/** The scheduler awaits each sample, so ticks cannot overlap. */
export class Collector {
  private previous?: Snapshot;
  private storage: StorageCollector;
  /**
   * The kernel log this collector searches, null where it cannot. It is
   * handed to a replacement collector, so a settings change resumes from its
   * cursor rather than searching every boot again.
   */
  readonly kernelLog: KernelLog | null;
  private engine = new AlertEngine();
  private processes: ProcessSource;
  private controller = new AbortController();
  /**
   * Probed once: a kernel interface does not appear or vanish between ticks.
   * The agent slice is not one of these and is read with each sample's groups.
   * tmux is the exception, and only half of it. Whether tmux is on the path is
   * as static as the rest; whether a server answers is not, and this program
   * is a dashboard for agents that start after it. The scrub report directory
   * is the other: the reader creates it by installing the reporter vsys
   * offers, so each sample takes it from the storage read of the reports. The
   * drive report directory is taken the same way, for the same reason.
   * io-stat is probed once for the root's own delegation, but `probeIoStat`
   * refines it with each sample's groups, because a slice between the root
   * and the agent scopes can form, or withhold io, after vsys starts.
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
    /** Absent unless a caller supplies one, so no test reads the journal. */
    kernelLog?: KernelLogReader,
    /** Absent unless a caller supplies one, so no test asks the system bus. */
    udisks?: Udisks,
  ) {
    this.processes =
      processes ?? new ProcessCollector(config, ticksPerSecond, pageSize);
    this.capabilities = probeCapabilities(
      config,
      tmux?.probe ?? (() => noTmux),
      kernelLog?.probe ?? (() => noKernelLog),
    );
    // A log this user cannot search is a capability with its reason, probed
    // once. Searching it anyway would add the same source error every sample.
    const searchable =
      this.capabilities.find((cap) => cap.id === "kernel-log")?.available ===
      true;
    this.kernelLog = kernelLog && searchable ? kernelLog.log : null;
    this.storage = new StorageCollector(this.kernelLog, udisks ?? null);
    const probed = this.capabilities.find((cap) => cap.id === "tmux");
    this.tmuxOnPath = probed !== undefined && probed.failure !== "absent";
    this.tmuxServed = probed?.available === true;
  }
  /**
   * What the last read of a capability asked again each sample says, carried
   * into the next sample: whether a tmux server answers, and whether the
   * scrub and drive report directories exist yet.
   */
  private record(id: "tmux" | "scrub" | "smart", outcome: Outcome): void {
    this.capabilities = this.capabilities.map((cap) =>
      cap.id === id
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
      options.skipKernelLog ?? false,
    );
    // The scrub capability comes from the same asynchronous listing the
    // reports were read from, so the two never disagree within a sample. A
    // collection that never listed the directory leaves the last answer.
    if (this.storage.scrubDir !== undefined)
      this.record("scrub", this.storage.scrubDir);
    if (this.storage.smartDir !== undefined)
      this.record("smart", this.storage.smartDir);
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
        this.record("tmux", null);
        this.tmuxServed = true;
      } catch (error) {
        // A server that never answered is a capability with a reason, which
        // Settings shows. Reporting it as an unreadable source instead would
        // put `1 sources unreadable` on the status line for the whole life of
        // a machine that has tmux installed and simply is not running it.
        // Losing a server that was answering is the thing worth a line.
        if (this.tmuxServed) r.error("tmux list-panes", error);
        this.tmuxServed = false;
        this.record("tmux", {
          failure: "incomplete",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    mark("tmux");
    const capabilities = [
      ...this.capabilities.map((cap) =>
        cap.id === "io-stat" ? probeIoStat(c, groups, cap) : cap,
      ),
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
 * measured since vsys started rather than since the last settings change, and
 * so is the kernel log it was searching, so the replacement resumes from that
 * cursor rather than searching every boot again.
 * The agent-tool install locations and desktop paths come from the shared
 * agent-tool data and its overlay, read again for every collector built.
 */
export async function createCollector(
  c: CollectionConfig,
  live = true,
  previous?: { sccache?: SccacheCollector; kernelLog?: KernelLog | null },
  toolsPath = agentToolsPath,
  /** Injected so no test reads this machine's journal. */
  kernelLogProbe: () => Outcome = probeKernelLog,
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
    new ProcessThread(c, ticks, pages, tools),
    unitDirs(),
    {
      probe: kernelLogProbe,
      log: previous?.kernelLog ?? new KernelLog(),
    },
    new Udisks(),
  );
}
