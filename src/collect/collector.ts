import { realpathSync } from "node:fs";
import { join } from "node:path";
import { agentToolsPath, loadAgentTools } from "../config/agent-tools";
import { AlertEngine } from "../model/alerts";
import { lanes } from "../model/lanes";
import type { Capability, Snapshot } from "../model/types";
import { type FinishedScrubMemory, StorageCollector } from "./btrfs";
import {
  type Outcome,
  probeAgentSlice,
  probeCapabilities,
  probeIoStat,
  probeTmux,
  udisksCapabilitySource,
  unitDirs,
} from "./capabilities";
import { collectDeviceWrites, collectGroups } from "./cgroups";
import { Reader } from "./io";
import { KernelLog, probeKernelLog } from "./kernel-log";
import {
  cgroupMount,
  kernelCgroupRoot,
  type MountInfo,
  readMounts,
} from "./mounts";
import { ProcessThread } from "./process-thread";
import {
  ProcessCollector,
  type ProcessReading,
  type ProcessRequest,
  type ProcessSource,
} from "./procs";
import { SccacheCollector } from "./sccache";
import { agentScratchDirs } from "./scratch";
import type { ScrubUnits } from "./scrub-timers";
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

/**
 * How long a sample waits for its processes. One process file whose read
 * blocks in the kernel would otherwise hold every later sample.
 */
const processDeadlineMs = 2000;

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
  /** A process read an earlier sample stopped waiting for, until it settles. */
  private lateRead?: Promise<void>;
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
    /**
     * A predecessor's own `FinishedScrubMemory`, shared rather than copied,
     * so a settings change that replaces this collector while the
     * predecessor's sample is still finishing never reads a stopped-early
     * report as if nothing had ever finished, or ever found damage. Absent
     * unless a caller supplies one, so a collector built fresh starts with no
     * memory.
     */
    sharedFinishedScrub?: FinishedScrubMemory,
    /** Absent unless a caller supplies them, so no test reads systemd's units. */
    scrubUnits?: ScrubUnits,
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
    this.storage = new StorageCollector(
      this.kernelLog,
      udisks ?? null,
      sharedFinishedScrub,
      scrubUnits ?? null,
    );
    const probed = this.capabilities.find((cap) => cap.id === "tmux");
    this.tmuxOnPath = probed !== undefined && probed.failure !== "absent";
    this.tmuxServed = probed?.available === true;
  }
  /**
   * This process's live memory of each filesystem's last finished scrub, to
   * share with a replacement collector built on a settings change: both
   * collectors write through the same object, so a report that finishes on
   * this one after the replacement is built is never lost to a copy taken
   * too early.
   */
  get lastFinishedScrub(): FinishedScrubMemory {
    return this.storage.finishedScrubMemory();
  }
  /**
   * What the last read of a capability asked again each sample says, carried
   * into the next sample: whether a tmux server answers, and whether the
   * scrub and drive report directories exist yet.
   *
   * `source` names what actually decided this sample's outcome, for a
   * capability whose answer can come from somewhere other than the probed
   * path (the `smart` fallback through udisks2). Omitted, the capability
   * keeps the source its last read set.
   */
  private record(
    id: "tmux" | "scrub" | "smart",
    outcome: Outcome,
    source?: string,
  ): void {
    this.capabilities = this.capabilities.map((cap) =>
      cap.id === id
        ? {
            ...cap,
            available: outcome === null,
            failure: outcome?.failure ?? null,
            detail: outcome?.detail ?? "",
            source: source ?? cap.source,
          }
        : cap,
    );
  }
  /**
   * This sample's processes, or none and an unknown reading when the read
   * misses the deadline. Ending a thread cannot interrupt a read blocked in
   * the kernel, and a fresh thread would block on the same file, so a late
   * read is left to finish and no sample asks again until it has. Its answer
   * describes an earlier moment and is dropped.
   */
  private async readProcesses(
    r: Reader,
    request: ProcessRequest,
  ): Promise<ProcessReading> {
    const unknown: ProcessReading = {
      procs: [],
      errors: [],
      processRead: "unknown",
    };
    if (this.lateRead) {
      r.error(
        this.config.procRoot,
        "the process read an earlier sample started has not finished",
      );
      return unknown;
    }
    const read = this.processes.collect(request, this.controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), processDeadlineMs);
    });
    try {
      const reading = await Promise.race([read, late]);
      if (reading) return reading;
    } finally {
      clearTimeout(timer);
    }
    const forget = () => {
      this.lateRead = undefined;
    };
    this.lateRead = read.then(forget, forget);
    r.error(
      this.config.procRoot,
      `the process read did not finish within ${processDeadlineMs} ms`,
    );
    return unknown;
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
    let mounted: { path: string; mount: MountInfo } | undefined;
    try {
      const path = realpathSync(c.cgroupRoot);
      kernelRoot = kernelCgroupRoot(path, mountInfo ?? []);
      const mount = cgroupMount(path, mountInfo ?? []);
      if (mount) mounted = { path, mount };
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
      mounted,
    );
    if (kernelRoot !== undefined)
      for (const group of groups)
        group.kernelPath = join(kernelRoot, group.path);
    mark("cgroups");
    const processes = await this.readProcesses(r, {
      time,
      uptime: system.uptime,
      groups: groups.map((g) => ({ pids: g.pids, kernelPath: g.kernelPath })),
    });
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
      () => time + (performance.now() - start),
    );
    // The scrub capability comes from the same asynchronous listing the
    // reports were read from, so the two never disagree within a sample. A
    // collection that never listed the directory leaves the last answer.
    if (this.storage.scrubDir !== undefined)
      this.record("scrub", this.storage.scrubDir);
    if (this.storage.smartDir !== undefined) {
      // No report directory is not the same as no lifetime writes: udisks2
      // can still answer for a drive with none, and Storage's own row already
      // takes that reading (`collectDevices`). A device udisks actually
      // supplied a number for must stand the capability up with it, or
      // Settings tells the reader Storage has nothing when it does not.
      const udisksSupplies =
        storage.devices?.some((d) => d.source === "udisks") ?? false;
      // The capability's source names whichever read actually answered this
      // sample, not the probed directory: a machine with no report
      // directory still names it once the fallback stops supplying.
      this.record(
        "smart",
        udisksSupplies ? null : this.storage.smartDir,
        udisksSupplies ? udisksCapabilitySource : c.smartDir,
      );
    }
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
      processRead: processes.processRead,
      storage,
      lanes: lanes(
        groups,
        procs,
        c,
        system.cores,
        panes,
        capabilities,
        processes.processRead,
      ),
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
 * cursor rather than searching every boot again. Its memory of each
 * filesystem's last finished scrub is shared, not copied, so a sample still
 * finishing on the predecessor when this runs still lands in the same
 * memory the replacement reads, and a settings change never reads a
 * stopped-early report as if nothing had ever finished, or ever found
 * damage. The agent-tool install locations and desktop paths come from the
 * shared agent-tool data and its overlay, read again for every collector
 * built.
 */
export async function createCollector(
  c: CollectionConfig,
  live = true,
  previous?: {
    sccache?: SccacheCollector;
    kernelLog?: KernelLog | null;
    lastFinishedScrub?: FinishedScrubMemory;
  },
  toolsPath = agentToolsPath,
  /** Injected so no test reads this machine's journal. */
  kernelLogProbe: () => Outcome = probeKernelLog,
  /**
   * Absent unless the program supplies them, so no test reads this machine's
   * systemd units: the program passes `packagedScrubUnits`.
   */
  scrubUnits?: ScrubUnits,
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
    previous?.lastFinishedScrub,
    scrubUnits,
  );
}
