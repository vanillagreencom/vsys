import {
  type BaseRenderable,
  type RGBA,
  TextAttributes,
  TextBufferRenderable,
} from "@opentui/core";
import type { TestRendererOptions } from "@opentui/core/testing";
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
  // A caller that needs the live renderer's own frame cap, rather than this
  // harness's default of none, passes `maxFps` (and, to drive it without a
  // real wall-clock wait, `clock`) alongside the size.
  size: { width: number; height: number } & Partial<TestRendererOptions> = {
    width: 140,
    height: 35,
  },
  hooks: Partial<{
    onSave: (next: Config) => Promise<void>;
    onQuit: () => void;
    onAction: (command: LaneCommand) => Promise<void>;
    onCapture: (paneId: string) => Promise<string[]>;
    onSwitch: (paneId: string) => Promise<void>;
    onExport: (s: Snapshot, format: "json" | "markdown") => Promise<string>;
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
    // A saved setting comes back as the config the screens read once the save
    // succeeds, the way the running program's session hands it back. Without
    // that, a key that saves is a key whose effect no test can see.
    const [config, setConfig] = useState(c);
    publish = setCurrent;
    return (
      <App
        snapshot={current}
        history={h}
        config={config}
        onSave={async (next) => {
          await hooks.onSave?.(next);
          setConfig(next);
        }}
        onQuit={hooks.onQuit ?? (() => {})}
        onExport={hooks.onExport ?? (async () => "snapshot.json")}
        onAction={hooks.onAction ?? (async () => {})}
        onCapture={hooks.onCapture}
        onSwitch={hooks.onSwitch}
        output={{ write: (chunk: string) => written.push(chunk) }}
      />
    );
  }
  // No frame cap by default, so a commit is laid out on the tick after it,
  // before any timer the commit's effects set. At the default cap a commit
  // inside the frame interval waits for a render timer, and a screen's
  // deferred pass can run first and measure the layout from before the
  // commit; a test driving that case passes its own `maxFps` to override this.
  const ui = await testRender(<Mounted />, {
    maxFps: Number.POSITIVE_INFINITY,
    ...size,
  });
  const update = async (next: Snapshot) => {
    await act(async () => {
      publish?.(next);
    });
    await ui.renderOnce();
  };
  const send = async (key: string) => {
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
  };
  const press = async (key: string) => {
    await act(async () => {
      await send(key);
    });
    await ui.renderOnce();
  };
  /**
   * Several keys delivered before the screen renders again, the way a held
   * or double-pressed key arrives when a sample keeps the process busy: the
   * terminal hands them over in one read and each handler runs before React
   * commits the first.
   */
  const pressTogether = async (keys: string[]) => {
    await act(async () => {
      for (const key of keys) await send(key);
    });
    await ui.renderOnce();
  };
  const frame = () => ui.captureCharFrame();
  /**
   * Lets the deferred passes the last render set land, then draws where they
   * left the screen. A row that has just grown does not know its size until
   * the layout after the render that grew it, so a pass reads it again on the
   * renderer's own next frame rather than a timer. Under this harness's
   * default uncapped renderer that frame has already fired, inside the render
   * the triggering `press` or `update` call made, so what remains here is one
   * more render to draw the correction that frame already made.
   */
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await ui.renderOnce();
  };
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
  return {
    ui,
    h,
    press,
    pressTogether,
    frame,
    settle,
    wheel,
    click,
    close,
    written,
    update,
  };
}

/**
 * A colour as the terminal shows it in one slot. A default colour is named by
 * its slot, since the terminal's default foreground and default background
 * are different colours whatever value the buffer holds.
 */
export function shown(colour: RGBA, slot: "fg" | "bg"): string {
  return colour.intent === "default"
    ? `default ${slot}`
    : `${colour.intent} ${colour.toInts().join(",")}`;
}
/**
 * A captured span's glyph and cell colours as the reader sees them. OpenTUI
 * trades a reversed cell's two colours in its buffer and also sends reverse
 * video, so the terminal trades them again: a reversed span's glyph shows in
 * the colour its capture holds as the background.
 */
export function onScreen(span: { fg: RGBA; bg: RGBA; attributes: number }): {
  glyph: string;
  cell: string;
} {
  return span.attributes & TextAttributes.INVERSE
    ? { glyph: shown(span.bg, "bg"), cell: shown(span.fg, "fg") }
    : { glyph: shown(span.fg, "fg"), cell: shown(span.bg, "bg") };
}

/** The row a screen marks as selected, without its marker. */
export function selectedRow(frame: string): string {
  const line = frame.split("\n").find((row) => row.includes("▍"));
  return (line ?? "").replace("▍", "").trim();
}

/**
 * The row a screen marks and the lines under it, without the scrollbar
 * column. Two frames of one screen reached by different routes differ in how
 * far the screen scrolled and in charts and tiles above the row, whose widths
 * settle on a later layout pass, while showing the same row and what it opened.
 */
export function underMarked(frame: string, lines = 8): string[] {
  const rows = frame.split("\n");
  const y = rows.findIndex((row) => row.includes("▍"));
  if (y < 0) return [];
  return rows.slice(y, y + lines).map((row) => row.slice(0, -2));
}

/**
 * A line drawn as a child of the row above it: the rule at its left, then the
 * indent, then its text. An indent alone reads as a new top-level line, which
 * is the whole reason the rule exists.
 */
export const isChildLine = (line: string): boolean => / │ +\S/.test(line);

/**
 * The drawn lines holding `needle` whose text is longer than the box laid out
 * for them. The terminal cuts such a line at the box's edge, so whatever lies
 * past it is never seen.
 */
export function overflowing(
  ui: Awaited<ReturnType<typeof testRender>>,
  needle: string,
): string[] {
  const cut: string[] = [];
  const walk = (node: BaseRenderable) => {
    if (
      node instanceof TextBufferRenderable &&
      node.plainText.includes(needle) &&
      [...node.plainText].length > node.width
    )
      cut.push(node.plainText);
    for (const child of node.getChildren()) walk(child);
  };
  walk(ui.renderer.root);
  return cut;
}

/**
 * How the cell where `text` starts is drawn, on the first line holding it:
 * `dim`, `plain`, or `missing` where no line holds the text.
 */
export function cellStyle(
  ui: Awaited<ReturnType<typeof testRender>>,
  text: string,
  dim: number,
): "dim" | "plain" | "missing" {
  for (const line of ui.captureSpans().lines) {
    const at = line.spans
      .map((span) => span.text)
      .join("")
      .indexOf(text);
    if (at < 0) continue;
    let end = 0;
    for (const span of line.spans) {
      end += span.text.length;
      if (at < end) return span.attributes & dim ? "dim" : "plain";
    }
  }
  return "missing";
}

/**
 * The headings carrying a sort arrow on a lane table's heading line, the line
 * naming both `Agent` and `Memory`, as drawn: `↓ CPU`, `Agent ↑`.
 */
export function sortMarks(frame: string): string[] {
  const heading =
    frame
      .split("\n")
      .find((line) => line.includes("Agent") && line.includes("Memory")) ?? "";
  return heading
    .split(/\s{2,}/)
    .filter((part) => /[↑↓]/.test(part))
    .map((part) => part.trim());
}
