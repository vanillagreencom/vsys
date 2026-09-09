import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { defaults } from "../config/config";
import { History } from "../store/history";
import { emptySnapshot, laneSnapshot } from "../test/fixture";
import { mountScreen } from "./screen";

test("live refresh keeps one screen, stable listeners and the selected view", async () => {
  const c = defaults();
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const h = new History(c);
  const ui = await createTestRenderer({ width: 120, height: 28 });
  const before = [
    ui.renderer.keyInput.listenerCount("keypress"),
    ui.renderer.listenerCount("resize"),
  ];
  let screen!: ReturnType<typeof mountScreen>;
  let quits = 0;
  await act(async () => {
    screen = mountScreen(ui.renderer, c, {
      onQuit: () => {
        quits++;
      },
      onSave: async () => {},
      onExport: async () => "report.json",
    });
  });
  try {
    const update = async (time: number) => {
      const s = emptySnapshot(time);
      s.lanes = Array.from({ length: 40 }, (_, i) =>
        laneSnapshot({
          id: `lane-${i}`,
          name: `work-${String(i).padStart(2, "0")}`,
          cpu: i,
        }),
      );
      h.add(s);
      await act(async () => {
        screen.update(s, h, c);
      });
      await ui.renderOnce();
    };
    await update(1000);
    const listeners = [
      ui.renderer.keyInput.listenerCount("keypress"),
      ui.renderer.listenerCount("resize"),
    ];
    await act(async () => {
      ui.mockInput.pressKey("1");
    });
    for (let tick = 2; tick <= 60; tick++) {
      if (tick === 20)
        await act(async () => {
          ui.resize(80, 24);
        });
      await act(async () => {
        ui.mockInput.pressArrow("down");
      });
      await update(tick * 1000);
      expect(ui.renderer.root.getChildren().length).toBe(1);
      expect([
        ui.renderer.keyInput.listenerCount("keypress"),
        ui.renderer.listenerCount("resize"),
      ]).toEqual(listeners);
      expect(ui.captureCharFrame()).toContain("Fleet LIVE");
      expect(
        ui
          .captureCharFrame()
          .split("\n")
          .filter((line) => line.includes("Fleet LIVE")).length,
      ).toBe(1);
    }
    expect(ui.captureCharFrame()).toContain("> work-00");
    const scroll = ui.renderer.root.findDescendantById("view-scroll");
    expect(scroll).toBeInstanceOf(ScrollBoxRenderable);
    expect((scroll as ScrollBoxRenderable).scrollTop).toBe(0);
    await act(async () => {
      ui.mockInput.pressKey("d");
    });
    await ui.renderOnce();
    await act(async () => {
      ui.mockInput.pressArrow("right");
    });
    await ui.renderOnce();
    const tableScroll = ui.renderer.root.findDescendantById(
      "view-scroll",
    ) as ScrollBoxRenderable;
    expect(tableScroll.scrollLeft).toBeGreaterThan(0);
    await act(async () => {
      ui.mockInput.pressArrow("up");
    });
    await ui.renderOnce();
    expect(tableScroll.scrollTop).toBe(0);
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    await update(61000);
    expect(ui.captureCharFrame()).toContain("main PID 40");
    await act(async () => {
      ui.mockInput.pressKey("q");
    });
    expect(quits).toBe(1);
  } finally {
    await act(async () => {
      screen.close();
    });
    expect([
      ui.renderer.keyInput.listenerCount("keypress"),
      ui.renderer.listenerCount("resize"),
    ]).toEqual(before);
    ui.renderer.destroy();
    environment.IS_REACT_ACT_ENVIRONMENT = previousEnvironment;
    h.close();
  }
});
