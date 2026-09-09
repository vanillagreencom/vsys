import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { defaults } from "../config/config";
import { History } from "../store/history";
import { emptySnapshot, laneSnapshot, volumeSnapshot } from "../test/fixture";
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
      ui.mockInput.pressKey("2");
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
      expect(ui.captureCharFrame()).toContain("40 agents");
      expect(
        ui
          .captureCharFrame()
          .split("\n")
          .filter((line) => line.includes("40 agents")).length,
      ).toBe(1);
    }
    // Fifty-nine presses on forty rows leave the last row selected, and the
    // selection paged the list rather than the viewport.
    expect(ui.captureCharFrame()).toContain("▍work-00");
    await act(async () => {
      ui.mockInput.pressKey("d");
    });
    await ui.renderOnce();
    await act(async () => {
      ui.mockInput.pressArrow("right");
    });
    await ui.renderOnce();
    const tableScroll = ui.renderer.root.findDescendantById(
      "agents-table",
    ) as ScrollBoxRenderable;
    expect(tableScroll).toBeInstanceOf(ScrollBoxRenderable);
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
    expect(ui.captureCharFrame()).toContain("PID 40");
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

test("a serious cause that appears between samples raises a notice on any view", async () => {
  const c = defaults();
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const h = new History(c);
  const ui = await createTestRenderer({ width: 120, height: 28 });
  const notified: string[] = [];
  ui.renderer.triggerNotification = (message: string) => {
    notified.push(message);
    return true;
  };
  let screen!: ReturnType<typeof mountScreen>;
  await act(async () => {
    screen = mountScreen(ui.renderer, c, {
      onQuit: () => {},
      onSave: async () => {},
      onExport: async () => "report.json",
    });
  });
  try {
    const calm = emptySnapshot(1000);
    h.add(calm);
    await act(async () => {
      screen.update(calm, h, c);
    });
    await act(async () => {
      ui.mockInput.pressKey("5");
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).not.toContain("╭");
    const alarmed = emptySnapshot(2000);
    alarmed.storage.volumes = [volumeSnapshot("/mnt/data", { readOnly: true })];
    h.add(alarmed);
    await act(async () => {
      screen.update(alarmed, h, c);
    });
    await ui.renderOnce();
    const frame = ui.captureCharFrame();
    // The notice sits over the Storage view, which stays where it was.
    expect(frame).toContain("╭");
    expect(frame).toContain("Danger: 1 mount is read-only: /mnt/data");
    expect(frame).toContain("Written since boot");
    expect(notified).toEqual(["Danger: 1 mount is read-only: /mnt/data"]);
    // The same cause a sample later is old news.
    const still = emptySnapshot(3000);
    still.storage.volumes = alarmed.storage.volumes;
    h.add(still);
    await act(async () => {
      screen.update(still, h, c);
    });
    expect(notified.length).toBe(1);
  } finally {
    await act(async () => {
      screen.close();
    });
    ui.renderer.destroy();
    environment.IS_REACT_ACT_ENVIRONMENT = previousEnvironment;
    h.close();
  }
});
