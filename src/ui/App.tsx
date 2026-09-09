import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Config } from "../config/config";
import { keyName } from "../config/keys";
import type { Snapshot } from "../model/types";
import type { Level } from "../model/verdict";
import type { History } from "../store/history";
import { Agents } from "./agents";
import { attention, verdictItem } from "./attention";
import { Builds } from "./builds-screen";
import {
  Footer,
  Header,
  Help,
  narrowWidth,
  type View,
  viewKey,
  views,
} from "./chrome";
import { Home } from "./home";
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
}
/** The views that show a past sample while one is pinned. */
const pinnable: View[] = ["Agents", "Resources", "Builds", "Storage"];
const hints: Record<View, (c: Config) => [string, string][]> = {
  Home: (c) => [
    ["↑↓", "select"],
    [c.keys.open, "open"],
  ],
  Agents: (c) => [
    ["↑↓", "select"],
    [c.keys.open, "open"],
    [c.keys.search, "find"],
    [c.keys.details, "table"],
  ],
  Resources: (c) => [
    ["↑↓", "select"],
    [c.keys.details, "all groups"],
  ],
  Builds: (c) => [
    ["↑↓", "select"],
    [c.keys.open, "processes"],
  ],
  Storage: (c) => [
    ["↑↓", "select"],
    [c.keys.open, "details"],
  ],
  Timeline: (c) => [
    ["←→", "time"],
    [c.keys.window, "window"],
    [c.keys.pin, "pin"],
  ],
  Settings: (c) => [
    ["↑↓", "select"],
    [c.keys.open, "edit"],
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
}: AppProps) {
  const renderer = useRenderer();
  const [view, setView] = useState<View>("Home");
  const [homeIndex, setHomeIndex] = useState(0);
  const [laneId, setLaneId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [pinned, setPinned] = useState<Snapshot | null>(null);
  const [windowIndex, setWindowIndex] = useState(0);
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState<{ text: string; level: Level } | null>(
    null,
  );
  const handlers = useRef(new Set<KeyHandler>()).current;
  const { width, height } = useTerminalDimensions();
  const shown = pinned ?? snapshot;
  const issues = attention(snapshot, c);
  const points = history.window(snapshot.time, windows[windowIndex]);
  const notice = (text: string, level: Level = "ok") =>
    setToast({ text, level });
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toastMs);
    return () => clearTimeout(timer);
  }, [toast]);
  // A serious cause that was not there a sample ago is announced once, on
  // screen and to the terminal, whichever view is open.
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
  useKeyboard((key) => {
    const name = keyName(key);
    if (name === "ctrl+c") {
      onQuit();
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
  // The header, the blank line under it and the footer; the tabs take one
  // more row in a narrow terminal.
  const contentHeight = Math.max(1, height - 3 - (width < narrowWidth ? 1 : 0));
  let content: ReactNode;
  if (view === "Home")
    content = (
      <Home
        snapshot={snapshot}
        config={c}
        items={issues}
        points={points}
        windowMs={windows[windowIndex]}
        selected={homeIndex}
        width={width - 4}
        onSelect={setHomeIndex}
        onOpen={(row) => {
          if (row.kind === "agent") openLane(row.lane.id);
          else if (row.item.laneId) openLane(row.item.laneId);
          else navigate(row.item.view);
        }}
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
      />
    );
  else if (view === "Resources")
    content = (
      <Resources
        snapshot={shown}
        config={c}
        height={contentHeight}
        width={width}
      />
    );
  else if (view === "Builds")
    content = <Builds snapshot={shown} config={c} height={contentHeight} />;
  else if (view === "Storage")
    content = <Storage snapshot={shown} config={c} />;
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
      />
    );
  else
    content = (
      <Settings
        snapshot={snapshot}
        config={c}
        onSave={onSave}
        onNotice={notice}
      />
    );
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
          pinnedAt={pinned && pinnable.includes(view) ? pinned.time : null}
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
          hints={[...hints[view](c), [c.keys.help, "keys"]]}
          status={status}
          statusColor={
            lead ? levelColor(lead.danger ? "danger" : "warn") : ui.ok
          }
          statusDim={!lead && status !== "all clear"}
        />
        {toast && <Toast text={toast.text} level={toast.level} />}
        {help && <Help config={c} />}
      </box>
    </KeyProvider>
  );
}
