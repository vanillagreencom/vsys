import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Config } from "../config/config";
import { keyName } from "../config/keys";
import {
  type LaneCommand,
  type LaneIntent,
  type LaneResolution,
  resolveIntent,
} from "../model/actions";
import type { Snapshot } from "../model/types";
import type { Level } from "../model/verdict";
import type { History } from "../store/history";
import { Agents } from "./agents";
import { attention, type Target, verdictItem } from "./attention";
import { Builds } from "./builds-screen";
import {
  Confirm,
  Footer,
  Header,
  Help,
  keyLabel,
  tabsFitOneRow,
  type View,
  viewKey,
  views,
} from "./chrome";
import { type Output, osc52 } from "./clipboard";
import { Home, homeTarget, recentChanges } from "./home";
import { type KeyHandler, KeyProvider } from "./keys";
import { Resources } from "./resources";
import { Settings } from "./settings-screen";
import { Storage } from "./storage-screen";
import { levelColor, ui } from "./theme";
import { Timeline, windows } from "./timeline-screen";
import { Line, Toast } from "./widgets";

/** A slow initial source cannot leave the terminal without a quit handler. */
export function Waiting({
  quitKey,
  onQuit,
}: {
  quitKey: string;
  onQuit: () => void;
}) {
  useKeyboard((key) => {
    const name = keyName(key);
    if (name === quitKey || name === "ctrl+c") onQuit();
  });
  return (
    <box flexDirection="column" padding={1}>
      <Line attributes={ui.bold}>vsys</Line>
      <Line attributes={ui.dim}>Reading system data</Line>
      <Line attributes={ui.dim}>{`${quitKey} or ctrl+c quits`}</Line>
    </box>
  );
}
/** How long a notice stays on screen. */
const toastMs = 6000;
export interface AppProps {
  snapshot: Snapshot;
  history: History;
  config: Config;
  onSave: (c: Config) => Promise<void>;
  onQuit: () => void;
  onExport: (s: Snapshot, format: "json" | "markdown") => Promise<string>;
  /** Runs one confirmed action. The shell reaches it only in write mode. */
  onAction: (command: LaneCommand) => Promise<void>;
  /**
   * Reads what an agent's tmux pane last drew, and moves the reader's own view
   * to it. Both read or move a view rather than touching a process, so neither
   * waits on write mode. `onSwitch` is absent when vsys runs outside the tmux
   * server holding the pane, and then the row hands over the command instead.
   */
  onCapture?: (paneId: string) => Promise<string[]>;
  onSwitch?: (paneId: string) => Promise<void>;
  /** Where the clipboard escape goes: the process output stream. */
  output: Output;
}
/** The views that show a past sample while one is pinned. */
const pinnable: View[] = ["Agents", "Resources", "Builds", "Storage"];
/** Why the line a reader confirmed is not the line the machine would run. */
const stale: Record<
  Exclude<LaneResolution["state"], "ready">,
  (intent: LaneIntent) => string
> = {
  ended: (i) => `${i.scope} ended while the confirmation was open`,
  replaced: (i) => `Another process holds ${i.scope} now`,
  unaddressable: (i) => `${i.scope} is no longer a scope vsys can address`,
  changed: (i) => `${i.scope} no longer runs the line you confirmed`,
};
/**
 * The keys each screen handles, so a footer never names one the screen
 * ignores. The agent detail is its own entry because it takes none of the
 * list's keys and adds a way back.
 */
/**
 * What each screen's footer offers. A screen names only keys it acts on,
 * which `App.test.tsx` holds it to by pressing every one of them.
 */
export const hints: Record<
  View | "Agent" | "AgentGone",
  (c: Config) => [string, string][]
> = {
  Home: (c) => [
    ["↑↓", "select"],
    ["←→", "tiles"],
    [c.keys.open, "open"],
    [c.keys.copy, "copy"],
  ],
  Agents: (c) => [
    ["↑↓", "select"],
    [c.keys.open, "open"],
    [c.keys.search, "find"],
    [c.keys.details, "table"],
  ],
  Agent: (c) => [
    ["↑↓", "select"],
    [c.keys.open, "open"],
    [c.keys.copy, "copy"],
    [c.keys.back, "back"],
  ],
  /**
   * The agent that was open has left the sample. That screen is one sentence
   * saying so, and it acts on Back and nothing else, so Back is all the
   * footer offers.
   */
  AgentGone: (c) => [[c.keys.back, "back"]],
  Resources: (c) => [
    ["↑↓", "select"],
    [c.keys.details, "all groups"],
  ],
  Builds: (c) => [
    ["↑↓", "select"],
    [c.keys.open, "processes"],
  ],
  // A Storage row shows its detail under the selection, so moving the
  // selection is the whole of what the reader does here and Enter has nothing
  // to act on. A hint for it would be a promise the screen cannot keep.
  Storage: () => [["↑↓", "select"]],
  Timeline: (c) => [
    ["←→", "time"],
    [c.keys.window, "window"],
    [c.keys.pin, "pin"],
  ],
  Settings: (c) => [
    ["↑↓", "select"],
    [c.keys.open, "edit"],
    [c.keys.search, "find"],
  ],
};

/** The shell: one keyboard subscription, the tabs, and the current screen. */
export function App({
  snapshot,
  history,
  config: c,
  onSave,
  onQuit,
  onExport,
  onAction,
  onCapture,
  onSwitch,
  output,
}: AppProps) {
  const renderer = useRenderer();
  const [view, setView] = useState<View>("Home");
  /**
   * The Home row the reader chose, and the item that row named. Home's rows
   * prepend, so a row number alone names a different item one sample later.
   * It is held here rather than in the screen because it outlives the screen:
   * leaving Home and returning must land where the reader was.
   */
  const [homeSelection, setHomeSelection] = useState<{
    index: number;
    id: string | null;
  }>({ index: 0, id: null });
  const [laneId, setLaneId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [pinned, setPinned] = useState<Snapshot | null>(null);
  const [windowIndex, setWindowIndex] = useState(0);
  const [help, setHelp] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [confirming, setConfirming] = useState<LaneIntent | null>(null);
  const [toast, setToast] = useState<{ text: string; level: Level } | null>(
    null,
  );
  const handlers = useRef(new Set<KeyHandler>()).current;
  const { width, height } = useTerminalDimensions();
  const shown = pinned ?? snapshot;
  const issues = attention(snapshot, c);
  const points = history.window(snapshot.time, windows[windowIndex]);
  const notice = useCallback(
    (text: string, level: Level = "ok") => setToast({ text, level }),
    [],
  );
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toastMs);
    return () => clearTimeout(timer);
  }, [toast]);
  // A serious cause that was not there a sample ago is announced once, on
  // screen and to the terminal, whichever view is open.
  // Alerts opened since the dashboard started, so a reader returning to it
  // sees how much happened while they were away.
  const [opened, setOpened] = useState(0);
  const counted = useRef<number | null>(null);
  useEffect(() => {
    // Only what arrived since the last sample. Reading the whole retained
    // window and filtering it meant scanning every point vsys holds, on every
    // sample, to count the handful that were new.
    const since = counted.current;
    counted.current = snapshot.time;
    if (since === null) return;
    const fresh = history
      .eventsAfter(since, snapshot.time)
      .filter((event) => event.kind === "alert-open").length;
    if (fresh) setOpened((n) => n + fresh);
  }, [history, snapshot.time]);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(issues.map((item) => item.id));
    const previous = seen.current;
    seen.current = ids;
    if (!previous) return;
    const fresh = issues.find((item) => item.danger && !previous.has(item.id));
    if (fresh) {
      setToast({ text: fresh.headline, level: "danger" });
      renderer.triggerNotification(fresh.headline, "vsys");
    }
  }, [issues, renderer]);
  const report = (error: unknown) =>
    notice(error instanceof Error ? error.message : String(error), "danger");
  const navigate = (next: View) => {
    setView(next);
    setHelp(false);
  };
  const openLane = (id: string) => {
    setPinned(null);
    setLaneId(id);
    setView("Agents");
  };
  /**
   * A card names one row; opening it lands on that row. The destination clears
   * the target as it takes it, so opening the same card twice lands twice.
   */
  const openCard = (view: View | "Timeline", at: Target | undefined) => {
    if (at?.kind === "lane") {
      openLane(at.id);
      return;
    }
    setPinned(null);
    // A card naming no lane points at the list. An agent left open earlier
    // would render its own detail instead, so the card would land on a screen
    // it never named.
    if (view === "Agents") setLaneId(null);
    setTarget(at ?? null);
    navigate(view);
  };
  const clearTarget = useCallback(() => setTarget(null), []);
  const copy = (command: string | undefined) => {
    if (command === undefined) {
      notice("This row has no command to copy", "warn");
      return;
    }
    output.write(osc52(command));
    // OSC 52 is a request to the terminal, not a write vsys can confirm, so
    // the notice says where the text was sent and what silence means.
    notice(
      "Copied to the clipboard through the terminal. A terminal ignoring OSC 52 leaves the clipboard unchanged; the command stays on screen.",
    );
  };
  // vsys reads system state unless the reader turns write mode on, and an
  // action always addresses the live machine. Both refusals sit above the one
  // call that reaches an effect, so no screen arrives at it by another route,
  // and the confirmation stands between it and the effect.
  const act = (intent: LaneIntent) => {
    if (pinned) {
      notice(
        `Pinned sample · ${intent.scope} may be gone or its name reused · ${keyLabel(c.keys.pin)} shows live data`,
        "warn",
      );
      return;
    }
    if (!c.writeMode) {
      notice(
        `Write mode is off · ${keyLabel(c.keys.copy)} copies the command to run yourself`,
        "warn",
      );
      return;
    }
    setConfirming(intent);
  };
  useKeyboard((key) => {
    const name = keyName(key);
    if (name === "ctrl+c") {
      onQuit();
      return;
    }
    if (confirming) {
      const intent = confirming;
      setConfirming(null);
      // The dialog stood open across every sample since it opened. What runs
      // is re-derived from the current one, so the reader's confirmed line is
      // the line that runs or nothing is.
      if (name === c.keys.open) {
        const resolved = resolveIntent(intent, snapshot, c);
        if (resolved.state !== "ready") {
          notice(`${stale[resolved.state](intent)} · nothing ran`, "warn");
          return;
        }
        void onAction(resolved.command)
          .then(() => notice(`${intent.action} ${intent.scope}: done`))
          .catch(report);
      }
      return;
    }
    if (help) {
      setHelp(false);
      return;
    }
    for (const handler of handlers) if (handler(name, key)) return;
    if (name === c.keys.quit) {
      onQuit();
      return;
    }
    for (const v of views)
      if (name === c.keys[viewKey(v)]) {
        navigate(v);
        return;
      }
    const at = views.indexOf(view);
    if (name === c.keys.next) navigate(views[(at + 1) % views.length]);
    if (name === c.keys.previous)
      navigate(views[(at + views.length - 1) % views.length]);
    if (name === c.keys.help) setHelp(true);
    if (name === c.keys.window) setWindowIndex((i) => (i + 1) % windows.length);
    if (name === c.keys.exportJson || name === c.keys.exportMarkdown)
      void onExport(shown, name === c.keys.exportJson ? "json" : "markdown")
        .then((path) => notice(`Export saved: ${path}`))
        .catch(report);
    if (name === c.keys.pin) {
      if (pinned) {
        setPinned(null);
        notice("Showing live data");
      } else {
        const past = history.at(cursor ?? snapshot.time);
        if (past) {
          setPinned(past);
          notice(
            `Agents, Resources, Builds and Storage show ${new Date(past.time).toLocaleTimeString()}`,
          );
        } else notice("No retained sample at the cursor", "warn");
      }
    }
  });
  // The marker the header draws, decided once: the fit predicate below and the
  // `Header` element at the foot of this function read the same value, so the
  // row App reserves height for is the row Header lays out.
  const headerPinnedAt = pinned && pinnable.includes(view) ? pinned.time : null;
  // The header, the blank line under it and the footer; the tabs take one
  // more row when the host, the marker and the clock leave them too little.
  const twoRowHeader = !tabsFitOneRow(
    width,
    snapshot.system.host,
    new Date(snapshot.time).toLocaleTimeString(),
    headerPinnedAt,
    c,
  );
  const contentHeight = Math.max(1, height - 3 - (twoRowHeader ? 1 : 0));
  let content: ReactNode;
  if (view === "Home")
    content = (
      <Home
        snapshot={snapshot}
        config={c}
        items={issues}
        // The newest few from everything retained, not the Timeline's
        // current window: this section exists for the reader who was away,
        // and a five-minute window told them nothing had changed while an
        // hour sat in history. It asks for the rows it shows, so finding them
        // stops rather than scanning a day of history on every render.
        changes={history.recentEvents(snapshot.time, recentChanges)}
        alertsOpened={opened}
        points={points}
        windowMs={windows[windowIndex]}
        selection={homeSelection}
        width={width - 4}
        height={contentHeight}
        onSelect={setHomeSelection}
        onCopy={copy}
        onOpen={(row) => {
          if (row.kind === "agent") openLane(row.lane.id);
          else if (row.kind === "change") openCard("Timeline", homeTarget(row));
          else openCard(row.item.view, row.item.target);
        }}
        // A tile drills down into a screen, the same as a card does, so it
        // goes through the same door: opening one on a pinned sample would
        // show the pinned data beside a Home that is live.
        onOpenView={(to) => openCard(to, undefined)}
      />
    );
  else if (view === "Agents")
    content = (
      <Agents
        snapshot={shown}
        history={history}
        config={c}
        laneId={laneId}
        live={!pinned}
        windowMs={windows[windowIndex]}
        width={width}
        height={contentHeight}
        onSave={onSave}
        onError={report}
        onOpen={setLaneId}
        onCopy={copy}
        onAct={act}
        onCapture={pinned ? undefined : onCapture}
        onSwitch={pinned ? undefined : onSwitch}
      />
    );
  else if (view === "Resources")
    content = (
      <Resources
        snapshot={shown}
        config={c}
        height={contentHeight}
        width={width}
        target={target?.kind === "group" ? target.path : null}
        onTargetUsed={clearTarget}
        onNotice={notice}
      />
    );
  else if (view === "Builds")
    content = (
      <Builds
        snapshot={shown}
        config={c}
        height={contentHeight}
        width={width - 4}
      />
    );
  else if (view === "Storage")
    content = (
      <Storage
        snapshot={shown}
        config={c}
        width={width - 4}
        target={target?.kind === "path" ? target.path : null}
        onTargetUsed={clearTarget}
        onNotice={notice}
      />
    );
  else if (view === "Timeline")
    content = (
      <Timeline
        snapshot={snapshot}
        history={history}
        config={c}
        points={points}
        windowIndex={windowIndex}
        cursor={cursor}
        width={width}
        height={contentHeight}
        onCursor={setCursor}
        onWindow={setWindowIndex}
        target={target?.kind === "time" ? target : null}
        onTargetUsed={clearTarget}
      />
    );
  else
    content = (
      <Settings
        snapshot={snapshot}
        config={c}
        width={width - 4}
        onSave={onSave}
        onNotice={notice}
      />
    );
  /**
   * Which hint set the footer draws. A process exits and the agent a reader
   * had open leaves the sample: what stays on screen is a sentence saying so,
   * and it takes only Back. The reader is not moved to another agent's data,
   * and the footer names no key that screen will not act on, which is the
   * whole of what a hint set promises.
   */
  const hintView: keyof typeof hints =
    view !== "Agents" || laneId === null
      ? view
      : shown.lanes.some((lane) => lane.id === laneId)
        ? "Agent"
        : "AgentGone";
  const lead = verdictItem(issues);
  const unread = new Set(snapshot.errors.map((e) => e.source)).size;
  const status = lead
    ? `${issues.length} ${issues.length === 1 ? "concern" : "concerns"}`
    : (history.retentionWarning ??
      (unread ? `${unread} sources unreadable` : "all clear"));
  return (
    <KeyProvider handlers={handlers}>
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        backgroundColor={ui.bg}
      >
        <Header
          host={snapshot.system.host}
          pinnedAt={headerPinnedAt}
          time={snapshot.time}
          view={view}
          width={width}
          config={c}
          onNavigate={navigate}
        />
        <box height={1} flexShrink={0} />
        <box
          flexDirection="column"
          flexGrow={1}
          minHeight={0}
          minWidth={0}
          overflow="hidden"
        >
          {content}
        </box>
        <Footer
          hints={[...hints[hintView](c), [c.keys.help, "keys"]]}
          status={status}
          statusColor={
            lead ? levelColor(lead.danger ? "danger" : "warn") : ui.ok
          }
          statusDim={!lead && status !== "all clear"}
        />
        {toast && <Toast text={toast.text} level={toast.level} />}
        {confirming && <Confirm command={confirming} config={c} />}
        {help && <Help config={c} />}
      </box>
    </KeyProvider>
  );
}
