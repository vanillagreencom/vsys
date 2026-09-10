import { expect, test } from "bun:test";
import { act } from "react";
import type { Config } from "../config/config";
import { defaults } from "../config/config";
import type { LaneCommand } from "../model/actions";
import { History } from "../store/history";
import { normalizeLane } from "../store/migrate";
import { emptySnapshot, groupSnapshot, laneSnapshot } from "../test/fixture";
import { isChildLine, mount, selectedRow } from "../test/harness";
import { osc52 } from "./clipboard";

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
  // Processes, Launch, Terminal and Open files sit above Actions; opening it
  // adds its three rows below, and Stop is the last of them.
  for (let i = 0; i < 4; i++) await t.press("j");
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

/** An agent in a tmux pane, with the detail open on it. */
async function paned(
  hooks: Parameters<typeof mount>[3] = {},
  lane: Partial<Parameters<typeof laneSnapshot>[0]> = {},
  /** Short enough that the detail overflows, when that is what is under test. */
  height = 45,
) {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [
    laneSnapshot({
      pane: "%9",
      address: "vsys:1.1",
      window: "ken-1298",
      ...lane,
    }),
  ];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 160, height }, hooks);
  await t.press("2");
  await t.press("enter");
  // A reader arrives at a screen that has finished drawing itself. Pressing
  // keys inside the same tick is a test's privilege, not a reader's.
  await settle(t);
  // Processes and Launch sit above Terminal.
  for (let i = 0; i < 2; i++) await t.press("j");
  return { ...t, snapshot: s, config: c };
}

test("the terminal reads the pane while its section is open and not otherwise", async () => {
  const asked: string[] = [];
  const t = await paned({
    onCapture: async (paneId) => {
      asked.push(paneId);
      return ["$ cargo build", "   Compiling vsys v0.1.0"];
    },
  });
  try {
    // Closed, nothing is read: a section nobody opened costs no tmux call.
    await t.update({ ...t.snapshot, time: t.snapshot.time + 1000 });
    expect(asked).toEqual([]);
    await t.press("enter");
    expect(t.frame()).toContain("Compiling vsys");
    // It reads the pane the lane holds, by the raw handle rather than by the
    // address a reader reads.
    expect(asked).toEqual(["%9"]);
    // A new sample is a new read: a terminal that does not move is not one.
    await t.update({ ...t.snapshot, time: t.snapshot.time + 2000 });
    expect(asked).toEqual(["%9", "%9"]);
    // Closed again, and the samples that follow read nothing.
    await t.press("enter");
    await t.update({ ...t.snapshot, time: t.snapshot.time + 3000 });
    expect(asked).toEqual(["%9", "%9"]);
    expect(t.frame()).not.toContain("Compiling vsys");
  } finally {
    await t.close();
  }
});

test("a pane that has gone away says why rather than showing an empty box", async () => {
  const t = await paned({
    onCapture: async () => {
      throw new Error("can't find pane %9");
    },
  });
  try {
    await t.press("enter");
    const frame = t.frame();
    expect(frame).toContain("could not be read");
    expect(frame).toContain("can't find pane %9");
  } finally {
    await t.close();
  }
});

test("what a pane drew is shown as text, never obeyed", async () => {
  const t = await paned({
    onCapture: async () => [`${"\u001b"}[2Jcleared`, "plain output"],
  });
  try {
    await t.press("enter");
    const frame = t.frame();
    // The words arrive; the sequence that would have cleared the screen does
    // not, and nothing reached the clipboard stream.
    expect(frame).toContain("plain output");
    expect(t.written.join("")).toBe("");
    for (const line of frame.split("\n"))
      expect(
        [...line].some((ch) => {
          const code = ch.charCodeAt(0);
          return code < 0x20 || (code >= 0x7f && code <= 0x9f);
        }),
      ).toBe(false);
  } finally {
    await t.close();
  }
});

test("the switch is offered only when vsys shares the tmux server", async () => {
  const switched: string[] = [];
  const inside = await paned({
    onCapture: async () => ["output"],
    onSwitch: async (paneId) => {
      switched.push(paneId);
    },
  });
  try {
    await inside.press("enter");
    expect(inside.frame()).toContain("Go to terminal");
    await inside.press("j");
    await inside.press("enter");
    // It moves the view to the pane vsys holds the handle for.
    expect(switched).toEqual(["%9"]);
    expect(inside.written.join("")).toBe("");
  } finally {
    await inside.close();
  }
  // Outside that server there is no view to move, so the line is handed over
  // instead and the row says why.
  const outside = await paned({ onCapture: async () => ["output"] });
  try {
    await outside.press("enter");
    expect(outside.frame()).toContain("not inside that tmux server");
    await outside.press("j");
    await outside.press("enter");
    expect(outside.frame()).toContain("tmux switch-client -t %9");
    expect(osc52("tmux switch-client -t %9")).toBe(outside.written.join(""));
  } finally {
    await outside.close();
  }
});

test("an agent with no pane offers no terminal and no way to reach one", async () => {
  const t = await paned(
    { onCapture: async () => ["output"] },
    { pane: "", address: "" },
  );
  try {
    await t.press("enter");
    const frame = t.frame();
    expect(frame).toContain("exported no pane address");
    expect(frame).not.toContain("Go to terminal");
  } finally {
    await t.close();
  }
});

test("a pinned sample offers no terminal capture and no switch", async () => {
  const c = defaults();
  const s = emptySnapshot(1000);
  s.lanes = [laneSnapshot({ id: "a", name: "lane-a", pane: "%1" })];
  s.groups = [groupSnapshot()];
  const captured: string[] = [];
  const switched: string[] = [];
  const h = new History(c);
  h.add(s);
  const later = { ...s, time: 2000 };
  h.add(later);
  /** Open the agent's Terminal section, whichever row the detail opens on. */
  const openTerminal = async (t: Awaited<ReturnType<typeof mount>>) => {
    for (let i = 0; i < 12; i++) {
      if (selectedRow(t.frame()).includes("Terminal")) break;
      await t.press("j");
    }
    expect(selectedRow(t.frame())).toContain("Terminal");
    await t.press("enter");
  };
  const t = await mount(
    later,
    c,
    { width: 160, height: 40 },
    {
      history: h,
      onCapture: async (paneId: string) => {
        captured.push(paneId);
        return ["live output"];
      },
      onSwitch: async (paneId: string) => {
        switched.push(paneId);
      },
    },
  );
  try {
    await t.press("2");
    await t.press("enter");
    await openTerminal(t);
    // Live, the terminal reads the pane. Asserted so its absence below means
    // something rather than agreeing with a fixture that never read at all.
    expect(captured.length).toBeGreaterThan(0);
    const before = captured.length;
    // Pin the older sample: the shell is now showing the past.
    await t.press("escape");
    await t.press("6");
    await t.press("left");
    await t.press(c.keys.pin);
    // The shell's own words for a pinned sample: the views that follow the
    // cursor say which moment they are showing.
    expect(t.frame()).toContain("Agents, Resources, Builds and Storage show");
    await t.press("2");
    await t.press("enter");
    await openTerminal(t);
    const frame = t.frame();
    // No read of what that pane holds now, inside a view of an older sample,
    // and the row says which it is rather than drawing an empty box.
    expect(captured.length).toBe(before);
    expect(frame).toContain("A pane is read live; this is a past sample.");
    // And nothing to switch to: two keypresses would have moved the reader to
    // whatever holds that pane id today.
    await t.press("j");
    await t.press("enter");
    expect(switched).toEqual([]);
  } finally {
    await t.close();
  }
});

test("a switch that is refused tells the reader why", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ id: "a", name: "lane-a", pane: "%1" })];
  s.groups = [groupSnapshot()];
  const t = await mount(
    s,
    c,
    { width: 160, height: 40 },
    {
      onCapture: async () => ["output"],
      onSwitch: async () => {
        throw new Error("can't find pane %1");
      },
    },
  );
  try {
    await t.press("2");
    await t.press("enter");
    // The row that goes to the terminal exists only once the section is open,
    // so this walks to the section, opens it, then walks to the row.
    for (let i = 0; i < 12; i++) {
      if (selectedRow(t.frame()).includes("Terminal")) break;
      await t.press("j");
    }
    expect(selectedRow(t.frame())).toContain("Terminal");
    await t.press("enter");
    for (let i = 0; i < 4; i++) {
      if (selectedRow(t.frame()).includes("Go to terminal")) break;
      await t.press("j");
    }
    expect(selectedRow(t.frame())).toContain("Go to terminal");
    await t.press("enter");
    await t.update(s);
    // The server's own words reach the reader. Dropped, the key did nothing
    // and said nothing, and the rejection went to the runtime instead.
    expect(t.frame()).toContain("can't find pane %1");
  } finally {
    await t.close();
  }
});

/** Lets the second layout pass land, which is when a grown row knows its size. */
async function settle(t: Awaited<ReturnType<typeof mount>>) {
  // A render, so the effect runs against the new tree and schedules its second
  // pass; then time for that pass; then a render to draw where it scrolled to.
  await t.ui.renderOnce();
  await act(async () => {
    await Bun.sleep(20);
  });
  await t.ui.renderOnce();
}

test("a capture arriving under the reader does not take the row they are on", async () => {
  let release: ((lines: string[]) => void) | null = null;
  const t = await paned(
    {
      onCapture: () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    },
    {},
    // Short enough that twelve lines arriving above the row push it off the
    // bottom. Taller, the row survives whatever the effect does, and the test
    // would pass without proving anything.
    24,
  );
  try {
    await t.press("enter");
    // Down to the last row, below the terminal the capture is about to fill.
    for (let i = 0; i < 8; i++) await t.press("j");
    await settle(t);
    expect(selectedRow(t.frame())).toContain("Actions");
    // Twelve lines land above the row the keys still act on. Told to re-run
    // only when `selected` changed, this effect did not run at all, and the
    // reader was left pressing enter on a row that had left the screen.
    await act(async () => {
      release?.(Array.from({ length: 12 }, (_, i) => `capline ${i}`));
      await Promise.resolve();
    });
    await settle(t);
    const frame = t.frame();
    expect(frame).toContain("capline 11");
    expect(selectedRow(frame)).toContain("Actions");
  } finally {
    await t.close();
  }
});

test("a sample leaves the reader where they scrolled to", async () => {
  const t = await paned(
    {
      onCapture: async () =>
        Array.from({ length: 12 }, (_, i) => `capline ${i}`),
    },
    {},
    // Short enough that the detail is taller than the box holding it, which is
    // the only shape in which there is anywhere for a reader to scroll.
    24,
  );
  try {
    await t.press("enter");
    for (let i = 0; i < 8; i++) await t.press("j");
    await settle(t);
    // The wheel moves this box, so an effect that ran on every render and
    // scrolled every time would take the reader back here on the next tick.
    const band = (f: string) => f.split("\n").slice(3, 6).join("\n");
    const standing = band(t.frame());
    for (let i = 0; i < 20; i++) await t.wheel(40, 20, "up");
    const wheeled = band(t.frame());
    expect(wheeled).not.toBe(standing);
    await t.update({ ...t.snapshot, time: t.snapshot.time + 1000 });
    await settle(t);
    expect(band(t.frame())).toBe(wheeled);
  } finally {
    await t.close();
  }
});

test("the detail opens at the top, not part-way down at its first section", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot({ pane: "%9", address: "vsys:1.1" })];
  s.groups = [groupSnapshot()];
  // Short enough that the sections sit below the fold, so scrolling to one of
  // them would be visible.
  const t = await mount(s, c, { width: 160, height: 24 });
  try {
    await t.press("2");
    await t.press("enter");
    // Nothing has moved yet, so there is nothing to keep in view. Scrolling to
    // the selected row on arrival would open the screen below the identity
    // line and the charts, which is what the reader came here to read.
    await act(async () => {
      await Bun.sleep(20);
    });
    await t.ui.renderOnce();
    const frame = t.frame();
    expect(frame).toContain("account default");
    expect(frame).toContain("PID 40");
  } finally {
    await t.close();
  }
});

test("an open section is drawn as a child of its own row", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.lanes = [laneSnapshot()];
  s.groups = [groupSnapshot()];
  const t = await mount(s, c, { width: 160, height: 45 });
  try {
    await t.press("2");
    await t.press("enter");
    // Closed, the row still says there is something inside it.
    expect(t.frame()).toContain("▸ Processes");
    await t.press("enter");
    const lines = t.frame().split("\n");
    const row = lines.findIndex((line) => line.includes("▾ Processes"));
    expect(row).toBeGreaterThan(-1);
    expect(isChildLine(lines[row])).toBe(false);
    expect(isChildLine(lines[row + 1])).toBe(true);
  } finally {
    await t.close();
  }
});
