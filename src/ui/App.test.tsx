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
  processSnapshot,
  volumeSnapshot,
} from "../test/fixture";
import { mount, selectedRow } from "../test/harness";
import { hints, Waiting } from "./App";
import { attention } from "./attention";
import { headerRowWidth, views } from "./chrome";
import { type KeyHandler, KeyProvider } from "./keys";
import { Resources } from "./resources";
import { Storage } from "./storage-screen";

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
    expect(frame).toMatch(
      /Agent\s+Program\s+CPU\s+Trend\s+Memory\s+Wait\s+State/,
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

test("Resources sizes its tiles by the width it has, at a hundred columns", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const t = await mount(s, c, { width: 100, height: 30 });
  try {
    await t.press("3");
    const lines = t.frame().split("\n");
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    // Four tiles in ninety-six columns are twenty-two columns each, under the
    // width a tile needs, so they wrap to two rows instead of truncating.
    expect(at("CPU wait")).toBeGreaterThan(-1);
    expect(at("Swap")).toBeGreaterThan(at("CPU wait"));
    // The detail under the number is a whole sentence, not a cut one.
    expect(lines.some((line) => line.includes("desktop"))).toBe(true);
  } finally {
    await t.close();
  }
});

test("a configurable numeric column reads down its last digit", async () => {
  // Five numeric columns were missing from the right-align set, so a reader
  // who configured one got a number that did not line up with its neighbours.
  const c = {
    ...defaults(),
    columns: ["name", "cache", "readRate", "blocked", "sccache"],
  };
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({
      name: "lane-a",
      cache: 1024,
      readRate: 2048,
      blocked: 3,
      sccache: 4,
    }),
  ];
  const t = await mount(s, c, { width: 180, height: 24 });
  try {
    await t.press("2");
    await t.press("d");
    const lines = t.frame().split("\n");
    const heading = lines.find(
      (line) => line.includes("Page cache") && line.includes("Blocked"),
    );
    const row = lines.find((line) => line.includes("lane-a"));
    expect(heading).toBeDefined();
    expect(row).toBeDefined();
    if (!heading || !row) throw new Error("no heading and row to compare");
    const ends: [string, string][] = [
      ["Page cache", "1.0 KiB"],
      ["Read", "2.0 KiB/s"],
      ["Blocked", "3"],
      ["sccache", "4"],
    ];
    for (const [label, value] of ends)
      expect({
        label,
        ends: heading.indexOf(label) + label.length,
      }).toEqual({ label, ends: row.indexOf(value) + value.length });
  } finally {
    await t.close();
  }
});

test("a memory-reclaim card opens on the scope holding the swap", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const items = attention(s, c);
  const at = items.findIndex((item) => item.id === "system-memory");
  expect(at).toBeGreaterThan(-1);
  const t = await mount(s, c, { width: 160, height: 44 });
  try {
    await t.press("1");
    for (let i = 0; i < at; i++) await t.press("j");
    await t.press("enter");
    // The card's own text names the scope holding the most swap, so that is
    // the row it lands on. Carrying no group landed on whichever row
    // Resources already had selected, silently and without an error.
    expect(t.frame()).toContain("Groups");
    expect(selectedRow(t.frame())).toContain("gnome");
  } finally {
    await t.close();
  }
});

test("a target whose row has gone is said out loud, not dropped", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes = [volumeSnapshot("/data")];
  s.groups = [groupSnapshot({ path: "busy.scope", name: "busy.scope" })];
  /** One screen rendered with a target, reporting what it did with it. */
  async function landOn(screen: "storage" | "resources", target: string) {
    const notices: [string, string][] = [];
    let used = 0;
    const handlers = new Set<KeyHandler>();
    const props = {
      snapshot: s,
      config: c,
      target,
      onTargetUsed: () => {
        used += 1;
      },
      onNotice: (text: string, level: string) => notices.push([text, level]),
    };
    const ui = await testRender(
      <KeyProvider handlers={handlers}>
        {screen === "storage" ? (
          <Storage {...props} width={140} />
        ) : (
          <Resources {...props} width={140} height={30} />
        )}
      </KeyProvider>,
      { width: 140, height: 30 },
    );
    try {
      await ui.renderOnce();
      return { used, notices, frame: ui.captureCharFrame() };
    } finally {
      ui.renderer.destroy();
    }
  }
  // A collector refresh between the keypress and this effect can take the row
  // the card named. The request is still consumed, so it cannot fire again on
  // a later sample, and the reader is told rather than left on a screen that
  // looks like they never pressed anything.
  for (const screen of ["storage", "resources"] as const) {
    const gone = await landOn(screen, "/gone");
    expect({ screen, used: gone.used }).toEqual({ screen, used: 1 });
    expect({ screen, notices: gone.notices }).toEqual({
      screen,
      notices: [["/gone is no longer in the sample", "warn"]],
    });
  }
  // A row that is there is landed on, and says nothing.
  const found = await landOn("storage", "/data");
  expect(found.used).toBe(1);
  expect(found.notices).toEqual([]);
  expect(found.frame).toContain("/data");
});

test("an unstated pool size is not reported as an unreadable one", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", pids: [40], builds: { rustc: 1 } }),
  ];
  // A build process advertising a token pool whose flags carry no -j. Nothing
  // is read from the fifo, by design: reading it would take a token.
  s.procs = [
    processSnapshot({
      pid: 40,
      build: "rustc",
      env: { MAKEFLAGS: "--jobserver-auth=fifo:/tmp/pool" },
    }),
  ];
  // Wide enough that the tile draws the whole sentence rather than a cut one.
  const t = await mount(s, c, { width: 220, height: 30 });
  try {
    await t.press("4");
    const frame = t.frame();
    expect(frame).toContain("pool size not stated in the build flags");
    // The old wording sent a reader to look for a permissions problem that
    // never existed.
    expect(frame).not.toContain("not readable");
    expect(frame).not.toContain("from the fifo");
  } finally {
    await t.close();
  }
});

test("the copy notice does not claim a silent terminal empties the clipboard", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const items = attention(s, c);
  const at = items.findIndex((item) => item.command !== undefined);
  expect(at).toBeGreaterThan(-1);
  // The toast cuts at its own width rather than wrapping, so this is wide
  // enough to draw the clause the assertion is about.
  const t = await mount(s, c, { width: 200, height: 44 });
  try {
    await t.press("1");
    for (let i = 0; i < at; i++) await t.press("j");
    await t.press("y");
    const frame = t.frame();
    // A terminal that ignores the request leaves the clipboard alone. Saying
    // a paste gives nothing sends the reader to paste stale text believing it
    // is the command they just copied.
    expect(frame).toContain("leaves the clipboard unchanged");
    expect(frame).not.toContain("pastes nothing");
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

test("the linkers cell stays inside its column on the rendered Builds screen", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // Every default linker running at once. The raw reading is 59 columns, near
  // twice the 30 the heading reserves for it, so a cell that skipped the
  // column spec would run past the width its heading declares.
  s.lanes = [
    laneSnapshot({
      name: "lane-a",
      builds: Object.fromEntries(c.linkerNames.map((name) => [name, 1])),
    }),
  ];
  const t = await mount(s, c, { width: 140, height: 24 });
  try {
    await t.press("4");
    const lines = t.frame().split("\n");
    const heading = lines.find(
      (line) => line.includes("Building") && line.includes("Linkers"),
    );
    const row = lines.find((line) => line.includes("lane-a"));
    expect(heading).toBeDefined();
    expect(row).toBeDefined();
    if (!heading || !row) throw new Error("no heading and row to compare");
    const start = heading.indexOf("Linkers");
    const linkers = row.slice(start).trimEnd();
    // The cell starts where its heading starts and ends inside its width, the
    // cut marked, rather than spilling the rest of the list past the column.
    expect(row.indexOf("7 linkers")).toBe(start);
    expect(linkers.length).toBe(30);
    expect(linkers.endsWith("…")).toBe(true);
    expect(row).not.toContain("ld.bfd");
  } finally {
    await t.close();
  }
});
