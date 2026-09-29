import { readFile, rm } from "node:fs/promises";
import { createCollector } from "./collect/collector";
import type { SccacheCollector } from "./collect/sccache";
import { collectionKeys } from "./collect/settings";
import {
  type AgentToolNamesSave,
  agentToolsPath as defaultAgentToolsPath,
  prepareAgentToolNamesSave,
  writeAgentToolNamesSave,
} from "./config/agent-tools";
import { writeFileAtomic } from "./config/atomic";
import {
  type Config,
  configBody,
  loadConfigState,
  sameStringSet,
  validate,
} from "./config/config";
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
interface SessionOptions {
  makeSource?: SourceFactory;
  agentToolsPath?: string;
}
interface Events {
  frame(snapshot: Snapshot, history: History, config: Config): void;
  error(error: unknown): void;
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function restoreOptionalFile(
  path: string,
  body: string | null,
): Promise<void> {
  if (body === null) {
    await rm(path, { force: true });
    return;
  }
  await writeFileAtomic(path, body);
}

function rebaseAgentToolEdit(
  previous: string[],
  edited: string[],
  current: string[],
): string[] {
  const previousSet = new Set(previous);
  const editedSet = new Set(edited);
  const removed = new Set(previous.filter((name) => !editedSet.has(name)));
  const rebased = current.filter((name) => !removed.has(name));
  const rebasedSet = new Set(rebased);
  for (const name of edited) {
    if (!previousSet.has(name) && !rebasedSet.has(name)) {
      rebased.push(name);
      rebasedSet.add(name);
    }
  }
  return rebased;
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
  private makeSource: SourceFactory;
  private agentToolsPath: string;
  constructor(
    private config: Config,
    private configPath: string,
    private source: Source,
    private history: History,
    private events: Events,
    options: SessionOptions = {},
  ) {
    this.makeSource =
      options.makeSource ??
      ((config, previous) => createCollector(config, true, previous));
    this.agentToolsPath = options.agentToolsPath ?? defaultAgentToolsPath;
  }
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
    let next = validate(input);
    this.applying = true;
    this.generation++;
    clearTimeout(this.timer);
    let nextHistory = this.history;
    let nextSource = this.source;
    try {
      const agentToolsChanged = !sameStringSet(
        this.config.agentTools,
        next.agentTools,
      );
      const currentState = await loadConfigState(
        this.configPath,
        this.agentToolsPath,
      );
      let agentToolSave: AgentToolNamesSave | null = null;
      if (agentToolsChanged) {
        const requested = currentState.agentToolsPinned
          ? next.agentTools
          : rebaseAgentToolEdit(
              this.config.agentTools,
              next.agentTools,
              currentState.config.agentTools,
            );
        agentToolSave = await prepareAgentToolNamesSave(
          requested,
          this.agentToolsPath,
        );
        next = { ...next, agentTools: agentToolSave.agentTools };
      } else if (!currentState.agentToolsPinned) {
        next = { ...next, agentTools: currentState.config.agentTools };
      }
      const configText = configBody(
        next,
        agentToolSave?.agentTools ?? currentState.layeredAgentTools,
      );
      const collectionChanged = collectionKeys.some((k) =>
        k === "agentTools"
          ? !sameStringSet(this.config.agentTools, next.agentTools)
          : JSON.stringify(this.config[k]) !== JSON.stringify(next[k]),
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
      const previousOverlay =
        agentToolSave === null
          ? null
          : await readOptionalFile(this.agentToolsPath);
      let overlayWritten = false;
      if (agentToolSave !== null) {
        await writeAgentToolNamesSave(agentToolSave, this.agentToolsPath);
        overlayWritten = agentToolSave.body !== null;
      }
      try {
        await writeFileAtomic(this.configPath, configText);
      } catch (error) {
        if (overlayWritten) {
          try {
            await restoreOptionalFile(this.agentToolsPath, previousOverlay);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Config save failed and agent-tools rollback failed",
            );
          }
        }
        throw error;
      }
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
