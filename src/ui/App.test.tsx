import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { Config } from "../config/config";
import { defaults, validate } from "../config/config";
import type { LaneCommand } from "../model/actions";
import type { Snapshot } from "../model/types";
import { History } from "../store/history";
import { normalizeLane } from "../store/migrate";
import {
  emptySnapshot,
  everyCauseSnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
  volumeSnapshot,
} from "../test/fixture";
import { App, hints, Waiting } from "./App";
import { findLanes } from "./agents";
import { attention } from "./attention";
import { headerRowWidth, views } from "./chrome";
import { osc52 } from "./clipboard";
import { type HomeItem, homeItems, recentChanges } from "./home";
import { type KeyHandler, KeyProvider } from "./keys";
import { Resources } from "./resources";
import { Storage, volumesByDevice } from "./storage-screen";

/** One mounted App over a history, with the hooks a test asserts on. */
async function mount(
  s: Snapshot,
  c: Config,
  size = { width: 140, height: 35 },
  hooks: Partial<{
    onSave: (next: Config) => Promise<void>;
    onQuit: () => void;
    onAction: (command: LaneCommand) => Promise<void>;
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
    publish = setCurrent;
    return (
      <App
        snapshot={current}
        history={h}
        config={c}
        onSave={hooks.onSave ?? (async () => {})}
        onQuit={hooks.onQuit ?? (() => {})}
        onExport={async () => "snapshot.json"}
        onAction={hooks.onAction ?? (async () => {})}
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
      } else if (["up", "down", "left", "right"].includes(key))
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

test("Settings edits a value in place and honours a changed quit binding", async () => {
  const c = defaults();
  c.keys.quit = "alt+q";
  const s = emptySnapshot();
  let saved: Config | undefined;
  let quits = 0;
  const t = await mount(s, c, undefined, {
    onSave: async (next) => {
      saved = next;
    },
    onQuit: () => {
      quits++;
    },
  });
  try {
    await t.press("7");
    expect(t.frame()).toContain("Refresh interval");
    // The unreadable-sources row comes first; the refresh interval is the
    // last Display setting.
    for (let i = 0; i < 6; i++) await t.press("down");
    await t.press("enter");
    expect(t.frame()).toContain("Enter saves");
    await act(async () => {
      t.ui.mockInput.pressKey("END");
      for (let i = 0; i < 4; i++) t.ui.mockInput.pressBackspace();
    });
    await act(async () => {
      await t.ui.mockInput.typeText("500");
    });
    await t.press("enter");
    expect(saved?.refreshMs).toBe(500);
    // While the editor is open, a tab digit is text, never navigation.
    await t.press("enter");
    await act(async () => {
      await t.ui.mockInput.typeText("2");
    });
    await t.ui.renderOnce();
    expect(t.frame()).toContain("Enter saves");
    await t.press("escape");
    await act(async () => {
      t.ui.mockInput.pressKey("q", { meta: true });
    });
    expect(quits).toBe(1);
    await act(async () => {
      t.ui.mockInput.pressCtrlC();
    });
    expect(quits).toBe(2);
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

test("Home keeps the selected concern in view and opens its agent", async () => {
  const c = defaults();
  // One card per cause, so the list is grouped and still long enough to scroll.
  const s = everyCauseSnapshot(c);
  const t = await mount(s, c, { width: 80, height: 24 });
  try {
    await t.ui.renderOnce();
    const cards = attention(s, c);
    expect(cards.length).toBeGreaterThan(10);
    // Only the selected card shows its next step; the rest stay one row.
    expect(
      t
        .frame()
        .split("\n")
        .filter((row) => row.includes("Next")).length,
    ).toBe(1);
    for (let i = 0; i < cards.length - 1; i++) await t.press("down");
    expect(t.frame()).toContain("/scratch");
    expect(t.frame().split("\n")[0]).toContain("vsys");
    for (let i = 0; i < cards.length - 1; i++) await t.press("up");
    await t.press("enter");
    expect(t.frame()).toContain("escaped");
    expect(t.frame()).toContain("PID 40");
  } finally {
    await t.close();
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

test("Agents finds a worktree and clears the search without losing the list", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ name: "payments", cwd: "/work/acme/payment-service" }),
    laneSnapshot({ id: "other", name: "website", cwd: "/work/site" }),
  ];
  const t = await mount(s, c, { width: 80, height: 24 });
  try {
    await t.press("2");
    await t.press("/");
    await act(async () => {
      await t.ui.mockInput.typeText("ACME");
    });
    await t.press("enter");
    expect(t.frame()).toContain("payments");
    expect(t.frame()).not.toContain("website");
    await t.press("/");
    await act(async () => {
      t.ui.mockInput.pressEscape();
      await Bun.sleep(50);
    });
    await t.ui.renderOnce();
    expect(t.frame()).toContain("website");
  } finally {
    await t.close();
  }
});

test("agent detail names the account, the charged resources, the limits and the block", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({
      name: ".2claude claude %3 kendex",
      account: ".2claude",
      pane: "%3",
      cgroup: "agents.slice/a.scope",
      cache: 4096,
      readRate: 1048576,
      writeRate: 2097152,
      cpuShare: 25,
      builds: { rustc: 2, "ld.mold": 1 },
      linkers: 1,
      sccache: 3,
      memoryMax: 2147483648,
      cpuWeight: 50,
      jobs: 6,
      jobserver: "fifo:/tmp/f",
      state: "blocked",
      blocked: 2,
      blockedOn: "io",
    }),
  ];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 160, height: 45 });
  try {
    await t.press("2");
    await t.press("enter");
    const frame = t.frame();
    for (const text of [
      "a.scope",
      "account .2claude",
      "pane %3",
      "cache 4.0 KiB",
      "read 1.0 MiB/s",
      "2.0 MiB/s",
      "2 rustc, 1 ld.mold",
      "3 sccache clients",
      "memory 2.0 GiB",
      "CPU weight 50",
      "make jobs 6",
      "jobserver fifo:/tmp/f",
      "blocked: 2 tasks waiting on storage",
    ])
      expect(frame).toContain(text);
    // The process tree stays closed until the reader opens it.
    expect(frame).not.toContain("directory");
    await t.press("enter");
    expect(t.frame()).toContain("directory");
  } finally {
    await t.close();
  }
});

test("a lane record from an older build opens in agent detail without throwing", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    normalizeLane({
      id: "agents.slice/a.scope",
      name: "lane-a",
      mainPid: 40,
      pids: [40],
    }),
  ];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press("2");
    await t.press("enter");
    const frame = t.frame();
    expect(frame).toContain("PID 40");
    expect(frame).toContain("memory not available");
    expect(frame).toContain("none · 0 linking");
  } finally {
    await t.close();
  }
});

test("Storage opens with write totals and keeps filesystem state below them", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.groups = [
    groupSnapshot({
      path: ".",
      parent: ".",
      name: "user@1000.service",
      ioWrite: 2199023255552,
    }),
    groupSnapshot({
      path: "agents.slice",
      parent: ".",
      name: "agents.slice",
      ioWrite: 2199023255552,
    }),
  ];
  s.storage.devices = [
    { name: "nvme0n1", number: "259:0", model: null, lifetimeWritten: 1e13 },
  ];
  s.storage.deviceWrites = { "259:0": 2199023255552 };
  s.storage.volumes = [volumeSnapshot("/mnt/data", { readOnly: true })];
  const t = await mount(s, c, { width: 140, height: 45 });
  try {
    await t.press("5");
    const frame = t.frame();
    expect(frame).toMatch(/agents\.slice\s+█+\s+2\.0 TiB/);
    expect(frame).toMatch(/nvme0n1\s+█+\s+2\.0 TiB/);
    expect(frame).toContain("Drive lifetime writes");
    expect(frame).toContain("9.1 TiB");
    // Free space and read-only state stay, below what the drive has taken.
    expect(frame.indexOf("Written since boot")).toBeLessThan(
      frame.indexOf("Filesystems"),
    );
    expect(frame.indexOf("Filesystems")).toBeLessThan(
      frame.indexOf("read-only"),
    );
  } finally {
    await t.close();
  }
});

test("Timeline lists what changed with a cause instead of raw samples", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const later = emptySnapshot(2000);
  later.lanes = [
    laneSnapshot({ name: "lane-a", account: "work", unconfined: true }),
  ];
  h.add(later);
  const t = await mount(later, c, { width: 160, height: 40 }, { history: h });
  try {
    await t.press("6");
    const frame = t.frame();
    expect(frame).toContain("What changed  3, newest first");
    expect(frame).toMatch(/Lane started\s+lane-a/);
    expect(frame).toContain("account work in agents.slice");
    expect(frame).toMatch(/Alert opened\s+an agent ran outside/);
  } finally {
    await t.close();
  }
});

test("the Timeline change list stops at the rows the viewport has", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const busy = emptySnapshot(2000);
  busy.lanes = Array.from({ length: 12 }, (_, i) =>
    laneSnapshot({
      id: `lane-${i}.scope`,
      name: i === 0 ? `wide-${"x".repeat(400)}` : `lane-${i}`,
    }),
  );
  h.add(busy);
  const t = await mount(busy, c, { width: 160, height: 30 }, { history: h });
  try {
    await t.press("6");
    const frame = t.frame();
    // The heading counts what there is; the list says which of them it drew,
    // in the one place that knows, rather than in two that can disagree.
    expect(frame).toContain("What changed  12, newest first");
    expect(frame).toContain("1\u20136 of 12");
    expect(frame).toMatch(/Lane started\s+lane-5/);
    expect(frame).not.toContain("lane-11");
    // The cursor tiles summarise the six metrics, so a terminal too short for
    // both drops the sparkline rows rather than the change list.
    expect(frame).toContain("Memory wait");
    expect(frame).not.toMatch(/Memory wait\s+·/);
    // A 400-character subject takes one row and cannot push the rest out.
    expect(frame).not.toContain("xxxxxxxxxx\n");
    expect(frame).toContain("? keys");
  } finally {
    await t.close();
  }
});

test("an alert inside its hold does not mark a change on the strip", async () => {
  const c = defaults();
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const alarmed = emptySnapshot(2000);
  alarmed.alerts = [
    { time: 2000, rule: "scrub", subject: "/x", message: "Scrub problem: /x" },
  ];
  h.add(alarmed);
  const t = await mount(alarmed, c, { width: 160, height: 40 }, { history: h });
  try {
    await t.press("6");
    const frame = t.frame();
    expect(frame).toContain("Nothing changed in this window");
    // The rule fired, but no event holds yet, so the strip stays unmarked.
    // The strip is the row carrying the cursor mark, under the charts.
    const strip = frame.split("\n").find((row) => row.includes("▲"));
    expect(strip).toBeDefined();
    expect(strip).not.toContain("!");
  } finally {
    await t.close();
  }
});

test("Settings lists a missing capability and cards stay copy text", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  s.capabilities = s.capabilities.map((cap) =>
    cap.id === "psi"
      ? {
          ...cap,
          available: false,
          failure: "absent" as const,
          source: "/proc/pressure/cpu",
          detail: "ENOENT: no such file or directory",
        }
      : cap,
  );
  const t = await mount(s, c, { width: 200, height: 40 });
  try {
    await t.ui.renderOnce();
    // A remediation command is text the reader copies, never an action to run.
    const item = attention(s, c, ["/usr/bin"]).find(
      (i) => i.command !== undefined,
    );
    expect(item?.command).toBeDefined();
    expect(t.frame()).toContain(`Copy ${item?.command}`);
    await t.press("7");
    const settings = t.frame();
    expect(settings).toContain("Data sources  1 not available");
    expect(settings).toMatch(
      /○ Pressure stall information\s+no PSI on this kernel/,
    );
    expect(settings).toMatch(/● Resource groups \(cgroup v2\)\s+available/);
  } finally {
    await t.close();
  }
});

test("Settings opens on a snapshot stored before the capability probe", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // What History.at returns for a row an older build wrote.
  s.capabilities = [];
  const t = await mount(s, c, { width: 160, height: 40 });
  try {
    await t.press("7");
    const frame = t.frame();
    expect(frame).toContain("before vsys probed its sources");
    // The list shows the value in the unit the reader reads; the editor
    // still opens the stored number.
    expect(frame).toMatch(/Refresh interval\s+1s/);
    expect(frame).toMatch(/Low memory limit\s+1\.0 GiB/);
    expect(frame).toMatch(/Save history\s+Off/);
    expect(frame).toMatch(/Table columns\s+name, account, cwd, and 18 more/);
    expect(frame).not.toContain("not available");
  } finally {
    await t.close();
  }
});

test("Settings reports the running program while a past sample is pinned", async () => {
  const c = defaults();
  // A retained sample an older build wrote, and a live one that probed.
  const stored = emptySnapshot(1000);
  stored.capabilities = [];
  const live = emptySnapshot(2000);
  live.capabilities = live.capabilities.map((cap) =>
    cap.id === "psi"
      ? {
          ...cap,
          available: false,
          failure: "absent" as const,
          source: "/proc/pressure/cpu",
          detail: "ENOENT: no such file or directory",
        }
      : cap,
  );
  const h = new History(c);
  h.add(stored);
  const t = await mount(live, c, { width: 160, height: 40 }, { history: h });
  try {
    await t.press("p");
    expect(t.frame()).toContain("show ");
    await t.press("7");
    expect(t.frame()).toContain("no PSI on this kernel");
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

test("the copy key puts the selected card's command on the clipboard", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const items = attention(s, c);
  const index = items.findIndex((item) => item.command !== undefined);
  const command = items[index].command;
  const t = await mount(s, c, { width: 160, height: 45 });
  try {
    for (let i = 0; i < index; i++) await t.press("j");
    await t.press("y");
    expect(t.written).toEqual([osc52(command ?? "")]);
    // The notice names where the text went and what silence means, because
    // OSC 52 is a request to the terminal that vsys cannot confirm.
    expect(t.frame()).toContain("Copied to the clipboard");
    expect(t.frame()).toContain("OSC 52");
    // A card with no command copies nothing rather than an empty clipboard.
    const bare = items.findIndex((item) => item.command === undefined);
    expect(bare).toBeGreaterThanOrEqual(0);
    for (let i = index; i < bare; i++) await t.press("j");
    await t.press("y");
    expect(t.written.length).toBe(1);
    expect(t.frame()).toContain("no command to copy");
  } finally {
    await t.close();
  }
});

/** Opens one agent, opens its Actions section and selects Stop. */
async function stopSelected(c: Config, calls: LaneCommand[]) {
  const s = emptySnapshot();
  s.lanes = [laneSnapshot()];
  s.groups = [groupSnapshot()];
  const t = await mount(
    s,
    c,
    { width: 160, height: 45 },
    {
      onAction: async (command) => {
        calls.push(command);
      },
    },
  );
  await t.press("2");
  await t.press("enter");
  // Processes, Launch and Open files sit above Actions; opening it adds its
  // three rows below, and Stop is the last of them.
  for (let i = 0; i < 3; i++) await t.press("j");
  await t.press("enter");
  for (let i = 0; i < 3; i++) await t.press("j");
  return { ...t, snapshot: s };
}
const stopCommand = "systemctl --user kill --signal=TERM a.scope";

test("with write mode off an agent action is copy text and signals nothing", async () => {
  const calls: LaneCommand[] = [];
  const t = await stopSelected(defaults(), calls);
  try {
    expect(t.frame()).toContain("Write mode is off");
    expect(t.frame()).toContain(stopCommand);
    await t.press("enter");
    expect(calls).toEqual([]);
    expect(t.frame()).not.toContain("Confirm");
    await t.press("y");
    expect(t.written).toEqual([osc52(stopCommand)]);
  } finally {
    await t.close();
  }
});

test("a lane that changes under an open confirmation takes nothing", async () => {
  const calls: LaneCommand[] = [];
  const t = await stopSelected({ ...defaults(), writeMode: true }, calls);
  try {
    await t.press("enter");
    expect(t.frame()).toContain("Stop a.scope?");
    // Samples keep landing while the question stands. This one says the lane
    // the reader confirmed is gone and another process holds its scope name.
    await t.update({
      ...t.snapshot,
      lanes: [laneSnapshot({ mainPid: 41 })],
    });
    expect(t.frame()).toContain("Stop a.scope?");
    await t.press("enter");
    const frame = t.frame();
    expect(frame).toContain("Another process holds a.scope now");
    expect(frame).toContain("nothing ran");
    expect(calls).toEqual([]);
  } finally {
    await t.close();
  }
});

test("an action on a pinned sample is refused with the reason, not run", async () => {
  const calls: LaneCommand[] = [];
  const t = await stopSelected({ ...defaults(), writeMode: true }, calls);
  try {
    await t.press("p");
    expect(t.frame()).toContain("Agents, Resources, Builds and Storage show");
    await t.press("enter");
    // The pinned lane's scope is a name from the past. Acting on it would
    // freeze or signal whatever holds that name now.
    const frame = t.frame();
    expect(frame).toContain("Pinned sample · a.scope may be gone");
    expect(frame).toContain("or its name reused");
    expect(frame).not.toContain("Stop a.scope?");
    expect(calls).toEqual([]);
    // Returning to live data restores the action.
    await t.press("p");
    await t.press("enter");
    expect(t.frame()).toContain("Stop a.scope?");
  } finally {
    await t.close();
  }
});

test("with write mode on an agent action names its scope and waits for a yes", async () => {
  const calls: LaneCommand[] = [];
  const t = await stopSelected({ ...defaults(), writeMode: true }, calls);
  try {
    await t.press("enter");
    const frame = t.frame();
    expect(frame).toContain("Confirm");
    expect(frame).toContain("Stop a.scope?");
    expect(frame).toContain(stopCommand);
    expect(calls).toEqual([]);
    // Anything but the open key answers no.
    await t.press("k");
    expect(t.frame()).not.toContain("Stop a.scope?");
    expect(calls).toEqual([]);
    await t.press("enter");
    // A sample landing under the question is the ordinary case: the lane is
    // the same lane, so the confirmed line still runs.
    await t.update({ ...t.snapshot, lanes: [laneSnapshot()] });
    await t.press("enter");
    expect(calls.map((command) => command.text)).toEqual([stopCommand]);
    expect(calls[0].effect).toEqual({
      kind: "run",
      argv: ["systemctl", "--user", "kill", "--signal=TERM", "a.scope"],
    });
  } finally {
    await t.close();
  }
});

test("a numeric column ends where its heading ends, on the rendered screen", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a", cpu: 5, rss: 1024, pressure: 12 })];
  const t = await mount(s, c, { width: 140, height: 24 });
  try {
    await t.press("2");
    const lines = t.frame().split("\n");
    const heading = lines.find(
      (line) => line.includes("Agent") && line.includes("Memory"),
    );
    const row = lines.find((line) => line.includes("lane-a"));
    expect(heading).toBeDefined();
    expect(row).toBeDefined();
    if (!heading || !row) throw new Error("no heading and row to compare");
    // Right-aligned cells and their headings share a last column, which is
    // what one shared column spec buys.
    const rows: [string, string][] = [
      ["CPU", "5.0%"],
      ["Memory", "1.0 KiB"],
      ["Wait", "12.0%"],
    ];
    for (const [label, value] of rows)
      expect({
        label,
        heading: heading.indexOf(label) + label.length,
      }).toEqual({ label, heading: row.indexOf(value) + value.length });
  } finally {
    await t.close();
  }
  // The narrower terminal keeps every column inside the panel: the last one
  // is reached, not cut off the right edge.
  const tight = await mount(s, c, { width: 100, height: 24 });
  try {
    await tight.press("2");
    const line = tight
      .frame()
      .split("\n")
      .find((row) => row.includes("lane-a"));
    expect(line).toContain("sleeping");
    expect(line?.length).toBe(100);
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

test("a wide terminal puts the concerns and the agents side by side", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const wide = await mount(s, c, { width: 180, height: 44 });
  try {
    await wide.press("1");
    const heading = wide
      .frame()
      .split("\n")
      .find((line) => line.includes("Needs attention"));
    // One row carries two headings, so the columns sit beside each other:
    // what is wrong now on the left, what happened and who is busy on the right.
    expect(heading).toContain("Recent changes");
    expect(wide.frame()).toContain("Busiest agents");
  } finally {
    await wide.close();
  }
  // Below the width they stack, and the headings sit on separate rows.
  const tall = await mount(s, c, { width: 120, height: 44 });
  try {
    await tall.press("1");
    const lines = tall.frame().split("\n");
    const heading = lines.find((line) => line.includes("Needs attention"));
    expect(heading).not.toContain("Recent changes");
    expect(lines.some((line) => line.includes("Recent changes"))).toBe(true);
    expect(lines.some((line) => line.includes("Busiest agents"))).toBe(true);
  } finally {
    await tall.close();
  }
});

test("a wide Agents list carries the selected agent beside it", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", cwd: "/repo/one" }),
    laneSnapshot({ id: "b", name: "lane-b", cwd: "/repo/two" }),
  ];
  s.groups = [groupSnapshot()];
  const wide = await mount(s, c, { width: 180, height: 30 });
  try {
    await wide.press("2");
    const frame = wide.frame();
    // The pane names the selected agent beside the list, so a row can be read
    // against what it means without opening it.
    expect(frame).toContain("Selected");
    expect(frame).toContain("/repo/one");
    expect(frame).not.toContain("/repo/two");
    await wide.press("j");
    expect(wide.frame()).toContain("/repo/two");
  } finally {
    await wide.close();
  }
  // Below the width the list keeps the whole panel.
  const narrow = await mount(s, c, { width: 120, height: 30 });
  try {
    await narrow.press("2");
    expect(narrow.frame()).not.toContain("Selected");
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

test("Settings filters by name and by the label the reader sees", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const t = await mount(s, c, { width: 180, height: 40 });
  try {
    await t.press("7");
    expect(t.frame()).toContain("Storage units");
    // "wait" appears in no setting's stored name; it is what the labels say.
    await t.press("/");
    for (const ch of "wait") await t.press(ch);
    const byLabel = t.frame();
    expect(byLabel).toContain("Wait warning");
    expect(byLabel).toContain("Wait before alert");
    expect(byLabel).not.toContain("Storage units");
    // The stored name finds it too, not only the label.
    await t.press("escape");
    await t.press("/");
    for (const ch of "swapfloor") await t.press(ch);
    const byKey = t.frame();
    expect(byKey).toContain("Desktop swap warning");
    expect(byKey).not.toContain("Wait warning");
  } finally {
    await t.close();
  }
});

/** Seven tabs of equal width, so a predicate that multiplies the widest tab
 * instead of summing them all reads exactly the gap columns short. */
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

test("a filtered Settings list opens the row the highlight is on", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press("7");
    await t.press("/");
    for (const ch of "wait") await t.press(ch);
    // Enter closes the find box and keeps the query, so the list is filtered
    // and the first match carries the highlight.
    await t.press("enter");
    await t.press("enter");
    // The editor is titled with the setting it edits, so its presence names
    // the row Enter actually opened.
    const frame = t.frame();
    expect(frame).toContain("Wait warning");
    expect(frame).toContain("Enter saves");
    expect(frame).not.toContain("Storage units");
  } finally {
    await t.close();
  }
});

/** The row a screen marks as selected, without its marker. */
function selectedRow(frame: string): string {
  const line = frame.split("\n").find((row) => row.includes("▍"));
  return (line ?? "").replace("▍", "").trim();
}

test("opening a concern lands on the row the card names", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const items = attention(s, c);
  const t = await mount(s, c, { width: 160, height: 44 });
  try {
    await t.press("1");
    // The scratch card names /scratch and opens Storage on it.
    const at = items.findIndex((item) => item.id === "scratch");
    expect(at).toBeGreaterThan(-1);
    for (let i = 0; i < at; i++) await t.press("j");
    await t.press("enter");
    expect(t.frame()).toContain("Written since boot");
    expect(selectedRow(t.frame())).toContain("/scratch");
  } finally {
    await t.close();
  }
  // The memory-threshold card names a group and opens Resources on it.
  const g = await mount(s, c, { width: 160, height: 44 });
  try {
    await g.press("1");
    const at = items.findIndex((item) => item.id === "memory-high");
    for (let i = 0; i < at; i++) await g.press("j");
    await g.press("enter");
    expect(g.frame()).toContain("Groups");
    expect(selectedRow(g.frame())).toContain("h");
  } finally {
    await g.close();
  }
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

test("the agent detail names only its own keys, and the list gets its back", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a" })];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 160, height: 30 });
  try {
    const footer = () => t.frame().split("\n").at(-2) ?? "";
    // The agent detail takes neither the list's find nor its table key, and
    // it is a screen the reader can leave, so it says how.
    await t.press("2");
    expect(footer()).toContain("find");
    expect(footer()).toContain("table");
    await t.press("enter");
    const detail = footer();
    expect(detail).not.toContain("find");
    expect(detail).not.toContain("table");
    expect(detail).toContain("copy");
    expect(detail).toContain("back");
    // Back to the list restores the list's own keys.
    await t.press("escape");
    expect(footer()).toContain("find");
  } finally {
    await t.close();
  }
});

test("a query that matches nothing leaves Enter with nothing to open", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press("7");
    await t.press("/");
    for (const ch of "zzzz") await t.press(ch);
    await t.press("enter");
    // No row is selected, so Enter opens nothing rather than reading past the
    // end of the list. The read past the end throws inside the key emitter,
    // which swallows it, so what this pins is the list the render walks: the
    // sources row is not a setting, the filter drops it from `items`, and a
    // render driven by `items` therefore does not draw it either. While it
    // was drawn from a counter beside the list, it stayed on screen holding
    // the highlight that belonged to a row further down.
    await t.press("enter");
    const frame = t.frame();
    expect(frame).toContain("Data sources");
    expect(frame).not.toContain("Every source was read");
    expect(frame).not.toContain("Enter saves");
    expect(frame).not.toContain("Storage units");
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

test("a mount's detail does not repeat the device row's error counters", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes = [
    volumeSnapshot("/data", {
      device: "/dev/nvme0n1p2",
      errors: { "nvme0n1p2/corruption_errs": 3 },
      options: ["rw", "subvol=@data"],
    }),
  ];
  const t = await mount(s, c, { width: 140, height: 30 });
  try {
    await t.press("5");
    const frame = t.frame();
    // The device row states the counters once for every mount grouped under
    // it. The mount below it carries only what differs between mounts.
    expect(frame.split("corruption 3").length - 1).toBe(1);
    expect(frame).toContain("subvol=@data");
    expect(frame).not.toContain("Errors");
  } finally {
    await t.close();
  }
});

test("the device error counters are legible at a hundred columns", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.storage.volumes = [
    volumeSnapshot("/data", {
      device: "/dev/nvme0n1p2",
      errors: { "nvme0n1p2/corruption_errs": 3 },
      // A counter that rose since the last sample turns the row red, so this
      // reading is the one the colour is telling the reader to go and find.
      delta: { "nvme0n1p2/corruption_errs": 1 },
      options: ["rw", "subvol=@data"],
    }),
  ];
  const t = await mount(s, c, { width: 100, height: 30 });
  try {
    await t.press("5");
    const frame = t.frame();
    // The device row's own columns fill a terminal this narrow, so the
    // counters wrap onto a line of their own. They are the reading behind the
    // row's colour, and since the mount detail stopped repeating them, the
    // only copy of it.
    expect(frame).toContain("corruption 3 (+1)");
    expect(frame.split("corruption 3").length - 1).toBe(1);
  } finally {
    await t.close();
  }
});

test("leaving an agent returns to the list with that agent selected", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", cpu: 9 }),
    laneSnapshot({ id: "b", name: "lane-b", cpu: 5 }),
    laneSnapshot({ id: "z", name: "lane-z", cpu: 1 }),
  ];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 120, height: 30 });
  try {
    await t.press("2");
    await t.press("j");
    await t.press("enter");
    expect(t.frame()).toContain("lane-b");
    await t.press("escape");
    expect(selectedRow(t.frame())).toContain("lane-b");
    // A lane opened from Home was never selected in the list, and going back
    // still lands on it rather than on the first row.
    await t.press("1");
    await t.press("j");
    await t.press("j");
    await t.press("enter");
    await t.press("escape");
    expect(selectedRow(t.frame())).toContain("lane-z");
  } finally {
    await t.close();
  }
});

test("Home opens with the most urgent row selected", async () => {
  const c = defaults();
  const busy = everyCauseSnapshot(c);
  const t = await mount(busy, c, { width: 160, height: 44 });
  try {
    await t.press("1");
    // With a concern open, the selection is that concern, not an agent. The
    // two columns share a row, so the line carries the agent heading too.
    expect(selectedRow(t.frame())).toContain(attention(busy, c)[0].title);
  } finally {
    await t.close();
  }
  const calm = emptySnapshot();
  calm.lanes = [
    laneSnapshot({ id: "slow", name: "lane-slow", cpu: 1 }),
    laneSnapshot({ id: "busy", name: "lane-busy", cpu: 90 }),
  ];
  const quiet = await mount(calm, c, { width: 160, height: 44 });
  try {
    await quiet.press("1");
    expect(attention(calm, c)).toEqual([]);
    expect(quiet.frame()).toContain("Healthy");
    expect(selectedRow(quiet.frame())).toContain("lane-busy");
  } finally {
    await quiet.close();
  }
  // Between the two: no concern, but something changed. The change is what
  // the reader has not seen, so it is what the selection opens on.
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const moved = { ...calm, time: 2000 };
  h.add(moved);
  const changed = await mount(
    moved,
    c,
    { width: 160, height: 44 },
    {
      history: h,
    },
  );
  try {
    await changed.press("1");
    expect(attention(moved, c)).toEqual([]);
    expect(selectedRow(changed.frame())).toContain("Lane started");
    expect(selectedRow(changed.frame())).not.toContain("lane-busy ");
  } finally {
    await changed.close();
  }
});

test("the arrow keys reach the tiles and open the screen behind one", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a" })];
  s.groups = [groupSnapshot()];
  const rows: [number, string][] = [
    // CPU and Memory break down under Resources, Disk under Storage, Builds
    // under Builds.
    [0, "Groups"],
    [1, "Groups"],
    [2, "Written since boot"],
    [3, "Lanes building"],
  ];
  for (const [tile, lands] of rows) {
    const t = await mount(s, c, { width: 160, height: 30 });
    try {
      await t.press("1");
      for (let i = 0; i <= tile; i++) await t.press("right");
      await t.press("enter");
      expect({ tile, on: t.frame().includes(lands) }).toEqual({
        tile,
        on: true,
      });
    } finally {
      await t.close();
    }
  }
  // Up or down leaves the tiles, so Enter opens a row again rather than a
  // screen behind a tile.
  const back = await mount(s, c, { width: 160, height: 30 });
  try {
    await back.press("1");
    await back.press("right");
    await back.press("down");
    await back.press("enter");
    expect(back.frame()).toContain("lane-a");
    expect(back.frame()).not.toContain("Groups");
  } finally {
    await back.close();
  }
});

test("a tile in a narrow pane marks its cut instead of stopping mid-word", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a", cpu: 12.3, cpuShare: 12.3 })];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 180, height: 30 });
  try {
    await t.press("2");
    // The preview pane's tiles are a third of the screen, so their sentences
    // do not fit; a cut with no mark reads as a sentence that simply ended.
    const line = t
      .frame()
      .split("\n")
      .find((row) => row.includes("of one core"));
    expect(line).toBeDefined();
    expect(line).toContain("…");
  } finally {
    await t.close();
  }
});

test("the cursor readings are tiles, one quantity above each number", async () => {
  const c = defaults();
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const s = emptySnapshot(2000);
  s.system.pressure.cpu = { some: 12, full: 0, total: 0 };
  h.add(s);
  const t = await mount(s, c, { width: 180, height: 44 }, { history: h });
  try {
    await t.press("6");
    const lines = t.frame().split("\n");
    // Six readings on one row joined by dots is a run to parse; each now
    // names its quantity on the row above its own number.
    const labels = lines.findIndex(
      (line) => line.includes("CPU wait") && line.includes("Disk wait"),
    );
    expect(labels).toBeGreaterThan(-1);
    expect(lines[labels + 1]).toContain("12.0%");
    expect(t.frame()).not.toMatch(/cpu wait 12\.0% ·/);
  } finally {
    await t.close();
  }
  // No sample under the cursor says so rather than printing a row of dots.
  const bare = new History(c);
  const empty = emptySnapshot(1000);
  const b = await mount(
    empty,
    c,
    { width: 180, height: 44 },
    { history: bare },
  );
  try {
    await b.press("6");
    expect(b.frame()).toContain("No sample under the cursor");
  } finally {
    await b.close();
  }
});

test("the table's cells land under their headings, not beside them", async () => {
  // Sorted by name, so the compared headings carry no sort marker of their own.
  const c = {
    ...defaults(),
    columns: ["name", "cpu", "rss", "state"],
    sort: "name",
  };
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a", cpu: 5, rss: 1024 })];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 160, height: 24 });
  try {
    await t.press("2");
    await t.press("d");
    const lines = t.frame().split("\n");
    const heading = lines.find(
      (line) => line.includes("Agent") && line.includes("Memory"),
    );
    const row = lines.find((line) => line.includes("lane-a"));
    expect(heading).toBeDefined();
    expect(row).toBeDefined();
    if (!heading || !row) throw new Error("no heading and row to compare");
    // The heading and the row read one spec, so a numeric cell ends where its
    // heading ends whatever the widths are.
    for (const [label, value] of [
      ["CPU", "5.0%"],
      ["Memory", "1.0 KiB"],
    ] as const)
      expect({
        label,
        ends: heading.indexOf(label) + label.length,
      }).toEqual({ label, ends: row.indexOf(value) + value.length });
  } finally {
    await t.close();
  }
});

test("an agent that leaves the sample offers only the key its screen acts on", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", cpu: 9 }),
    laneSnapshot({ id: "b", name: "lane-b", cpu: 5 }),
  ];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 140, height: 30 });
  const footer = () => t.frame().split("\n").at(-2) ?? "";
  try {
    await t.press("2");
    await t.press("enter");
    expect(footer()).toContain("copy");
    // The process exits. What stays on screen is one sentence saying so.
    await t.update({ ...s, lanes: [s.lanes[1]] });
    expect(t.frame()).toContain("no longer in the sample");
    // That screen acts on Back and nothing else, so nothing else is offered.
    const gone = footer();
    expect(gone).toContain("back");
    expect(gone).not.toContain("copy");
    expect(gone).not.toContain("select");
    expect(gone).not.toContain("open");
    // The key it does offer works, and the list's own hints come back.
    await t.press("escape");
    expect(t.frame()).not.toContain("no longer in the sample");
    expect(footer()).toContain("find");
  } finally {
    await t.close();
  }
});

test("a Timeline with no sample under the cursor budgets the line it draws", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // A history with nothing in it: vsys started a moment ago, so no sample
  // sits under the cursor and the readings are one line, not a tile block.
  const t = await mount(
    s,
    c,
    { width: 100, height: 29 },
    { history: new History(c) },
  );
  try {
    await t.press("6");
    const frame = t.frame();
    expect(frame).toContain("No sample under the cursor.");
    // Budgeting the tile block instead of that line costs four rows, which is
    // enough at this height to drop the sparklines and leave their space
    // empty. Each row is one metric, and they are what the reader loses.
    for (const label of [
      "CPU wait",
      "Memory wait",
      "Disk wait",
      "Builds",
      "Escaped",
      "Corruption",
    ])
      expect({ label, drawn: frame.includes(label) }).toEqual({
        label,
        drawn: true,
      });
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

test("a tile opens live data, not the sample the reader pinned", async () => {
  const c = defaults();
  const h = new History(c);
  const s = emptySnapshot(1000);
  s.groups = [
    groupSnapshot({ path: "busy.scope", name: "busy.scope", cpuPercent: 50 }),
  ];
  h.add(s);
  const t = await mount(s, c, { width: 160, height: 40 }, { history: h });
  try {
    await t.press("6");
    await t.press("p");
    // Timeline is not one of the pinned screens, so it says which ones are.
    expect(t.frame()).toContain("Agents, Resources, Builds and Storage show");
    await t.press("1");
    await t.press("right");
    await t.press("enter");
    // A tile drills down like a card does, so it clears the pin. Landing on
    // Resources with the pin still set would show the pinned sample beside a
    // Home that was live.
    expect(t.frame()).toContain("Groups");
    expect(t.frame().split("\n")[0]).toContain("● live");
  } finally {
    await t.close();
  }
});

/**
 * A history holding a lane start, then a quiet sample after it. The change is
 * older than the newest sample, so the cursor a change asks for is not the
 * cursor the screen would take on its own.
 */
function withChange(c: Config) {
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const change = emptySnapshot(2000);
  change.lanes = [laneSnapshot({ id: "a", name: "lane-a" })];
  h.add(change);
  const latest = { ...change, time: 3000 };
  h.add(latest);
  return { h, snapshot: latest };
}

test("Home lists what changed and opening one lands on Timeline at that moment", async () => {
  const c = defaults();
  const { h, snapshot } = withChange(c);
  const t = await mount(
    snapshot,
    c,
    { width: 180, height: 44 },
    { history: h },
  );
  try {
    await t.press("1");
    const frame = t.frame();
    expect(frame).toContain("Recent changes");
    expect(frame).toContain("Lane started");
    // The newest change is the first row of the section.
    const rows = frame.split("\n");
    const first = rows.findIndex((row) => row.includes("Recent changes"));
    expect(rows[first + 1]).toContain("Lane started");
    // With no concern open, the newest change is the selected row already.
    await t.press("enter");
    const timeline = t.frame();
    expect(timeline).toContain("What changed");
    // The cursor sits on the change, not on the newest sample it would take.
    expect(timeline).toContain(`cursor ${new Date(2000).toLocaleString()}`);
    expect(timeline).not.toContain(`cursor ${new Date(3000).toLocaleString()}`);
    expect(selectedRow(timeline)).toContain(
      new Date(2000).toLocaleTimeString(),
    );
  } finally {
    await t.close();
  }
});

test("the Timeline change list is driven from the keyboard, not the mouse alone", async () => {
  const c = defaults();
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const busy = emptySnapshot(5000);
  busy.lanes = [1, 2, 3].map((n) =>
    laneSnapshot({ id: `lane-${n}`, name: `lane-${n}` }),
  );
  h.add(busy);
  // A quiet sample after the changes, so the cursor Enter sets differs from
  // the one the screen takes on its own.
  const latest = { ...busy, time: 9000 };
  h.add(latest);
  const t = await mount(latest, c, { width: 180, height: 44 }, { history: h });
  try {
    await t.press("6");
    const first = selectedRow(t.frame());
    expect(first).toContain("Lane started");
    // Down moves the selection to the next change, and up moves it back.
    await t.press("j");
    const second = selectedRow(t.frame());
    expect(second).toContain("Lane started");
    expect(second).not.toBe(first);
    await t.press("k");
    expect(selectedRow(t.frame())).toBe(first);
    // Enter moves the time cursor onto the selected change.
    expect(t.frame()).toContain(`cursor ${new Date(9000).toLocaleString()}`);
    await t.press("enter");
    expect(t.frame()).toContain(`cursor ${new Date(5000).toLocaleString()}`);
    // The pin key still pins from this screen, so a row can be pinned.
    await t.press("p");
    expect(t.frame()).toMatch(/Agents, Resources, Builds and Storage show/);
  } finally {
    await t.close();
  }
});

test("a lane that exits while open leaves the list on a row that exists", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", cpu: 9 }),
    laneSnapshot({ id: "b", name: "lane-b", cpu: 5 }),
    laneSnapshot({ id: "z", name: "lane-z", cpu: 1 }),
  ];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 160, height: 40 });
  try {
    await t.press("2");
    await t.press("j");
    await t.press("j");
    await t.press("enter");
    expect(t.frame()).toContain("lane-z");
    // The process exits while its detail is open.
    await t.update({ ...s, lanes: s.lanes.slice(0, 2) });
    expect(t.frame()).toContain("no longer in the sample");
    await t.press("escape");
    // Back in the list, the row number the reader left on names nothing. A
    // row that exists takes the highlight, and Enter opens that row rather
    // than finding no lane at all.
    expect(selectedRow(t.frame())).toContain("lane-b");
    await t.press("enter");
    const footer = t.frame().split("\n").at(-2) ?? "";
    expect(footer).toContain("back");
    expect(footer).not.toContain("find");
    expect(t.frame()).toContain("lane-b");
  } finally {
    await t.close();
  }
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

test("Home marks one focus at a time, on every kind of row it lists", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  // A sample with all three row types on screen at once: concerns, a change,
  // and agents. The rule was written at each render site, so it reached two of
  // the three and the test that named it used only a concern.
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const s = everyCauseSnapshot(c);
  s.time = 2000;
  h.add(s);
  const rows = homeItems(
    attention(s, c),
    s,
    5,
    h.events(s.time, c.historyHours * 3600000),
  );
  const kinds = ["concern", "change", "agent"] as const;
  for (const kind of kinds)
    expect({ kind, present: rows.some((row) => row.kind === kind) }).toEqual({
      kind,
      present: true,
    });
  for (const kind of kinds) {
    const at = rows.findIndex((row) => row.kind === kind);
    const t = await mount(s, c, { width: 160, height: 44 }, { history: h });
    try {
      await t.press("1");
      for (let i = 0; i < at; i++) await t.press("j");
      // The rows hold the focus, so this row is marked.
      expect({ kind, marked: selectedRow(t.frame()) !== "" }).toEqual({
        kind,
        marked: true,
      });
      // Moving onto a tile takes the focus with it. A row marked here would
      // say one thing while Enter opened another.
      await t.press("right");
      expect({ kind, marked: selectedRow(t.frame()) !== "" }).toEqual({
        kind,
        marked: false,
      });
      // And moving back off the tiles restores it.
      await t.press("down");
      expect({ kind, marked: selectedRow(t.frame()) !== "" }).toEqual({
        kind,
        marked: true,
      });
    } finally {
      await t.close();
    }
  }
  // The selected concern's detail follows the same rule, and so does copy:
  // while a tile holds the focus there is no row for either to act on.
  const t = await mount(s, c, { width: 160, height: 44 }, { history: h });
  try {
    await t.press("1");
    expect(t.frame()).toContain("Next ");
    await t.press("right");
    expect(t.frame()).not.toContain("Next ");
    await t.press("y");
    expect(t.frame()).toContain("no command to copy");
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

test("a card that names no agent opens the list, not the agent left open", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const items = attention(s, c);
  // This card points at Agents and names no lane: several lanes wait for CPU
  // and no one row is the answer.
  const at = items.findIndex((item) => item.id === "system-cpu");
  expect(at).toBeGreaterThan(-1);
  expect(items[at].target).toBeUndefined();
  const t = await mount(s, c, { width: 160, height: 44 });
  const footer = () => t.frame().split("\n").at(-2) ?? "";
  try {
    // Open an agent and leave it by its tab rather than by going back, so the
    // detail is still what Agents would render.
    await t.press("2");
    await t.press("enter");
    expect(footer()).toContain("back");
    expect(footer()).not.toContain("find");
    await t.press("1");
    for (let i = 0; i < at; i++) await t.press("j");
    await t.press("enter");
    // The card named the list. The agent left open would render its own
    // detail here, which is a screen the card never pointed at.
    expect(footer()).toContain("find");
    expect(footer()).toContain("table");
    expect(t.frame()).toContain("Agent");
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

test("a change about a cgroup reads as a name, with the unit under the selection", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  const first = everyCauseSnapshot(c);
  first.groups = first.groups.map((g) =>
    g.name === "gnome.scope"
      ? { ...g, name: "app-Hyprland-ghostty-b95bd288.scope" }
      : g,
  );
  h.add(first);
  h.add({ ...first, time: first.time + 1000 });
  const t = await mount(
    { ...first, time: first.time + 1000 },
    c,
    { width: 180, height: 44 },
    { history: h },
  );
  try {
    await t.press("6");
    const frame = t.frame();
    // systemd's own name never reaches the row.
    expect(frame).not.toContain("app-Hyprland-ghostty");
    expect(frame).toContain("ghostty");
    // The raw unit is one keystroke away, under the row that decoded it.
    const at = t
      .frame()
      .split("\n")
      .findIndex((row) => row.includes("the desktop swapped out"));
    expect(at).toBeGreaterThan(-1);
    const heading = t
      .frame()
      .split("\n")
      .findIndex((row) => row.includes("What changed"));
    for (let i = heading + 1; i < at; i++) await t.press("j");
    expect(t.frame()).toContain("app-Hyprland-ghostty-b95bd288.scope");
  } finally {
    await t.close();
  }
});

test("the recap holds what happened while the reader was away for longer than the window", async () => {
  const c = defaults();
  const h = new History(c);
  h.add(emptySnapshot(1000));
  // A lane starts, and then half an hour passes with nothing further. The
  // default Timeline window is five minutes, so this change is outside it.
  const started = emptySnapshot(2000);
  started.lanes = [laneSnapshot({ id: "a.scope", name: "lane-a" })];
  h.add(started);
  // The lane keeps running, so the start is the only change there is and it
  // is half an hour old. Stopping it would put a fresh event in the window
  // and the recap would look right for the wrong reason.
  const later = { ...started, time: 2000 + 30 * 60000 };
  h.add(later);
  const t = await mount(later, c, { width: 160, height: 44 }, { history: h });
  try {
    await t.press("1");
    const frame = t.frame();
    // The section is for the reader who was away. Sourcing it from the window
    // told them nothing had changed while the change sat in history.
    expect(frame).not.toContain("Nothing has changed");
    expect(frame).toContain("lane-a");
    // And opening that row lands on it, which needs a window wide enough to
    // hold it: the five-minute window does not contain it at all.
    const at = t
      .frame()
      .split("\n")
      .findIndex((row) => row.includes("Recent changes"));
    expect(at).toBeGreaterThan(-1);
    const rows = t.frame().split("\n");
    const row = rows.findIndex((line, i) => i > at && line.includes("lane-a"));
    expect(row).toBeGreaterThan(-1);
    for (let i = 0; i < row - at - 1; i++) await t.press("j");
    await t.press("enter");
    const timeline = t.frame();
    expect(timeline).toContain("What changed");
    expect(selectedRow(timeline)).toContain("lane-a");
  } finally {
    await t.close();
  }
});

test("the Timeline selection stays on a row the reader can see", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const busy = emptySnapshot(2000);
  busy.lanes = Array.from({ length: 12 }, (_, i) =>
    laneSnapshot({ id: `lane-${i}.scope`, name: `lane-${i}` }),
  );
  h.add(busy);
  const t = await mount(busy, c, { width: 160, height: 30 }, { history: h });
  try {
    await t.press("6");
    // Walk the selection past the fold. The list pages around it, so the
    // highlighted row is drawn wherever the selection sits; a fixed slice let
    // it walk off the end of what was drawn.
    for (let i = 0; i < 11; i++) await t.press("j");
    const frame = t.frame();
    expect(selectedRow(frame)).not.toBe("");
    expect(selectedRow(frame)).toContain("lane-11");
    // And Enter acts on the row that is marked, not on one off-screen.
    await t.press("enter");
    expect(t.frame()).toContain("What changed");
    expect(selectedRow(t.frame())).toContain("lane-11");
  } finally {
    await t.close();
  }
});

test("no alerts opened reads as a count, not as a missing one", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a" })];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 160, height: 44 });
  try {
    await t.press("1");
    // Nothing has gone wrong, so the count is zero. A zero that renders as
    // absence cannot be told from a count vsys never took.
    expect(t.frame()).toContain("0 alerts opened since vsys started");
  } finally {
    await t.close();
  }
});

test("Home counts the alerts that open while it runs", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  const quiet = emptySnapshot(1000);
  h.add(quiet);
  const t = await mount(quiet, c, { width: 160, height: 44 }, { history: h });
  try {
    await t.press("1");
    // Nothing has happened yet, and the baseline sample is not counted.
    expect(t.frame()).toContain("0 alerts opened since vsys started");
    // A lane escapes its slice, which opens an alert. The sample reaches the
    // running dashboard the way collection delivers it.
    const firing = emptySnapshot(2000);
    firing.lanes = [
      laneSnapshot({ id: "e.scope", name: "escaped", unconfined: true }),
    ];
    h.add(firing);
    await t.update(firing);
    expect(t.frame()).toContain("1 alert opened since vsys started");
    // A second sample with a second cause adds to it rather than replacing it.
    const worse = emptySnapshot(3000);
    worse.lanes = [
      laneSnapshot({ id: "e.scope", name: "escaped", unconfined: true }),
      laneSnapshot({ id: "c.scope", name: "capped", dangerous: true }),
    ];
    h.add(worse);
    await t.update(worse);
    expect(t.frame()).toContain("2 alerts opened since vsys started");
  } finally {
    await t.close();
  }
});

test("a shorter window leaves the Timeline selection on a row that exists", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  h.add(emptySnapshot(1000));
  // Twelve changes half an hour ago, and one recent. The five-minute window
  // holds the recent one alone; an hour holds them all.
  const old = emptySnapshot(2000);
  old.lanes = Array.from({ length: 12 }, (_, i) =>
    laneSnapshot({ id: `lane-${i}.scope`, name: `lane-${i}` }),
  );
  h.add(old);
  // One lane stops, forty minutes later. That stop is the only change the
  // five-minute window holds; without it the short window is empty and there
  // is no row to be on either way.
  const now = {
    ...old,
    time: 2000 + 40 * 60000,
    lanes: old.lanes.slice(1),
  };
  h.add(now);
  const t = await mount(now, c, { width: 160, height: 40 }, { history: h });
  try {
    await t.press("6");
    // Widen to an hour, then select a deep row.
    await t.press("w");
    await t.press("w");
    for (let i = 0; i < 8; i++) await t.press("j");
    expect(selectedRow(t.frame())).not.toBe("");
    // Cycle back to a window that holds fewer changes. The row number the
    // reader was on names nothing there.
    await t.press("w");
    await t.press("w");
    await t.press("w");
    const frame = t.frame();
    expect(frame).toContain("Last 5m");
    // A row that exists is marked, and Enter acts on it rather than on a
    // change the list does not have.
    expect(selectedRow(frame)).not.toBe("");
    await t.press("enter");
    expect(t.frame()).toContain("What changed");
  } finally {
    await t.close();
  }
});

test("a Home row opens the change the reader chose, not the first at its moment", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  h.add(emptySnapshot(1000));
  // Three lanes start in one sample, so all three changes carry time 2000.
  // A timestamp names the moment, not the change.
  const busy = emptySnapshot(2000);
  busy.lanes = ["alpha", "beta", "gamma"].map((name) =>
    laneSnapshot({ id: `${name}.scope`, name }),
  );
  h.add(busy);
  const changes = h.events(busy.time, c.historyHours * 3600000);
  expect(changes.length).toBe(3);
  expect(new Set(changes.map((e) => e.time)).size).toBe(1);
  const t = await mount(busy, c, { width: 160, height: 44 }, { history: h });
  try {
    await t.press("1");
    // Open the second of the three.
    const rows = homeItems(attention(busy, c), busy, 5, changes);
    const at = rows.findIndex((row) => row.kind === "change");
    expect(at).toBeGreaterThan(-1);
    for (let i = 0; i < at + 1; i++) await t.press("j");
    const chosen = selectedRow(t.frame());
    expect(chosen).toContain(changes[1].subject);
    await t.press("enter");
    // The Timeline lands on that change, not on the first one sharing its
    // time. Matching by time always found the first however far down the
    // reader had moved.
    expect(t.frame()).toContain("What changed");
    expect(selectedRow(t.frame())).toContain(changes[1].subject);
  } finally {
    await t.close();
  }
});

test("a row opened with the keyboard keeps its change when one arrives above it", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  h.add(emptySnapshot(1000));
  const first = emptySnapshot(2000);
  first.lanes = [laneSnapshot({ id: "alpha.scope", name: "alpha" })];
  h.add(first);
  const t = await mount(first, c, { width: 160, height: 40 }, { history: h });
  try {
    await t.press("6");
    const changes = h.events(first.time, c.historyHours * 3600000);
    expect(changes.length).toBe(1);
    // Open the only row with the keyboard, without ever pressing an arrow, so
    // this is the entry that recorded no identity.
    await t.press("enter");
    expect(selectedRow(t.frame())).toContain("alpha");
    const cursor = `cursor ${new Date(changes[0].time).toLocaleString()}`;
    expect(t.frame()).toContain(cursor);
    // A later sample puts a change above it. The list is newest first, so the
    // row the reader opened is no longer row zero.
    const second = emptySnapshot(3000);
    second.lanes = [
      laneSnapshot({ id: "alpha.scope", name: "alpha" }),
      laneSnapshot({ id: "beta.scope", name: "beta" }),
    ];
    h.add(second);
    await t.update(second);
    const after = h.events(second.time, c.historyHours * 3600000);
    expect(after.length).toBe(2);
    expect(after[0].subject).toBe("beta");
    // The highlight, the cursor and the sample the pin key acts on all still
    // name the row the reader chose, rather than the highlight jumping to the
    // new top row while the cursor stayed behind.
    expect(selectedRow(t.frame())).toContain("alpha");
    expect(t.frame()).toContain(cursor);
    await t.press("p");
    expect(t.frame()).toContain("Agents, Resources, Builds and Storage show");
  } finally {
    await t.close();
  }
  // And the first row is a choice before the reader touches anything: a
  // change arriving above it must not take the highlight off the row they
  // were reading. This is what the seeded initial identity holds on its own,
  // since no key has been pressed to record one.
  const untouched = new History(c);
  untouched.add(emptySnapshot(1000));
  const one = emptySnapshot(2000);
  one.lanes = [laneSnapshot({ id: "alpha.scope", name: "alpha" })];
  untouched.add(one);
  const quiet = await mount(
    one,
    c,
    { width: 160, height: 40 },
    {
      history: untouched,
    },
  );
  try {
    await quiet.press("6");
    expect(selectedRow(quiet.frame())).toContain("alpha");
    const two = emptySnapshot(3000);
    two.lanes = [
      laneSnapshot({ id: "alpha.scope", name: "alpha" }),
      laneSnapshot({ id: "beta.scope", name: "beta" }),
    ];
    untouched.add(two);
    await quiet.update(two);
    expect(selectedRow(quiet.frame())).toContain("alpha");
  } finally {
    await quiet.close();
  }
  // The case that isolates the key path from the seed: the seeded change
  // leaves the window, so the highlight falls back to a row the selection does
  // not name, and Enter is the only thing that can record what it opened.
  const drifting = new History(c);
  drifting.add(emptySnapshot(1000));
  const early = emptySnapshot(2000);
  early.lanes = [laneSnapshot({ id: "alpha.scope", name: "alpha" })];
  drifting.add(early);
  const t2 = await mount(
    early,
    c,
    { width: 160, height: 40 },
    {
      history: drifting,
    },
  );
  try {
    await t2.press("6");
    expect(selectedRow(t2.frame())).toContain("alpha");
    // Ten minutes on, alpha's change is outside the five-minute window and
    // beta's is the only row. The highlight is on a change the selection does
    // not name.
    const later = emptySnapshot(602000);
    later.lanes = [
      laneSnapshot({ id: "alpha.scope", name: "alpha" }),
      laneSnapshot({ id: "beta.scope", name: "beta" }),
    ];
    drifting.add(later);
    await t2.update(later);
    expect(selectedRow(t2.frame())).toContain("beta");
    await t2.press("enter");
    const cursor = `cursor ${new Date(602000).toLocaleString()}`;
    expect(t2.frame()).toContain(cursor);
    // A third change arrives above it.
    const newest = emptySnapshot(603000);
    newest.lanes = [
      ...later.lanes,
      laneSnapshot({ id: "gamma.scope", name: "gamma" }),
    ];
    drifting.add(newest);
    await t2.update(newest);
    // The highlight and the cursor still name beta. Without the key path
    // recording what it opened, the highlight follows the stale index to
    // gamma while the cursor stays on beta.
    expect(selectedRow(t2.frame())).toContain("beta");
    expect(t2.frame()).toContain(cursor);
  } finally {
    await t2.close();
  }
});

test("Home opens the row the reader chose after the list moves under it", async () => {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  /** A history holding one sample that carries all three Home row kinds. */
  const fresh = () => {
    const h = new History(c);
    h.add(emptySnapshot(1000));
    const s = everyCauseSnapshot(c);
    s.time = 2000;
    h.add(s);
    return { h, s };
  };
  const seed = fresh();
  const rows = homeItems(
    attention(seed.s, c),
    seed.s,
    5,
    seed.h.recentEvents(seed.s.time, recentChanges),
  );
  const firstOf = (kind: HomeItem["kind"]) =>
    rows.findIndex((row) => row.kind === kind);
  const lastOf = (kind: HomeItem["kind"]) =>
    rows.length - 1 - [...rows].reverse().findIndex((row) => row.kind === kind);
  /** A sample carrying a new lane, which records a change and adds an agent. */
  const arrives = (s: Snapshot): Snapshot => ({
    ...s,
    time: 3000,
    lanes: [...s.lanes, laneSnapshot({ id: "new.scope", name: "newcomer" })],
  });
  /** A sample where CPU pressure is gone, so that card leaves the list. */
  const clears = (s: Snapshot): Snapshot => ({
    ...s,
    time: 3000,
    system: {
      ...s.system,
      pressure: {
        ...s.system.pressure,
        cpu: { some: 0, full: 0, total: 0 },
      },
    },
  });
  // One case per row kind. Home mixes three and each list moves in its own
  // way, so each kind is chosen, moved under and opened on its own: a rule
  // written per kind reaches only the kinds someone remembered.
  /** The agent screen opens on one lane and names it above everything else. */
  const laneTitle = (frame: string) => (frame.split("\n")[2] ?? "").trim();
  const cases = [
    // The scratch card is the last concern, so the card above it clearing
    // moves it up a row.
    {
      kind: "concern" as const,
      at: lastOf("concern"),
      later: clears,
      opens: "/scratch",
      reads: selectedRow,
    },
    // A new lane records a change, and a change lands above every change
    // already listed.
    {
      kind: "change" as const,
      at: firstOf("change"),
      later: arrives,
      opens: "escaped",
      reads: selectedRow,
    },
    // The same lane adds an agent row, and agents sort by id, so it lands
    // above the last of them.
    {
      kind: "agent" as const,
      at: lastOf("agent"),
      later: arrives,
      opens: "writer",
      reads: laneTitle,
    },
  ];
  for (const { kind, at, later, opens, reads } of cases) {
    // Standing still: the presses reach the intended row, and opening it lands
    // on what that row names. This is what the moved list has to preserve.
    const still = fresh();
    const t = await mount(
      still.s,
      c,
      { width: 160, height: 44 },
      { history: still.h },
    );
    try {
      await t.press("1");
      for (let i = 0; i < at; i++) await t.press("j");
      await t.press("enter");
      expect({ kind, on: reads(t.frame()) }).toEqual({
        kind,
        on: expect.stringContaining(opens) as unknown as string,
      });
    } finally {
      await t.close();
    }
    // Moving: a sample lands while the reader sits on that row and puts
    // something above it. Enter has to open the row the reader chose, not
    // whatever took its place.
    const shifting = fresh();
    const m = await mount(
      shifting.s,
      c,
      { width: 160, height: 44 },
      { history: shifting.h },
    );
    try {
      await m.press("1");
      for (let i = 0; i < at; i++) await m.press("j");
      const next = later(shifting.s);
      shifting.h.add(next);
      await m.update(next);
      await m.press("enter");
      expect({ kind, on: reads(m.frame()) }).toEqual({
        kind,
        on: expect.stringContaining(opens) as unknown as string,
      });
    } finally {
      await m.close();
    }
  }
});

test("a lane exiting under the selection keeps one lane under highlight, pane and Enter", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "a", name: "lane-a", cpu: 9, cwd: "/repo/a" }),
    laneSnapshot({ id: "b", name: "lane-b", cpu: 5, cwd: "/repo/b" }),
    laneSnapshot({ id: "z", name: "lane-z", cpu: 1, cwd: "/repo/z" }),
  ];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 180, height: 30 });
  try {
    await t.press("2");
    await t.press("j");
    await t.press("j");
    expect(selectedRow(t.frame())).toContain("lane-z");
    expect(t.frame()).toContain("/repo/z");
    // The lane exits. Every row below it moves up, and the row number the
    // reader was on now names nothing.
    await t.update({ ...s, lanes: s.lanes.slice(0, 2) });
    const frame = t.frame();
    // One lane, read three ways: the highlight in the list, the summary
    // beside it, and what Enter opens.
    expect(selectedRow(frame)).toContain("lane-b");
    expect(frame).toContain("/repo/b");
    expect(frame).not.toContain("/repo/z");
    // The list moves a second time: a lane arrives that sorts below the rest,
    // which is what makes the departed lane's row number valid again.
    const arrived = {
      ...s,
      lanes: [
        ...s.lanes.slice(0, 2),
        laneSnapshot({ id: "n", name: "lane-n", cpu: 0, cwd: "/repo/n" }),
      ],
    };
    // What the fixture has to move, read before the selection is: the lane the
    // reader was on is gone, and the newcomer holds the row number it left
    // behind. A newcomer sorting anywhere else would prove nothing.
    expect(findLanes(arrived.lanes, "", c).map((lane) => lane.name)).toEqual([
      "lane-a",
      "lane-b",
      "lane-n",
    ]);
    await t.update(arrived);
    const after = t.frame();
    expect(after).toContain("lane-n");
    // Still the fallback the exit resolved to, not the lane that took the row
    // number the reader's selection used to name.
    expect(selectedRow(after)).toContain("lane-b");
    expect(after).toContain("/repo/b");
    expect(after).not.toContain("/repo/n");
    await t.press("enter");
    const footer = t.frame().split("\n").at(-2) ?? "";
    // The detail's own footer: it opened, rather than Enter finding no lane.
    expect(footer).toContain("back");
    expect(footer).not.toContain("find");
    expect(t.frame()).toContain("lane-b");
  } finally {
    await t.close();
  }
});

test("the editor opens in view when the layout moves the row it edits", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const t = await mount(s, c, { width: 180, height: 30 });
  try {
    await t.press("7");
    // Walk to the last setting. Two columns hold it on the right-hand side.
    for (let i = 0; i < 80; i++) await t.press("j");
    const marker = (frame: string) => {
      const line = frame.split("\n").find((row) => row.includes("▍"));
      return line === undefined ? -1 : line.indexOf("▍");
    };
    expect(marker(t.frame())).toBeGreaterThan(90);
    // Opening the editor collapses the two columns into one, so this row
    // moves below the whole left column. The scroll has to follow the layout
    // that moved it, not the selection, which did not change.
    await t.press("enter");
    // The scroll measures where the row currently sits, so it waits for the
    // new layout to be drawn: the editor is in view on the frame after the
    // collapse. Republishing the sample draws that frame and types nothing.
    await t.update(s);
    const frame = t.frame();
    // This row's editor, named by the row it edits. Measuring on the old
    // layout scrolled to the top of the list, where the opened row is not.
    expect(frame).toContain("Export markdown · Enter saves");
    expect(frame).not.toContain("Storage units");
  } finally {
    await t.close();
  }
});

test("a device reports the free space a member could read", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // `statfs` is attempted per mount, so one member of a filesystem can carry
  // no reading while another carries one.
  s.storage.volumes = [
    volumeSnapshot("/data", {
      device: "/dev/nvme0n1p2",
      fsid: "one",
      free: null,
      total: null,
    }),
    volumeSnapshot("/data/home", {
      device: "/dev/nvme0n1p2",
      fsid: "one",
      free: 1e11,
      total: 2e11,
    }),
  ];
  const t = await mount(s, c, { width: 140, height: 30 });
  try {
    await t.press("5");
    const line = t
      .frame()
      .split("\n")
      .find((row) => row.includes("/dev/nvme0n1p2"));
    expect(line).toBeDefined();
    expect(line).toContain("93.1 GiB free of 186.3 GiB");
    expect(line).not.toContain("not avail");
  } finally {
    await t.close();
  }
});

test("Storage draws two filesystems that report one device", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // One filesystem reached through a mapper alias and another through the
  // same source string: two identities, one device between them. The heading
  // is drawn once per group, so the device cannot identify a group.
  s.storage.volumes = [
    volumeSnapshot("/one", { device: "/dev/mapper/pool", fsid: "abc" }),
    volumeSnapshot("/two", { device: "/dev/mapper/pool", fsid: "def" }),
  ];
  // What the fixture has to hold, asserted before anything is drawn. Two ids
  // that do not share a device would draw two distinct keys whatever the key
  // is, and prove nothing about which one was used.
  expect(
    volumesByDevice(s.storage.volumes).map((g) => `${g.id} ${g.device}`),
  ).toEqual(["abc /dev/mapper/pool", "def /dev/mapper/pool"]);
  const logged: string[] = [];
  const wasError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  let frame = "";
  try {
    const t = await mount(s, c, { width: 140, height: 30 });
    try {
      await t.press("5");
      frame = t.frame();
    } finally {
      await t.close();
    }
  } finally {
    console.error = wasError;
  }
  // Both filesystems reached the screen, so the diagnostic below is about two
  // drawn groups rather than a fixture that quietly drew one.
  expect([frame.includes("/one"), frame.includes("/two")]).toEqual([
    true,
    true,
  ]);
  // Keyed by the device these two groups share one key, which React reports as
  // unsupported: it may duplicate or omit a child, and which it does is not
  // ours to choose. This render still draws both, so the diagnostic is the only
  // place the collision is stated, and the test reads it rather than the frame.
  expect(logged.filter((line) => /same key/i.test(line))).toEqual([]);
});

/** A history that records which lane series were asked for. */
function countingHistory(c: Config, s: Snapshot) {
  const h = new History(c);
  h.add(s);
  const asked: string[] = [];
  const real = h.laneWindow.bind(h);
  h.laneWindow = async (id: string, end: number, durationMs: number) => {
    asked.push(id);
    return real(id, end, durationMs);
  };
  return { h, asked };
}

test("a long list reads the history of the rows on screen and no others", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // Forty lanes, descending by CPU, so the order on screen is known.
  s.lanes = Array.from({ length: 40 }, (_, i) =>
    laneSnapshot({ id: `lane-${i}`, name: `lane-${i}`, cpu: 100 - i }),
  );
  s.groups = [groupSnapshot()];
  const { h, asked } = countingHistory(c, s);
  // Wide enough for the trend column: the read exists to draw it.
  const t = await mount(s, c, { width: 200, height: 24 }, { history: h });
  try {
    await t.press("2");
    expect(t.frame()).toContain("Trend");
    // The claim is about reads, not about pixels: a change that widened the
    // read would draw the same rows and pass a test that only looked at them.
    // The expectation is the rows actually on screen, so no layout arithmetic
    // is copied here to drift from the screen's own.
    const onScreen = () => new Set(t.frame().match(/lane-\d+/g) ?? []);
    const shown = onScreen();
    expect(shown.size).toBeGreaterThan(0);
    expect(shown.size).toBeLessThan(s.lanes.length);
    expect([...asked].sort()).toEqual([...shown].sort());
    // No series is read twice, and a new sample reads none: the loaded set is
    // keyed by lane and window, so a refresh does not reach the store.
    expect(asked.length).toBe(new Set(asked).size);
    const before = asked.length;
    await t.update({ ...s, time: s.time + 1000 });
    await t.update({ ...s, time: s.time + 2000 });
    expect(asked.length).toBe(before);
    // Scrolling reads what scrolling revealed, and nothing above it.
    for (let i = 0; i < shown.size; i++) await t.press("j");
    const revealed = onScreen();
    expect(new Set(asked).size).toBeGreaterThan(shown.size);
    for (const id of asked)
      expect(shown.has(id) || revealed.has(id)).toBe(true);
    // Scrolling one row into view reads that row, not the whole window again:
    // the rows already read stay read.
    expect(asked.length).toBe(new Set(asked).size);
  } finally {
    await t.close();
  }
});

test("a series that arrives after the next sample still draws", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ id: "lane-0", name: "lane-0", cpu: 100 })];
  s.groups = [groupSnapshot()];
  const h = new History(c);
  h.add(s);
  const real = h.laneWindow.bind(h);
  // A store with real history answers in its own time. This one answers only
  // when the test says so, after further samples have arrived.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.laneWindow = async (id: string, end: number, durationMs: number) => {
    const samples = await real(id, end, durationMs);
    await held;
    return samples;
  };
  const t = await mount(s, c, { width: 200, height: 24 }, { history: h });
  try {
    await t.press("2");
    // Two samples land while the read is still out.
    await t.update({ ...s, time: s.time + 1000 });
    await t.update({ ...s, time: s.time + 2000 });
    // The gap glyph belongs to the trend alone: the bar draws blocks and
    // dashes, so finding it proves the series reached the row.
    expect(selectedRow(t.frame())).not.toContain("···");
    release();
    await t.update({ ...s, time: s.time + 3000 });
    expect(selectedRow(t.frame())).toContain("···");
  } finally {
    await t.close();
  }
});

test("a series that never answers does not blank the other rows", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({ id: "lane-0", name: "lane-0", cpu: 100 }),
    laneSnapshot({ id: "lane-1", name: "lane-1", cpu: 50 }),
  ];
  s.groups = [groupSnapshot()];
  const h = new History(c);
  h.add(s);
  const real = h.laneWindow.bind(h);
  h.laneWindow = async (id: string, end: number, durationMs: number) =>
    id === "lane-1"
      ? await new Promise<never>(() => {})
      : await real(id, end, durationMs);
  // Wide enough for the trend, narrow enough to keep the side pane away, so a
  // row is the only place its lane's name appears.
  const t = await mount(s, c, { width: 120, height: 24 }, { history: h });
  try {
    await t.press("2");
    await t.update({ ...s, time: s.time + 1000 });
    const row = (name: string) =>
      t
        .frame()
        .split("\n")
        .find((line) => line.includes(name)) ?? "";
    // The gap glyph belongs to the trend alone: the bar draws blocks and
    // dashes, so finding it proves the series reached the row.
    expect(row("lane-0")).toContain("···");
    expect(row("lane-1")).not.toContain("···");
  } finally {
    await t.close();
  }
});

test("a narrow list keeps the name and drops the trend", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // Names that only differ at their end, so a name cut short would leave the
  // rows indistinguishable.
  s.lanes = Array.from({ length: 6 }, (_, i) =>
    laneSnapshot({
      id: `lane-${i}`,
      name: `.hclaude claude ken-13${10 + i}`,
      cpu: 100 - i,
    }),
  );
  s.groups = [groupSnapshot()];
  const { h, asked } = countingHistory(c, s);
  const t = await mount(s, c, { width: 100, height: 24 }, { history: h });
  try {
    await t.press("2");
    const frame = t.frame();
    expect(frame).not.toContain("Trend");
    // The name arrives whole, so one row can be told from the next.
    expect(frame).toContain(".hclaude claude ken-1310");
    expect(frame).toContain(".hclaude claude ken-1315");
    // A column that is not drawn is not read for either.
    expect(asked).toEqual([]);
  } finally {
    await t.close();
  }
});

test("the wheel moves the selection by one row", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = Array.from({ length: 12 }, (_, i) =>
    laneSnapshot({ id: `lane-${i}`, name: `lane-${i}`, cpu: 100 - i }),
  );
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 160, height: 24 });
  try {
    await t.press("2");
    expect(selectedRow(t.frame())).toContain("lane-0");
    // One notch down is one row down, not a viewport jump.
    await t.wheel(10, 8, "down");
    expect(selectedRow(t.frame())).toContain("lane-1");
    await t.wheel(10, 8, "down");
    expect(selectedRow(t.frame())).toContain("lane-2");
    await t.wheel(10, 8, "up");
    expect(selectedRow(t.frame())).toContain("lane-1");
    // The selection stops at the ends rather than wrapping.
    for (let i = 0; i < 4; i++) await t.wheel(10, 8, "up");
    expect(selectedRow(t.frame())).toContain("lane-0");
  } finally {
    await t.close();
  }
});

test("clicking a tile opens the screen its key opens", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ name: "lane-a" })];
  s.groups = [groupSnapshot()];
  // The click lands on the same target the arrow keys reach, because both
  // read `meterView`. The tile is found by its own caption, so the test does
  // not repeat the layout's arithmetic.
  const rows: [string, string][] = [
    ["CPU wait", "Groups"],
    ["Memory", "Groups"],
    ["Disk wait", "Written since boot"],
    ["Builds", "Lanes building"],
  ];
  for (const [label, lands] of rows) {
    const t = await mount(s, c, { width: 160, height: 30 });
    try {
      await t.press("1");
      const lines = t.frame().split("\n");
      const row = lines.findIndex(
        (line) => line.includes("CPU wait") && line.includes("Builds"),
      );
      expect(row).toBeGreaterThan(-1);
      await t.click(lines[row].indexOf(label), row);
      expect({ label, on: t.frame().includes(lands) }).toEqual({
        label,
        on: true,
      });
    } finally {
      await t.close();
    }
  }
});
