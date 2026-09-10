import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { defaults, validate } from "../config/config";
import { History } from "../store/history";
import {
  emptySnapshot,
  everyCauseSnapshot,
  groupSnapshot,
  laneSnapshot,
  volumeSnapshot,
} from "../test/fixture";
import { mount } from "../test/harness";
import { hints, Waiting } from "./App";
import { headerRowWidth, views } from "./chrome";

test("keys and the mouse move between tabs, open an agent, and quit", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot()];
  s.groups = [groupSnapshot()];
  let quit = false;
  const t = await mount(s, c, undefined, {
    onQuit: () => {
      quit = true;
    },
  });
  try {
    await t.ui.renderOnce();
    expect(t.frame()).toContain("Needs attention");
    const expected: [string, string][] = [
      ["2", "sorted by CPU"],
      ["3", "Groups"],
      ["4", "Nothing is compiling or linking"],
      ["5", "Written since boot"],
      ["6", "What changed"],
      ["7", "Data sources"],
    ];
    for (const [key, text] of expected) {
      await t.press(key);
      expect(t.frame()).toContain(text);
    }
    await t.press("2");
    await t.press("enter");
    expect(t.frame()).toContain("PID 40");
    expect(t.frame()).toContain("Processes");
    await t.press("escape");
    expect(t.frame()).toContain("sorted by CPU");
    await act(async () => {
      await t.ui.mockMouse.click(60, 0);
    });
    await t.ui.renderOnce();
    expect(t.frame()).toContain("Groups");
    await t.press("q");
    expect(quit).toBe(true);
  } finally {
    await t.close();
  }
});

test("pinning shows the machine at the cursor on the sample views only", async () => {
  const c = defaults();
  const h = new History(c);
  const old = emptySnapshot(1000);
  old.lanes = [laneSnapshot({ name: "before" })];
  h.add(old);
  const latest = emptySnapshot(2000);
  latest.lanes = [laneSnapshot({ name: "after" })];
  h.add(latest);
  const t = await mount(latest, c, undefined, { history: h });
  try {
    await t.press("6");
    await t.press("h");
    await t.press("p");
    await t.press("2");
    expect(t.frame()).toContain("◆");
    expect(t.frame()).toContain("before");
    expect(t.frame()).not.toContain("after");
    await t.press("1");
    expect(t.frame()).toContain("● live");
  } finally {
    await t.close();
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
    expect(ui.captureCharFrame()).toContain("Reading system data");
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

test("the help overlay opens on its key and any key closes it", async () => {
  const c = defaults();
  const t = await mount(emptySnapshot(), c);
  try {
    await t.press("?");
    expect(t.frame()).toContain("next and previous tab");
    await t.press("2");
    expect(t.frame()).not.toContain("next and previous tab");
    expect(t.frame()).toContain("Needs attention");
  } finally {
    await t.close();
  }
});

test("a narrow terminal gives the tabs their own row and drops the wait column", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a", pressure: 12 })];
  const wide = await mount(s, c, { width: 140, height: 24 });
  try {
    await wide.press("2");
    const frame = wide.frame();
    expect(frame.split("\n")[0]).toContain("2 Agents");
    // The heading names the column, so the cell carries only the reading.
    // The sorted column carries its direction, and on a numeric column the
    // arrow leads so the heading still ends where the digits do.
    expect(frame).toMatch(
      /Agent\s+PID\s+Program\s+↓ CPU\s+Trend\s+Memory\s+Wait\s+State/,
    );
    expect(frame).toContain("12.0%");
  } finally {
    await wide.close();
  }
  const narrow = await mount(s, c, { width: 80, height: 24 });
  try {
    await narrow.press("2");
    const rows = narrow.frame().split("\n");
    expect(rows[0]).not.toContain("2 Agents");
    expect(rows[1]).toContain("2 Agents");
    expect(narrow.frame()).toContain("lane-a");
    expect(narrow.frame()).not.toContain("Wait");
    expect(narrow.frame()).not.toContain("12.0%");
  } finally {
    await narrow.close();
  }
});

test("the help panel covers what it sits on, at any terminal size", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const widths: number[] = [];
  for (const size of [
    { width: 180, height: 44 },
    { width: 100, height: 32 },
  ]) {
    const t = await mount(s, c, size);
    try {
      await t.press("?");
      const lines = t.frame().split("\n");
      const top = lines.findIndex((line) => line.includes("╭"));
      const bottom = lines.findIndex((line) => line.includes("╰"));
      expect(top).toBeGreaterThan(-1);
      expect(bottom).toBeGreaterThan(top);
      const left = lines[top].indexOf("╭");
      const right = lines[top].lastIndexOf("╮");
      expect(right).toBeGreaterThan(left);
      // The panel is as wide as its own content, so it is the same width in
      // both terminals and never reaches either edge.
      widths.push(right - left + 1);
      expect(left).toBeGreaterThan(0);
      expect(right).toBeLessThan(size.width - 1);
      // Inside the border, every cell belongs to the panel: nothing from the
      // screen behind it shows through its blank columns.
      for (let row = top + 1; row < bottom; row++) {
        const inside = lines[row].slice(left, right + 1);
        expect({ row, edges: `${inside[0]}${inside.at(-1)}` }).toEqual({
          row,
          edges: "││",
        });
      }
    } finally {
      await t.close();
    }
  }
  expect(widths.length).toBe(2);
  expect(widths[0]).toBe(widths[1]);
});

/** A sample that gives every screen rows to act on. */
function everyScreenSnapshot() {
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", cpu: 9, builds: { "ld.mold": 1 } }),
    laneSnapshot({ id: "b", name: "lane-b", cpu: 1 }),
  ];
  s.groups = [
    groupSnapshot({ path: "busy.scope", name: "busy.scope", cpuPercent: 50 }),
    groupSnapshot({ path: "idle.scope", name: "idle.scope" }),
  ];
  s.storage.volumes = [volumeSnapshot("/data")];
  return s;
}

test("every screen's footer names only keys that screen handles", async () => {
  const c = defaults();
  // Arrow pairs are movement, which the list tests already cover; every other
  // hint is a promise that pressing that key does something on that screen.
  const pressable = (key: string) => key !== "↑↓" && key !== "←→";
  for (const view of views)
    for (const [key] of hints[view](c).filter(([key]) => pressable(key))) {
      const t = await mount(everyScreenSnapshot(), c, {
        width: 160,
        height: 40,
      });
      try {
        await t.press(String(views.indexOf(view) + 1));
        const before = t.frame();
        await t.press(key === "return" ? "enter" : key);
        expect({ view, key, acted: t.frame() !== before }).toEqual({
          view,
          key,
          acted: true,
        });
      } finally {
        await t.close();
      }
    }
});

test("every key hint reads the binding, in the footer and in the help panel", async () => {
  const c = defaults();
  // Bindings nothing else uses, so finding them proves they were read.
  c.keys.search = "f";
  c.keys.details = "b";
  c.keys.help = "g";
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a" })];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 160, height: 30 });
  try {
    await t.press("2");
    const footer = t.frame().split("\n").at(-2) ?? "";
    expect(footer).toContain("f find");
    expect(footer).toContain("b table");
    // The default bindings are gone from the hints, not merely joined by the
    // new ones.
    expect(footer).not.toContain("/ find");
    expect(footer).toContain("g keys");
    await t.press("g");
    // The panel names the same binding beside what it does, on one row.
    const row = t
      .frame()
      .split("\n")
      .find((line) => line.includes("find an agent"));
    expect(row).toBeDefined();
    expect(row).toContain("f");
    expect(row).not.toContain("/");
  } finally {
    await t.close();
  }
});

const equalTabs = () =>
  validate({
    ...defaults(),
    keys: {
      ...defaults().keys,
      home: "ctrl+f1",
      agents: "alt+a",
      resources: "f1",
      builds: "alt+b",
      storage: "pgup",
      timeline: "f10",
      settings: "f11",
    },
  });

test("the header lays out on the row its own predicate promised", async () => {
  const c = equalTabs();
  const s = emptySnapshot();
  s.system.host = "cachy";
  const clock = new Date(s.time).toLocaleTimeString();
  const exact = headerRowWidth("cachy", clock, null, c);
  // At the width the predicate accepts, the tabs share the header's own row
  // and the clock still ends it.
  const fits = await mount(s, c, { width: exact, height: 24 });
  try {
    // An unbound key draws a frame without changing what is on it.
    await fits.press("z");
    const lines = fits.frame().split("\n");
    expect(lines[0]).toContain("cachy");
    expect(lines[0]).toContain("Settings");
    expect(lines[0].trimEnd().endsWith(clock)).toBe(true);
  } finally {
    await fits.close();
  }
  // Five columns short of that, the tabs take a row of their own. The earlier
  // predicate accepted this width, and the row it drew ran the last tab into
  // the clock: `7 Settin5:50:23 PM`.
  const tight = await mount(s, c, { width: exact - 5, height: 24 });
  try {
    await tight.press("z");
    const lines = tight.frame().split("\n");
    expect(lines[0]).toContain("cachy");
    expect(lines[0].trimEnd().endsWith(clock)).toBe(true);
    expect(lines[1]).toContain("Home");
    expect(lines[1]).toContain("Settings");
  } finally {
    await tight.close();
  }
});
