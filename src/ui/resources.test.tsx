import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { collectGroups } from "../collect/cgroups";
import { Reader } from "../collect/io";
import { defaults } from "../config/config";
import type { Group, Lane, Snapshot } from "../model/types";
import { meters } from "../model/verdict";
import {
  emptySnapshot,
  fixture,
  groupSnapshot,
  laneSnapshot,
} from "../test/fixture";
import { mount, selectedRow } from "../test/harness";
import { present } from "../test/present";
import { meterTile } from "./attention";
import { gap } from "./format";
import { type KeyHandler, KeyProvider } from "./keys";
import {
  type GroupCause,
  groupCause,
  groupLabels,
  groupLevel,
  groupRows,
  idle,
  Resources,
  treePrefixes,
} from "./resources";

test.each([
  { selected: "beta", removed: "alpha", expected: "beta", moves: 1 },
  { selected: "beta", removed: "beta", expected: "gamma", moves: 1 },
  { selected: "gamma", removed: "gamma", expected: "beta", moves: 2 },
])(
  "Resources keeps or replaces $selected when $removed leaves",
  async ({ selected, removed, expected, moves }) => {
    const s = emptySnapshot();
    s.groups = ["alpha", "beta", "gamma"].map((name) =>
      groupSnapshot({
        path: `agents.slice/${name}.scope`,
        name: `${name}.scope`,
        cpuPercent: 1,
      }),
    );
    const t = await mount(s, defaults(), { width: 160, height: 40 });
    try {
      await t.press("3");
      for (let i = 0; i < moves; i++) await t.press("down");
      expect(selectedRow(t.frame())).toContain(selected);
      await t.update({
        ...s,
        groups: s.groups.filter((group) => group.name !== `${removed}.scope`),
      });
      expect(selectedRow(t.frame())).toContain(expected);
    } finally {
      await t.close();
    }
  },
);

test("Resources shows an unknown limit for each unread limit file", async () => {
  const f = fixture();
  const root = join(f.config.cgroupRoot, "agents.slice");
  const files = ["memory.high", "memory.swap.max", "pids.max"];
  class DeniedLimits extends Reader {
    constructor(private readonly denied: string[]) {
      super();
    }
    override exact(path: string, optional = false): string | null {
      if (this.denied.includes(basename(path))) {
        this.error(path, new Error("EACCES"));
        return null;
      }
      return super.exact(path, optional);
    }
  }
  let t: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    const s = emptySnapshot();
    s.groups = collectGroups(new Reader(), root, [], 0);
    expect(present(s.groups[0], "the unlimited group")).toMatchObject({
      high: null,
      highRead: true,
      swapMax: null,
      swapMaxRead: true,
      tasksMax: null,
      tasksMaxRead: true,
    });
    t = await mount(
      s,
      { ...f.config, cgroupRoot: root },
      { width: 220, height: 40 },
    );
    await t.press("3");
    const limits = () => {
      const lines = present(t, "the mounted Resources screen")
        .frame()
        .split("\n");
      const start = lines.findIndex((line) => line.includes("Limits"));
      const heading = present(
        lines[start],
        "the selected group's Limits field",
      );
      const labelColumn = heading.indexOf("Limits");
      const valueColumn = heading.indexOf("memory high", labelColumn);
      const end = lines.findIndex(
        (line, index) =>
          index > start && line.slice(labelColumn).startsWith("CPU "),
      );
      expect(valueColumn).toBeGreaterThan(labelColumn);
      expect(end).toBeGreaterThan(start);
      return lines
        .slice(start, end)
        .map((line) => line.slice(valueColumn).trim())
        .join(" ");
    };
    expect(limits()).toContain(
      "memory high none · max none · swap 0 B of none · tasks max none",
    );
    writeFileSync(join(root, "memory.high"), "1048576");
    writeFileSync(join(root, "memory.swap.max"), "0");
    writeFileSync(join(root, "pids.max"), "512");
    for (const denied of [[], ...files.map((file) => [file]), files]) {
      const r = new DeniedLimits(denied);
      const groups = collectGroups(r, root, [], 0);
      expect(r.errors.map((error) => basename(error.source))).toEqual(denied);
      expect(present(groups[0], "the readable group").path).toBe(".");
      expect(present(groups[0], "the limit readings")).toMatchObject({
        highRead: !denied.includes("memory.high"),
        swapMaxRead: !denied.includes("memory.swap.max"),
        tasksMaxRead: !denied.includes("pids.max"),
      });
      await t.update({ ...s, groups, errors: r.errors });
      expect(limits()).toContain(
        `memory high ${denied.includes("memory.high") ? gap : "1.0 MiB"} · max none · swap 0 B of ${denied.includes("memory.swap.max") ? gap : "0 B"} · tasks max ${denied.includes("pids.max") ? gap : "512"}`,
      );
    }
  } finally {
    await t?.close();
    f.cleanup();
  }
});

test("a leaf with no work and little memory is idle; slices and the root never are", () => {
  const mib = 1024 * 1024;
  const rows: [Parameters<typeof groupSnapshot>[0], boolean][] = [
    [{ name: "quiet.service", cpuPercent: 0, memory: 10 * mib }, true],
    [{ name: "quiet.service", cpuPercent: null, memory: null }, true],
    [{ name: "busy.service", cpuPercent: 0.5, memory: 10 * mib }, false],
    [{ name: "fat.service", cpuPercent: 0, memory: 64 * mib }, false],
    [{ name: "app.slice", cpuPercent: 0, memory: 0 }, false],
    [{ path: ".", name: "user@1000.service", cpuPercent: 0, memory: 0 }, false],
  ];
  for (const [overrides, expected] of rows)
    expect(idle(groupSnapshot(overrides))).toBe(expected);
  const s = emptySnapshot();
  s.groups = [
    groupSnapshot({ path: "a.slice", name: "a.slice" }),
    groupSnapshot({
      path: "a.slice/x.service",
      name: "x.service",
      cpuPercent: 0,
      memory: 0,
    }),
  ];
  expect(groupRows(s, false).map((g) => g.path)).toEqual(["a.slice"]);
  expect(groupRows(s, true).length).toBe(2);
});

test("a group's level follows its worst pressure, its cap and its memory threshold", () => {
  const c = defaults();
  const s = emptySnapshot();
  const at = (some: number) =>
    groupSnapshot({ pressure: { cpu: { some, full: 0, total: 0 } } });
  expect(groupLevel(at(c.pressureAmber), s, c)).toBe("ok");
  expect(groupLevel(at(c.pressureAmber + 1), s, c)).toBe("warn");
  expect(groupLevel(at(c.pressureRed + 1), s, c)).toBe("danger");
  expect(groupLevel(groupSnapshot({ memory: 90, high: 100 }), s, c)).toBe(
    "warn",
  );
  expect(groupLevel(groupSnapshot({ memory: 89, high: 100 }), s, c)).toBe("ok");
});

test("a coloured group row carries its cause, and a low cap is a cause only on a lane", () => {
  const c = defaults();
  const mib = 1024 * 1024;
  const capped = (path: string, extra: Partial<Group> = {}) =>
    groupSnapshot({ path, max: 256 * mib, maxRead: true, ...extra });
  const capCause: GroupCause = {
    kind: "cap",
    level: "danger",
    cap: 256 * mib,
    floor: c.memoryFloor,
  };
  const rows: [string, Group[], Lane[], GroupCause | null][] = [
    [
      "a service capped on purpose",
      [capped("app.slice/slack-listen.service", { memory: 70 * mib })],
      [laneSnapshot({ cgroup: "agents.slice/a.scope" })],
      null,
    ],
    [
      "a lane with the same cap",
      [capped("agents.slice/a.scope", { memory: 70 * mib })],
      [laneSnapshot({ cgroup: "agents.slice/a.scope" })],
      capCause,
    ],
    [
      "a slice whose cap holds a lane",
      [capped("agents.slice")],
      [laneSnapshot({ cgroup: "agents.slice/a.scope" })],
      capCause,
    ],
    [
      "a group-less lane under the capped group",
      [capped("x.service", { kernelPath: "/user.slice/x.service" })],
      [laneSnapshot({ cgroup: "/user.slice/x.service/sub" })],
      capCause,
    ],
    [
      "an escaped agent's own group",
      [groupSnapshot({ path: "app.slice/a.scope" })],
      [laneSnapshot({ id: "app.slice/a.scope", unconfined: true })],
      { kind: "unconfined", level: "danger" },
    ],
    [
      "pressure over the red line",
      [
        groupSnapshot({
          pressure: {
            cpu: { some: 1, full: 0, total: 0 },
            io: { some: c.pressureRed + 1, full: 0, total: 0 },
          },
        }),
      ],
      [],
      {
        kind: "pressure",
        level: "danger",
        resource: "io",
        some: c.pressureRed + 1,
        threshold: c.pressureRed,
      },
    ],
    [
      "pressure over the amber line",
      [
        groupSnapshot({
          pressure: {
            memory: { some: c.pressureAmber + 1, full: 0, total: 0 },
          },
        }),
      ],
      [],
      {
        kind: "pressure",
        level: "warn",
        resource: "memory",
        some: c.pressureAmber + 1,
        threshold: c.pressureAmber,
      },
    ],
    [
      "memory near memory high",
      [groupSnapshot({ memory: 95, high: 100 })],
      [],
      { kind: "high", level: "warn", memory: 95, high: 100 },
    ],
  ];
  for (const [name, groups, lanes, cause] of rows) {
    const s = emptySnapshot();
    s.groups = groups;
    s.lanes = lanes;
    const g = present(groups[0], name);
    expect({ name, cause: groupCause(g, s, c) }).toEqual({ name, cause });
    expect({ name, level: groupLevel(g, s, c) }).toEqual({
      name,
      level: cause?.level ?? "ok",
    });
  }
});

test("Resources names the floor for a capped lane and not for a capped service", async () => {
  const c = defaults();
  const mib = 1024 * 1024;
  const rows: [string, string, boolean][] = [
    ["agents.slice/a.scope", "a.scope", true],
    ["app.slice/slack-listen.service", "slack-listen.service", false],
  ];
  for (const [path, name, named] of rows) {
    const s = emptySnapshot();
    s.groups = [
      groupSnapshot({ path, name, max: 256 * mib, memory: 70 * mib }),
    ];
    s.lanes = [laneSnapshot({ cgroup: "agents.slice/a.scope" })];
    const t = await mount(s, c, { width: 120, height: 30 });
    try {
      await t.press("3");
      // The floor is 1 GiB, and nothing else on this screen reads that.
      expect({ path, named: t.frame().includes("1.0 GiB") }).toEqual({
        path,
        named,
      });
    } finally {
      await t.close();
    }
  }
});

test("groups that decode to one name are separated, and hiding rows never renames one", () => {
  const g = (path: string, name: string, pids: number[] = [], memory = 0) =>
    groupSnapshot({
      path,
      parent: path.split("/").slice(0, -1).join("/") || ".",
      name,
      pids,
      memory,
    });
  // Three terminal scopes and two browser scopes decode to one word each.
  const groups = [
    g(".", "user@1000.service"),
    g("app.slice", "app.slice"),
    // Busy enough to survive the idle filter; the other two are not.
    g("app.slice/a", "app-Hyprland-ghostty-3d98e590.scope", [11], 1 << 30),
    g("app.slice/b", "app-Hyprland-ghostty-b95bd288.scope", [22]),
    g("session.slice", "session.slice"),
    g("session.slice/c", "app-Hyprland-ghostty-2ce4140b.scope", [33]),
  ];
  const labels = groupLabels(groups);
  expect(labels.get("app.slice/a")).toBe("ghostty PID 11");
  expect(labels.get("app.slice/b")).toBe("ghostty PID 22");
  expect(labels.get("session.slice/c")).toBe("ghostty PID 33");
  expect(labels.get(".")).toBe("user@1000");
  expect(labels.get("session.slice")).toBe("session");
  expect(new Set(labels.values()).size).toBe(groups.length);
  // Settling the names over the visible rows alone would answer differently,
  // which is why the screen hands over every group: a row must not be renamed
  // by hiding a row somewhere else.
  const s = emptySnapshot();
  s.groups = groups;
  const visible = groupRows(s, false);
  expect(visible.length).toBeLessThan(groups.length);
  const overVisible = groupLabels(visible);
  expect([...overVisible.values()]).not.toEqual(
    visible.map((row) => labels.get(row.path)),
  );
});

test("the tree draws its nesting, and the last child closes its branch", () => {
  const g = (path: string, parent: string) =>
    groupSnapshot({ path, parent, name: path.split("/").at(-1) ?? path });
  const prefixes = treePrefixes([
    g(".", "."),
    g("app.slice", "."),
    g("app.slice/one", "app.slice"),
    g("app.slice/two", "app.slice"),
    g("app.slice/two/deep", "app.slice/two"),
    g("session.slice", "."),
  ]);
  expect(prefixes.get(".")).toBe("");
  expect(prefixes.get("app.slice")).toBe("├─ ");
  expect(prefixes.get("app.slice/one")).toBe("│  ├─ ");
  expect(prefixes.get("app.slice/two")).toBe("│  └─ ");
  // The branch above has ended, so nothing is drawn through its column.
  expect(prefixes.get("app.slice/two/deep")).toBe("│     └─ ");
  expect(prefixes.get("session.slice")).toBe("└─ ");
});

test("a subtree whose parent could not be read keeps the depth it sits at", () => {
  const f = fixture();
  try {
    f.group("a.slice");
    f.group("a.slice/x.service");
    f.group("a.slice/x.service/deep.scope");
    // The collector records a failed read and descends into the children
    // regardless, so a group can be listed while its parent is not.
    rmSync(join(f.config.cgroupRoot, "a.slice", "cpu.stat"));
    const r = new Reader();
    const groups = collectGroups(r, f.config.cgroupRoot, [], 1000);
    const paths = groups.map((g) => g.path);
    expect(paths).not.toContain("a.slice");
    expect(paths).toContain("a.slice/x.service");
    expect(
      r.errors.some((e) => e.source.endsWith(join("a.slice", "cpu.stat"))),
    ).toBe(true);
    // The disconnected subtree keeps its own depth instead of collapsing onto
    // the root, which is the nesting this screen exists to draw.
    const prefixes = treePrefixes(groups);
    expect(prefixes.get("a.slice/x.service")).toBe("   └─ ");
    expect(prefixes.get("a.slice/x.service/deep.scope")).toBe("      └─ ");
    // Every listed group is placed, whatever its parent did.
    for (const g of groups) expect(prefixes.has(g.path)).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("an idle parent filtered from the list still leaves its children nested", () => {
  const g = (path: string, parent: string) =>
    groupSnapshot({ path, parent, name: path.split("/").at(-1) ?? path });
  // `a.slice` is absent from this list, as `groupRows` leaves it when it is
  // idle and a child of it is not.
  const prefixes = treePrefixes([
    g(".", "."),
    g("a.slice/one", "a.slice"),
    g("a.slice/two", "a.slice"),
    g("a.slice/two/deep", "a.slice/two"),
    g("b.slice", "."),
  ]);
  expect(prefixes.get(".")).toBe("");
  expect(prefixes.get("b.slice")).toBe("└─ ");
  expect(prefixes.get("a.slice/one")).toBe("   ├─ ");
  expect(prefixes.get("a.slice/two")).toBe("   └─ ");
  expect(prefixes.get("a.slice/two/deep")).toBe("      └─ ");
});

test("Resources wraps its tiles at a hundred columns and draws a first sample's details whole", async () => {
  const c = defaults();
  const zram = (device: string) => ({
    device,
    original: 1 << 30,
    compressed: 1 << 28,
    used: 1 << 28,
  });
  // The first sample reads no CPU share at all. The control row gives Swap
  // more devices than its tile holds, so the check below has a cut to find.
  const rows: [string, (s: Snapshot) => void, boolean][] = [
    ["first sample", () => {}, false],
    [
      "three zram devices",
      (s) => {
        s.system.zram = [zram("zram0"), zram("zram1"), zram("zram2")];
      },
      true,
    ],
  ];
  for (const [name, plant, cut] of rows) {
    const s = emptySnapshot();
    plant(s);
    const t = await mount(s, c, { width: 100, height: 30 });
    try {
      await t.press("3");
      const lines = t.frame().split("\n");
      const at = (text: string) =>
        lines.findIndex((line) => line.includes(text));
      // Four tiles in ninety-six columns are twenty-two columns each, under
      // the width a tile needs, so they wrap to two rows instead of truncating.
      expect(at("CPU wait"), name).toBeGreaterThan(-1);
      expect(at("Swap"), name).toBeGreaterThan(at("CPU wait"));
      // A tile cuts a detail with the mark, so a tile row without one drew
      // every detail whole.
      const tiles = lines.slice(at("CPU wait"), at("Groups"));
      expect(
        tiles.some((line) => line.includes("…")),
        name,
      ).toBe(cut);
      if (cut) continue;
      const frame = lines.join("\n");
      for (const m of meters(s, c).filter((m) => m.id !== "builds"))
        expect(frame, name).toContain(meterTile(m, s, c).detail);
    } finally {
      await t.close();
    }
  }
});

test("a target whose group has gone is said out loud, not dropped", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.groups = [groupSnapshot({ path: "busy.scope", name: "busy.scope" })];
  /** Resources rendered with a target, reporting what it did with it. */
  async function landOn(target: string) {
    const notices: [string, string][] = [];
    let used = 0;
    const handlers = new Set<KeyHandler>();
    const ui = await testRender(
      <KeyProvider handlers={handlers}>
        <Resources
          snapshot={s}
          config={c}
          target={target}
          onTargetUsed={() => {
            used += 1;
          }}
          onNotice={(text: string, level: string) =>
            notices.push([text, level])
          }
          width={140}
          height={30}
        />
      </KeyProvider>,
      { width: 140, height: 30 },
    );
    try {
      await ui.renderOnce();
      return { used, notices, frame: ui.captureCharFrame() };
    } finally {
      await act(async () => {
        ui.renderer.destroy();
      });
    }
  }
  // A collector refresh between the keypress and this effect can take the row
  // the card named. The request is still consumed, so it cannot fire again on
  // a later sample, and the reader is told rather than left on a screen that
  // looks like they never pressed anything.
  const gone = await landOn("/gone");
  expect(gone.used).toBe(1);
  expect(gone.notices).toEqual([["/gone is no longer in the sample", "warn"]]);
});

test.each(["alpha", "beta"])(
  "Resources selects a requested %s group, including an idle group",
  async (name) => {
    const s = emptySnapshot();
    s.groups = [
      groupSnapshot({ path: "alpha.scope", name: "alpha.scope" }),
      groupSnapshot({ path: "beta.scope", name: "beta.scope", cpuPercent: 1 }),
    ];
    const handlers = new Set<KeyHandler>();
    let used = 0;
    function Requested() {
      const [target, setTarget] = useState<string | null>(`${name}.scope`);
      return (
        <KeyProvider handlers={handlers}>
          <Resources
            snapshot={s}
            config={defaults()}
            target={target}
            onTargetUsed={() => {
              used++;
              setTarget(null);
            }}
            onNotice={() => {}}
            width={140}
            height={30}
          />
        </KeyProvider>
      );
    }
    const ui = await testRender(<Requested />, { width: 140, height: 30 });
    try {
      await ui.renderOnce();
      expect(selectedRow(ui.captureCharFrame())).toContain(name);
      expect(used).toBe(1);
    } finally {
      await act(async () => {
        ui.renderer.destroy();
      });
    }
  },
);
