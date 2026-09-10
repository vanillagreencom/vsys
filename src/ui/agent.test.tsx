import { expect, test } from "bun:test";
import type { Config } from "../config/config";
import { defaults } from "../config/config";
import type { LaneCommand } from "../model/actions";
import { normalizeLane } from "../store/migrate";
import { emptySnapshot, groupSnapshot, laneSnapshot } from "../test/fixture";
import { mount } from "../test/harness";
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
  const t = await mount(s, c, { width: 160, height: 45 }, hooks);
  await t.press("2");
  await t.press("enter");
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
