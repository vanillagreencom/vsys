import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { Config } from "../config/config";
import { defaults } from "../config/config";
import { History } from "../store/history";
import { emptySnapshot, groupSnapshot, laneSnapshot } from "../test/fixture";
import { App, Waiting } from "./App";

test("keyboard and mouse navigate views and open lane detail", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot()];
  s.groups = [groupSnapshot()];
  const h = new History(c);
  h.add(s);
  let quit = false;
  const ui = await testRender(
    <App
      snapshot={s}
      history={h}
      config={c}
      onSave={async () => {}}
      onQuit={() => {
        quit = true;
      }}
      onExport={async () => "snapshot.json"}
    />,
    { width: 140, height: 35 },
  );
  try {
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Overview: current system state");
    await act(async () => {
      ui.mockInput.pressKey("1");
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("lane-a");
    await act(async () => {
      ui.mockInput.pressKey("2");
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("CPU weight / quota");
    await act(async () => {
      ui.mockInput.pressKey("3");
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("No build processes");
    await act(async () => {
      ui.mockInput.pressKey("4");
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("No watched btrfs mounts");
    await act(async () => {
      ui.mockInput.pressKey("5");
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Btrfs corruption");
    await act(async () => {
      ui.mockInput.pressKey("6");
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("No rule hits");
    await act(async () => {
      ui.mockInput.pressKey("1");
    });
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("main PID 40");
    await act(async () => {
      ui.mockInput.pressKey("q");
    });
    expect(quit).toBe(true);
    await act(async () => {
      await ui.mockMouse.click(4, 5);
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Build processes");
  } finally {
    await act(async () => {
      ui.renderer.destroy();
    });
    h.close();
  }
});

test("cursor pinning preserves the prior Fleet snapshot", async () => {
  const c = defaults();
  const h = new History(c);
  const old = emptySnapshot(1000);
  old.lanes = [laneSnapshot({ name: "before" })];
  h.add(old);
  const latest = emptySnapshot(2000);
  latest.lanes = [laneSnapshot({ name: "after" })];
  h.add(latest);
  const ui = await testRender(
    <App
      snapshot={latest}
      history={h}
      config={c}
      onSave={async () => {}}
      onQuit={() => {}}
      onExport={async () => "snapshot.json"}
    />,
    { width: 140, height: 35 },
  );
  try {
    await act(async () => {
      ui.mockInput.pressKey("5");
    });
    await act(async () => {
      ui.mockInput.pressKey("h");
    });
    await act(async () => {
      ui.mockInput.pressKey("p");
      ui.mockInput.pressKey("1");
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("PINNED");
    expect(ui.captureCharFrame()).toContain("before");
    expect(ui.captureCharFrame()).not.toContain("after");
  } finally {
    await act(async () => {
      ui.renderer.destroy();
    });
    h.close();
  }
});
test("the settings form saves edited values and supports modified quit bindings", async () => {
  const c = defaults();
  c.keys.quit = "alt+q";
  const s = emptySnapshot();
  const h = new History(c);
  h.add(s);
  let saved: Config | undefined;
  let quits = 0;
  const ui = await testRender(
    <App
      snapshot={s}
      history={h}
      config={c}
      onSave={async (next) => {
        saved = next;
      }}
      onQuit={() => {
        quits++;
      }}
      onExport={async () => "export.json"}
    />,
    { width: 140, height: 35 },
  );
  try {
    await act(async () => {
      ui.mockInput.pressKey(",");
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Refresh interval (ms): 1000");
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    await act(async () => {
      ui.mockInput.pressKey("END");
      for (let i = 0; i < 4; i++) ui.mockInput.pressBackspace();
    });
    await act(async () => {
      await ui.mockInput.typeText("500");
    });
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    expect(saved?.refreshMs).toBe(500);
    await act(async () => {
      ui.mockInput.pressKey("q", { meta: true });
    });
    expect(quits).toBe(1);
    await act(async () => {
      ui.mockInput.pressCtrlC();
    });
    expect(quits).toBe(2);
  } finally {
    await act(async () => {
      ui.renderer.destroy();
    });
    h.close();
  }
});
test("startup stays interruptible before the first sample arrives", async () => {
  let quits = 0;
  const ui = await testRender(
    <Waiting
      quitKey="q"
      onQuit={() => {
        quits++;
      }}
    />,
    { width: 80, height: 10 },
  );
  try {
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Collecting system data");
    await act(async () => {
      ui.mockInput.pressKey("q");
    });
    expect(quits).toBe(1);
    await act(async () => {
      ui.mockInput.pressCtrlC();
    });
    expect(quits).toBe(2);
  } finally {
    await act(async () => {
      ui.renderer.destroy();
    });
  }
});
test("overview keeps keyboard-selected concerns visible in a small terminal", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = Array.from({ length: 30 }, (_, i) =>
    laneSnapshot({
      id: `lane-${i}`,
      name: `concern-${String(i).padStart(2, "0")}`,
      dangerous: true,
    }),
  );
  const h = new History(c);
  h.add(s);
  const ui = await testRender(
    <App
      snapshot={s}
      history={h}
      config={c}
      onSave={async () => {}}
      onQuit={() => {}}
      onExport={async () => "report.json"}
    />,
    { width: 80, height: 24 },
  );
  try {
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        ui.mockInput.pressArrow("down");
      });
      await ui.renderOnce();
    }
    expect(ui.captureCharFrame()).toContain("> concern-20");
    expect(ui.captureCharFrame().split("\n")[0]).toContain("vsys-view");
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("concern-20");
    expect(ui.captureCharFrame()).toContain("main PID 40");
  } finally {
    await act(async () => {
      ui.renderer.destroy();
    });
    h.close();
  }
});
test("Fleet search finds a worktree and clears without losing the full list", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ name: "payments", cwd: "/work/acme/payment-service" }),
    laneSnapshot({ id: "other", name: "website", cwd: "/work/site" }),
  ];
  const h = new History(c);
  h.add(s);
  const ui = await testRender(
    <App
      snapshot={s}
      history={h}
      config={c}
      onSave={async () => {}}
      onQuit={() => {}}
      onExport={async () => "report.json"}
    />,
    { width: 80, height: 24 },
  );
  try {
    await act(async () => {
      ui.mockInput.pressKey("1");
    });
    await act(async () => {
      ui.mockInput.pressKey("/");
    });
    await act(async () => {
      await ui.mockInput.typeText("ACME");
    });
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("payments");
    expect(ui.captureCharFrame()).not.toContain("website");
    await act(async () => {
      ui.mockInput.pressKey("/");
    });
    await act(async () => {
      ui.mockInput.pressEscape();
      await Bun.sleep(50);
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("website");
  } finally {
    await act(async () => {
      ui.renderer.destroy();
    });
    h.close();
  }
});
