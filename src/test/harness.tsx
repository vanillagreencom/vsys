import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { Config } from "../config/config";
import type { LaneCommand } from "../model/actions";
import type { Snapshot } from "../model/types";
import { History } from "../store/history";
import { App } from "../ui/App";

/**
 * The mounted app a screen test drives, and the one way to read which row
 * it marks. Every screen's test file mounts the whole shell, so this lives
 * beside the fixture rather than in any one screen's file.
 */
/** One mounted App over a history, with the hooks a test asserts on. */
export async function mount(
  s: Snapshot,
  c: Config,
  size = { width: 140, height: 35 },
  hooks: Partial<{
    onSave: (next: Config) => Promise<void>;
    onQuit: () => void;
    onAction: (command: LaneCommand) => Promise<void>;
    onCapture: (paneId: string) => Promise<string[]>;
    onSwitch: (paneId: string) => Promise<void>;
    history: History;
  }> = {},
) {
  const h = hooks.history ?? new History(c);
  if (!hooks.history) h.add(s);
  // The clipboard escape goes to a stream the test reads back, standing in for
  // the process output stream the running program hands over.
  const written: string[] = [];
  // Collection publishes a new snapshot into the mounted tree every tick, the
  // way `mountScreen` does, so a test can let a sample land mid-interaction.
  let publish: ((next: Snapshot) => void) | null = null;
  function Mounted() {
    const [current, setCurrent] = useState(s);
    // A saved setting comes back as the config the screens read, the way the
    // running program's session hands it back. Without that, a key that saves
    // is a key whose effect no test can see.
    const [config, setConfig] = useState(c);
    publish = setCurrent;
    return (
      <App
        snapshot={current}
        history={h}
        config={config}
        onSave={async (next) => {
          setConfig(next);
          await hooks.onSave?.(next);
        }}
        onQuit={hooks.onQuit ?? (() => {})}
        onExport={async () => "snapshot.json"}
        onAction={hooks.onAction ?? (async () => {})}
        onCapture={hooks.onCapture}
        onSwitch={hooks.onSwitch}
        output={{ write: (chunk: string) => written.push(chunk) }}
      />
    );
  }
  const ui = await testRender(<Mounted />, size);
  const update = async (next: Snapshot) => {
    await act(async () => {
      publish?.(next);
    });
    await ui.renderOnce();
  };
  const press = async (key: string) => {
    await act(async () => {
      if (key === "enter") ui.mockInput.pressEnter();
      else if (key === "escape") {
        // A lone escape waits for the rest of a sequence before it is a key.
        ui.mockInput.pressEscape();
        await Bun.sleep(50);
      } else if (key === "tab") ui.mockInput.pressTab();
      else if (key === "shift+tab") ui.mockInput.pressTab({ shift: true });
      else if (["up", "down", "left", "right"].includes(key))
        ui.mockInput.pressArrow(key as "up" | "down" | "left" | "right");
      else ui.mockInput.pressKey(key);
    });
    await ui.renderOnce();
  };
  const frame = () => ui.captureCharFrame();
  const wheel = async (x: number, y: number, way: "up" | "down") => {
    await act(async () => {
      await ui.mockMouse.scroll(x, y, way);
    });
    await ui.renderOnce();
  };
  const click = async (x: number, y: number) => {
    await act(async () => {
      await ui.mockMouse.click(x, y);
    });
    await ui.renderOnce();
  };
  const close = async () => {
    await act(async () => {
      ui.renderer.destroy();
    });
    h.close();
  };
  return { ui, h, press, frame, wheel, click, close, written, update };
}

/** The row a screen marks as selected, without its marker. */
export function selectedRow(frame: string): string {
  const line = frame.split("\n").find((row) => row.includes("▍"));
  return (line ?? "").replace("▍", "").trim();
}

/**
 * A line drawn as a child of the row above it: the rule at its left, then the
 * indent, then its text. An indent alone reads as a new top-level line, which
 * is the whole reason the rule exists.
 */
export const isChildLine = (line: string): boolean => / │ +\S/.test(line);
