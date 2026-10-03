import { readFile, rm } from "node:fs/promises";
import type { FinishedScrubMemory } from "./collect/btrfs";
import { createCollector } from "./collect/collector";
import type { KernelLog } from "./collect/kernel-log";
import type { SccacheCollector } from "./collect/sccache";
import { collectionKeys } from "./collect/settings";
import {
  type AgentToolNamesSave,
  agentToolsPath as defaultAgentToolsPath,
  prepareAgentToolNamesSave,
  shippedAgentTools,
  writeAgentToolNamesSave,
} from "./config/agent-tools";
import { writeFileAtomic } from "./config/atomic";
import {
  type Config,
  defaults,
  type KeyAction,
  loadConfigState,
  patchConfigBody,
  sameStringSet,
  sameValue,
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
  /** The kernel log and its cursor, handed on the same way. */
  kernelLog?: KernelLog | null;
  /**
   * Each filesystem's last finished scrub, handed on the same way, but
   * shared rather than copied: a replacement reads the same live memory,
   * never a snapshot taken before a sample still in flight on this source
   * finishes updating it.
   */
  lastFinishedScrub?: FinishedScrubMemory;
}
type SourceFactory = (config: Config, previous: Source) => Promise<Source>;
interface SessionOptions {
  makeSource?: SourceFactory;
  agentToolsPath?: string;
  writeConfig?: (path: string, body: string) => Promise<void>;
}
interface Events {
  /**
   * `settingsPath` is resolved by the same call `configure()` makes before a
   * save, and published before that save writes, so the row the reader sees
   * can never name a file other than the one the save in flight targets,
   * even when the reader moves it mid-session.
   */
  frame(
    snapshot: Snapshot,
    history: History,
    config: Config,
    settingsPath: string,
  ): void;
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
  expectedCurrentBody: string,
): Promise<void> {
  const current = await readOptionalFile(path);
  if (current !== expectedCurrentBody)
    throw new Error(
      "Agent-tools rollback skipped because the overlay changed after this save",
    );
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
  private writeConfig: (path: string, body: string) => Promise<void>;
  constructor(
    private config: Config,
    /**
     * Resolved at each save and at each frame, so a save follows a settings
     * file the reader moved; a save publishes its resolved value to the
     * screen before writing, so the displayed path and the write's
     * destination are always the same read, not two calls a move can split.
     */
    private configPath: () => string,
    private source: Source,
    private history: History,
    private events: Events,
    options: SessionOptions = {},
  ) {
    this.makeSource =
      options.makeSource ??
      ((config, previous) =>
        createCollector(config, true, previous, this.agentToolsPath));
    this.agentToolsPath = options.agentToolsPath ?? defaultAgentToolsPath;
    this.writeConfig = options.writeConfig ?? writeFileAtomic;
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
      this.events.frame(snapshot, this.history, this.config, this.configPath());
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
      const path = this.configPath();
      // Published before the write starts, holding the same resolved value
      // the write below uses, so a save that lands the instant the reader
      // clicks it shows the file it is about to write, not the one the last
      // sample displayed.
      if (this.latest)
        this.events.frame(this.latest, this.history, this.config, path);
      const currentState = await loadConfigState(path, this.agentToolsPath);
      const currentBody = (await readOptionalFile(path)) ?? "";
      let agentToolSave: AgentToolNamesSave | null = null;
      if (agentToolsChanged) {
        if (currentState.agentToolsPinned) {
          const pinnedNames = new Set(currentState.config.agentTools);
          const missingShippedNames = shippedAgentTools.tools
            .map((tool) => tool.name)
            .filter((name) => !pinnedNames.has(name));
          if (missingShippedNames.length)
            throw new Error(
              `Pinned agentTools omits shipped agent tools: ${missingShippedNames.join(", ")}. Edit agentTools in config.toml, or remove it there to use the shared list.`,
            );
        }
        const currentAgentTools = [...currentState.config.agentTools];
        const currentAgentToolSet = new Set(currentAgentTools);
        for (const name of currentState.layeredAgentTools) {
          if (!currentAgentToolSet.has(name)) {
            currentAgentTools.push(name);
            currentAgentToolSet.add(name);
          }
        }
        const requested = rebaseAgentToolEdit(
          this.config.agentTools,
          next.agentTools,
          currentAgentTools,
        );
        agentToolSave = await prepareAgentToolNamesSave(
          requested,
          this.agentToolsPath,
        );
        next = { ...next, agentTools: agentToolSave.agentTools };
      } else if (!currentState.agentToolsPinned) {
        next = { ...next, agentTools: currentState.config.agentTools };
      }
      // Only the keys and keybindings this Settings save itself changed get a
      // line touched in config.toml: a key a hand edit changed in the file
      // since the session started, untouched by this save, keeps its line
      // and any comment beside it instead of reverting to what serializing
      // the session's own full config would write.
      const changedKeys = (Object.keys(this.config) as (keyof Config)[]).filter(
        (key) =>
          key !== "agentTools" &&
          key !== "keys" &&
          !sameValue(key, this.config[key], next[key]),
      ) as Exclude<keyof Config, "keys" | "agentTools">[];
      const changedKeyActions = (
        Object.keys(this.config.keys) as KeyAction[]
      ).filter((action) => this.config.keys[action] !== next.keys[action]);
      const base = defaults(
        agentToolSave?.agentTools ?? currentState.layeredAgentTools,
      );
      const configText = patchConfigBody(currentBody, next, base, {
        changedKeys: agentToolsChanged
          ? [...changedKeys, "agentTools"]
          : changedKeys,
        changedKeyActions,
      });
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
      const writtenOverlayBody = agentToolSave?.body ?? null;
      try {
        await this.writeConfig(path, configText);
      } catch (error) {
        if (overlayWritten && writtenOverlayBody !== null) {
          try {
            await restoreOptionalFile(
              this.agentToolsPath,
              previousOverlay,
              writtenOverlayBody,
            );
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              rollbackError instanceof Error &&
                rollbackError.message.includes("rollback skipped")
                ? "Config save failed and agent-tools rollback skipped because the overlay changed after this save"
                : "Config save failed and agent-tools rollback failed",
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
        this.events.frame(this.latest, this.history, this.config, path);
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
