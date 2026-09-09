import { createCollector } from "./collect/collector";
import type { SccacheCollector } from "./collect/sccache";
import { type Config, saveConfig, validate } from "./config/config";
import { notify } from "./model/alerts";
import type { Snapshot } from "./model/types";
import type { History } from "./store/history";

interface Source {
  sample(): Promise<Snapshot>;
  close?(): void;
  /** Readings measured since vsys started, handed to the replacement source. */
  sccache?: SccacheCollector;
}
type SourceFactory = (config: Config, previous: Source) => Promise<Source>;
interface Events {
  frame(snapshot: Snapshot, history: History, config: Config): void;
  error(error: unknown): void;
}

/** Collection and setting changes share a scheduler, so sources never overlap. */
export class Session {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private busy = false;
  private applying = false;
  private generation = 0;
  private immediate = false;
  private latest?: Snapshot;
  constructor(
    private config: Config,
    private configPath: string,
    private source: Source,
    private history: History,
    private events: Events,
    private makeSource: SourceFactory = (config, previous) =>
      createCollector(config, true, previous),
  ) {}
  start(): void {
    this.schedule(0);
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    try {
      this.history.close();
    } finally {
      this.source.close?.();
    }
  }
  private schedule(delay: number): void {
    if (this.stopped || this.applying || this.busy) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
  }
  private async tick(): Promise<void> {
    if (this.stopped || this.applying || this.busy) return;
    this.busy = true;
    this.immediate = false;
    const generation = this.generation;
    const started = performance.now();
    try {
      const snapshot = await this.source.sample();
      if (this.stopped || this.applying || generation !== this.generation)
        return;
      try {
        await notify(snapshot.alerts, this.config);
      } catch (error) {
        snapshot.errors.push({ source: "notify-send", message: String(error) });
      }
      if (this.stopped || this.applying || generation !== this.generation)
        return;
      this.history.add(snapshot);
      this.latest = snapshot;
      this.events.frame(snapshot, this.history, this.config);
    } catch (error) {
      if (!this.stopped && generation === this.generation) {
        let failure = error;
        try {
          this.stop();
        } catch (shutdownError) {
          failure = new AggregateError(
            [error, shutdownError],
            "Collection and shutdown failed",
          );
        }
        this.events.error(failure);
      }
    } finally {
      this.busy = false;
      this.schedule(
        this.immediate
          ? 0
          : Math.max(0, this.config.refreshMs - (performance.now() - started)),
      );
    }
  }
  /** Prepare replacements before saving; failure leaves the active state intact. */
  async configure(input: Config): Promise<void> {
    if (this.stopped) throw new Error("Session has stopped");
    if (this.applying) throw new Error("Settings are already being saved");
    const next = validate(input);
    this.applying = true;
    this.generation++;
    clearTimeout(this.timer);
    let nextHistory = this.history;
    let nextSource = this.source;
    try {
      const collectionChanged = [
        "cgroupRoot",
        "procRoot",
        "btrfsRoot",
        "sysBlockRoot",
        "watchedSlices",
        "agentSlice",
        "agentTools",
        "memoryFloor",
        "pressureAmber",
        "pressureRed",
        "pressureHoldSeconds",
        "laneNaming",
        "laneEnv",
        "scratchDirs",
        "scratchQuota",
        "scratchRefreshMs",
        "btrfsMounts",
        "scrubDir",
      ].some(
        (k) =>
          JSON.stringify(this.config[k as keyof Config]) !==
          JSON.stringify(next[k as keyof Config]),
      );
      nextSource = collectionChanged
        ? await this.makeSource(next, this.source)
        : this.source;
      if (this.stopped) return;
      if (
        ["persistence", "sqlitePath", "historyHours", "refreshMs"].some(
          (k) => this.config[k as keyof Config] !== next[k as keyof Config],
        )
      )
        nextHistory = this.history.reconfigure(next);
      await saveConfig(next, this.configPath);
      if (this.stopped) {
        if (nextHistory !== this.history) nextHistory.close();
        return;
      }
      if (nextHistory !== this.history) this.history.close();
      this.history = nextHistory;
      this.history.configure(next);
      const oldSource = this.source;
      this.source = nextSource;
      if (oldSource !== nextSource) oldSource.close?.();
      this.config = next;
      if (this.latest)
        this.events.frame(this.latest, this.history, this.config);
    } catch (error) {
      if (nextHistory !== this.history) nextHistory.close();
      throw error;
    } finally {
      if (nextSource !== this.source) nextSource.close?.();
      this.applying = false;
      this.immediate = true;
      this.schedule(0);
    }
  }
}
