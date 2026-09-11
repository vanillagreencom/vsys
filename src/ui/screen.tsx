import type { CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useSyncExternalStore } from "react";
import type { Config } from "../config/config";
import type { Snapshot } from "../model/types";
import type { History } from "../store/history";
import { App, type AppProps, Waiting } from "./App";

/** Mount once: OpenTUI's root.render creates a new reconciler container per call. */
export function mountScreen(
  renderer: CliRenderer,
  config: Config,
  actions: Pick<
    AppProps,
    | "onQuit"
    | "onSave"
    | "onExport"
    | "onAction"
    | "onCapture"
    | "onSwitch"
    | "output"
  >,
) {
  type Frame = { snapshot: Snapshot; history: History; config: Config };
  let frame: Frame | null = null;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const getSnapshot = () => frame;
  function Screen() {
    const current = useSyncExternalStore(subscribe, getSnapshot);
    return current ? (
      <App {...current} {...actions} />
    ) : (
      <Waiting quitKey={config.keys.quit} onQuit={actions.onQuit} />
    );
  }
  const root = createRoot(renderer);
  root.render(<Screen />);
  return {
    update(snapshot: Snapshot, history: History, config: Config) {
      frame = { snapshot, history, config };
      for (const listener of listeners) listener();
    },
    close() {
      root.unmount();
    },
  };
}
