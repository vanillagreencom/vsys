import { expect, test } from "bun:test";
import { type Config, defaults } from "../config/config";
import type { Snapshot } from "../model/types";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import { mount, sortMarks } from "../test/harness";
import { heldLabel, heldOrder, type Newcomers } from "./hold";

test("a held order keeps its rows, drops an ended one, and places a new one by the list's rule", () => {
  const row = (id: string, reading: number) => ({ id, reading });
  type Row = ReturnType<typeof row>;
  // What each row names, the live rows in their live order, the held ids,
  // what the list does with a new row, where held ids are looked up, and the
  // rows drawn. A held row carries its live reading, never the one it was
  // held at.
  const cases: [
    string,
    Row[],
    string[] | undefined,
    Newcomers,
    Row[] | undefined,
    Row[],
  ][] = [
    [
      "nothing held follows the live order",
      [row("b", 9), row("a", 1)],
      undefined,
      "append",
      undefined,
      [row("b", 9), row("a", 1)],
    ],
    [
      "held rows keep their order and their live readings",
      [row("b", 9), row("a", 1)],
      ["a", "b"],
      "append",
      undefined,
      [row("a", 1), row("b", 9)],
    ],
    [
      "an ended row drops out",
      [row("b", 9)],
      ["a", "b"],
      "append",
      undefined,
      [row("b", 9)],
    ],
    [
      "a full list appends a new row",
      [row("c", 20), row("b", 9), row("a", 1)],
      ["a", "b"],
      "append",
      undefined,
      [row("a", 1), row("b", 9), row("c", 20)],
    ],
    [
      "a top list leaves a new row out",
      [row("c", 20), row("b", 9), row("a", 1)],
      ["a", "b"],
      "leave out",
      undefined,
      [row("a", 1), row("b", 9)],
    ],
    [
      "a held row that fell below a top list's cut stays",
      [row("b", 9)],
      ["a", "b"],
      "leave out",
      [row("b", 9), row("a", 1)],
      [row("a", 1), row("b", 9)],
    ],
  ];
  for (const [name, live, held, newcomers, pool, drawn] of cases)
    expect({
      name,
      rows: heldOrder(live, held, (r) => r.id, newcomers, pool),
    }).toEqual({ name, rows: drawn });
});

/** One list whose readings order its rows, as the tests below drive it. */
interface HeldList {
  list: string;
  /** The keys that bring the list on screen. */
  keys: string[];
  newcomers: Newcomers;
  /** Whether the list's heading marks the sort its rows follow. */
  marked: boolean;
  /** A sample whose rows take these readings, one per name, in order. */
  sample: (readings: number[]) => Snapshot;
  /** What names each row on the line it is drawn on. */
  names: string[];
  /** The text a row's line shows for its reading. */
  shows: (reading: number) => string;
  config?: Partial<Config>;
}
const laneNames = ["lane-a", "lane-b", "lane-c", "lane-d"];
const lanesWith = (readings: number[], lane: (reading: number) => object) =>
  readings.map((reading, i) =>
    laneSnapshot({
      id: laneNames[i],
      name: laneNames[i],
      mainPid: 40 + i,
      pids: [40 + i],
      ...lane(reading),
    }),
  );
/** Lanes ordered by CPU: each reading is a lane's CPU share. */
function byCpu(readings: number[]): Snapshot {
  const s = emptySnapshot();
  s.lanes = lanesWith(readings, (cpu) => ({ cpu }));
  s.groups = [groupSnapshot()];
  return s;
}
/** Lanes ordered by build work: each reading is a lane's compiler count. */
function byBuilds(readings: number[]): Snapshot {
  const s = emptySnapshot();
  s.lanes = lanesWith(readings, (rustc) => ({ builds: { rustc } }));
  return s;
}
const pids = ["7001", "7002", "7003", "7004"];
/** One lane's build processes ordered by CPU: each reading is one's share. */
function byProcessCpu(readings: number[]): Snapshot {
  const s = emptySnapshot();
  const members = readings.map((_, i) => 7001 + i);
  s.lanes = [
    laneSnapshot({
      id: "lane-z",
      name: "lane-z",
      pids: [40, ...members],
      builds: { rustc: readings.length },
    }),
  ];
  s.procs = readings.map((cpuPercent, i) =>
    processSnapshot({ pid: members[i], build: "rustc", cpuPercent }),
  );
  return s;
}
const cpuShown = (reading: number) => `${reading.toFixed(1)}%`;
const heldLists = (c: Config): HeldList[] => [
  {
    list: "Home Busiest agents",
    keys: [c.keys.home],
    newcomers: "leave out",
    marked: true,
    sample: byCpu,
    names: laneNames,
    shows: cpuShown,
  },
  {
    list: "Agents list",
    keys: [c.keys.agents],
    newcomers: "append",
    marked: true,
    sample: byCpu,
    names: laneNames,
    shows: cpuShown,
  },
  {
    list: "Agents table",
    keys: [c.keys.agents, c.keys.details],
    newcomers: "append",
    marked: true,
    sample: byCpu,
    names: laneNames,
    shows: cpuShown,
    config: { columns: ["name", "cpu", "rss"] },
  },
  {
    list: "Builds lanes",
    keys: [c.keys.builds],
    newcomers: "append",
    marked: false,
    sample: byBuilds,
    names: laneNames,
    shows: (n) => `${n} ${n === 1 ? "process" : "processes"}`,
  },
  {
    list: "Builds processes",
    keys: [c.keys.builds, "enter"],
    newcomers: "append",
    marked: false,
    sample: byProcessCpu,
    names: pids,
    shows: cpuShown,
  },
];
const size = { width: 140, height: 30 };
/** Which of `names` the drawn lines carry, top to bottom. */
const order = (frame: string, names: string[]) =>
  frame
    .split("\n")
    .flatMap((line) => names.filter((name) => line.includes(name)));
const lineOf = (frame: string, name: string) =>
  frame.split("\n").find((line) => line.includes(name)) ?? "";

test("every list whose readings order its rows keeps a held order while the readings move", async () => {
  const c = defaults();
  for (const x of heldLists(c)) {
    const [a, b] = x.names;
    const t = await mount(x.sample([3, 1]), { ...c, ...x.config }, size);
    try {
      for (const key of x.keys) await t.press(key);
      const live = t.frame();
      await t.press(c.keys.hold);
      const holding = t.frame();
      // The readings swap, so the live order would put the second row on top.
      await t.update(x.sample([1, 3]));
      const held = t.frame();
      await t.press(c.keys.hold);
      const released = t.frame();
      expect({
        list: x.list,
        live: order(live, x.names),
        liveMarks: sortMarks(live).length,
        liveReading: lineOf(live, a).includes(x.shows(3)),
        holding: holding.includes(heldLabel),
        holdingMarks: sortMarks(holding),
        held: order(held, x.names),
        heldReading: lineOf(held, a).includes(x.shows(1)),
        released: order(released, x.names),
        releasedLabel: released.includes(heldLabel),
        releasedMarks: sortMarks(released).length,
      }).toEqual({
        list: x.list,
        live: [a, b],
        liveMarks: x.marked ? 1 : 0,
        liveReading: true,
        holding: true,
        holdingMarks: [],
        held: [a, b],
        heldReading: true,
        released: [b, a],
        releasedLabel: false,
        releasedMarks: x.marked ? 1 : 0,
      });
    } finally {
      await t.close();
    }
  }
});

test("a row that starts while the order is held joins the end of a full list and stays out of a top list", async () => {
  const c = defaults();
  for (const x of heldLists(c)) {
    const t = await mount(x.sample([3, 1]), { ...c, ...x.config }, size);
    try {
      for (const key of x.keys) await t.press(key);
      await t.press(c.keys.hold);
      // Two rows start, each reading above both held rows.
      await t.update(x.sample([3, 1, 9, 5]));
      const joined = order(t.frame(), x.names);
      // The two that started swap readings: once drawn, a row that joined the
      // held order keeps its place like any other held row.
      await t.update(x.sample([3, 1, 5, 9]));
      const kept = order(t.frame(), x.names);
      const drawn = x.newcomers === "append" ? x.names : x.names.slice(0, 2);
      expect({ list: x.list, joined, kept }).toEqual({
        list: x.list,
        joined: drawn,
        kept: drawn,
      });
    } finally {
      await t.close();
    }
  }
});

test("a held Agents order is released by anything that asks for an order", async () => {
  const c = { ...defaults(), columns: ["name", "cpu", "rss"] };
  type Mounted = Awaited<ReturnType<typeof mount>>;
  /** The table's CPU heading, clicked where the frame draws it. */
  const clickCpu = async (t: Mounted) => {
    const lines = t.frame().split("\n");
    const y = lines.findIndex(
      (line) => line.includes("Agent") && line.includes("Memory"),
    );
    await t.click(lines[y].indexOf("CPU"), y);
  };
  // What releases the hold, the keys that bring the list on screen, the
  // release itself, and the CPU readings published after it. Held, lane-a
  // stays on top; released, the order each asks for puts lane-b there.
  const releases: [
    string,
    string[],
    (t: Mounted) => Promise<void>,
    number[],
  ][] = [
    // The sort key moves from CPU to the wait, which is highest on lane-b.
    ["the sort key", [c.keys.agents], (t) => t.press(c.keys.sort), [3, 1]],
    // The reverse key turns CPU to smallest first.
    [
      "the reverse key",
      [c.keys.agents],
      (t) => t.press(c.keys.reverse),
      [3, 1],
    ],
    // No heading is marked while held, so the click sorts largest first.
    [
      "a click on a table heading",
      [c.keys.agents, c.keys.details],
      clickCpu,
      [1, 3],
    ],
    [
      "leaving the screen",
      [c.keys.agents],
      async (t) => {
        await t.press(c.keys.home);
        await t.press(c.keys.agents);
      },
      [1, 3],
    ],
  ];
  for (const [what, keys, release, readings] of releases) {
    const sample = (cpu: number[]) => {
      const s = byCpu(cpu);
      s.lanes[1] = { ...s.lanes[1], pressure: 5 };
      return s;
    };
    const t = await mount(sample([3, 1]), c, { width: 140, height: 24 });
    try {
      for (const key of keys) await t.press(key);
      await t.press(c.keys.hold);
      const holding = t.frame().includes(heldLabel);
      await release(t);
      await t.update(sample(readings));
      const frame = t.frame();
      expect({
        what,
        holding,
        held: frame.includes(heldLabel),
        top: order(frame, laneNames)[0],
        marks: sortMarks(frame).length,
      }).toEqual({ what, holding: true, held: false, top: "lane-b", marks: 1 });
    } finally {
      await t.close();
    }
  }
});
