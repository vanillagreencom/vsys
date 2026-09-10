import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { Config } from "../config/config";
import { defaults } from "../config/config";
import type { LaneCommand } from "../model/actions";
import type { Snapshot } from "../model/types";
import { History } from "../store/history";
import { normalizeLane } from "../store/migrate";
import {
  emptySnapshot,
  everyCauseSnapshot,
  groupSnapshot,
  laneSnapshot,
  volumeSnapshot,
} from "../test/fixture";
import { App, Waiting } from "./App";
import { attention } from "./attention";
import { osc52 } from "./clipboard";

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
  const close = async () => {
    await act(async () => {
      ui.renderer.destroy();
    });
    h.close();
  };
  return { ui, h, press, frame, close, written, update };
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
    expect(t.frame()).toContain("Refresh interval (ms)");
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
    expect(frame).toContain("What changed  6 of 12, newest first");
    expect(frame).toMatch(/Lane started\s+lane-5/);
    expect(frame).not.toContain("lane-11");
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
    const rows = frame.split("\n");
    const strip = rows[rows.findIndex((row) => row.includes("At cursor")) - 2];
    expect(strip).toContain("▲");
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
    expect(frame).toMatch(/Refresh interval \(ms\)\s+1000/);
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
    expect(frame).toContain("12.0% wait");
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
    expect(narrow.frame()).not.toContain("wait");
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
    expect(t.frame()).toContain("Copied:");
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
