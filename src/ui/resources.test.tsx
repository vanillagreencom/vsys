import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { collectGroups } from "../collect/cgroups";
import { Reader } from "../collect/io";
import { defaults } from "../config/config";
import type { Group, Lane, Snapshot, WardenNearLimit } from "../model/types";
import { causes, meters } from "../model/verdict";
import {
  emptySnapshot,
  fixture,
  groupSnapshot,
  laneSnapshot,
  serviceSnapshot,
} from "../test/fixture";
import { mount, selectedRow, shown } from "../test/harness";
import { present } from "../test/present";
import { attention, meterTile } from "./attention";
import { osc52 } from "./clipboard";
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
  resourceRows,
  type ServiceState,
  serviceState,
  treePrefixes,
} from "./resources";
import { levelColor, ui } from "./theme";

test("an eighty-column group table keeps unselected warning and error states visible", async () => {
  const s = emptySnapshot();
  s.groups = [
    groupSnapshot({ name: "calm.slice", path: "calm.slice" }),
    ...[
      ["warm", 15],
      ["busy", 40],
    ].map(([name, some]) =>
      groupSnapshot({
        name: `${name}.slice`,
        path: `${name}.slice`,
        pressure: { cpu: { some: Number(some), full: 0, total: 0 } },
      }),
    ),
  ];
  const t = await mount(s, defaults(), { width: 80, height: 45 });
  try {
    await t.press("3");
    expect(t.frame()).toContain("State");
    for (const [name, word, role] of [
      ["warm", "Warning", ui.warn],
      ["busy", "Error", ui.danger],
    ] as const) {
      const row = present(
        t.ui
          .captureSpans()
          .lines.find((line) =>
            line.spans.some((span) => span.text.includes(name)),
          ),
        `${name} group`,
      );
      expect(
        row.spans.some(
          (span) => span.text.trim() === word && span.fg.equals(role),
        ),
      ).toBe(true);
    }
  } finally {
    await t.close();
  }
});

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
    const field = (label: string) => {
      const frame = present(t, "Resources").frame().split("\n");
      const col = present(
        frame.find((line) => line.includes("Selected")),
        "Selected heading",
      ).indexOf("Selected");
      return present(
        frame.find((line) => line.slice(col).startsWith(label)),
        label,
      )
        .slice(col + 12, -2)
        .trim();
    };
    expect(field("Memory high")).toBe("no limit");
    expect(field("Memory max")).toBe("no limit");
    expect(field("Swap")).toBe("0 B used; no limit");
    expect(field("Tasks max")).toBe("no limit");
    expect(field("CPU quota")).toBe("no limit");
    expect(field("Status")).toBe("OK");
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
      expect(field("Memory high")).toBe(
        denied.includes("memory.high") ? gap : "1.0 MiB",
      );
      expect(field("Memory max")).toBe("no limit");
      expect(field("Swap")).toBe(
        `0 B used; ${denied.includes("memory.swap.max") ? gap : "limit 0 B"}`,
      );
      expect(field("Tasks max")).toBe(
        denied.includes("pids.max") ? gap : "512",
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
  const rows: [
    string,
    Group[],
    Lane[],
    GroupCause | null,
    WardenNearLimit[]?,
  ][] = [
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
      "working memory near memory high",
      [
        groupSnapshot({
          memory: 150,
          high: 100,
          fileStat: { inactiveFile: 60, fileDirty: 3, fileWriteback: 2 },
        }),
      ],
      [],
      { kind: "high", level: "warn", working: 95, high: 100 },
    ],
    [
      "file cache over memory high with working memory under it",
      [
        groupSnapshot({
          memory: 150,
          high: 100,
          fileStat: { inactiveFile: 100, fileDirty: 0, fileWriteback: 0 },
        }),
      ],
      [],
      null,
    ],
    [
      "working memory near memory high in a scope the warden warns for",
      [
        groupSnapshot({
          kernelPath: "/user.slice/agents.slice/a.scope",
          memory: 95,
          high: 100,
        }),
      ],
      [],
      null,
      [{ kernelPath: "/user.slice/agents.slice/a.scope", near: ["memory"] }],
    ],
  ];
  for (const [name, groups, lanes, cause, warden] of rows) {
    const s = emptySnapshot();
    s.groups = groups;
    s.lanes = lanes;
    if (warden) s.wardenNearLimits = warden;
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
  // The first sample reads no CPU share. Each additional zram device needs
  // its own labelled line, separate from the whole-machine swap total.
  const rows: [string, (s: Snapshot) => void][] = [
    ["first sample", () => {}],
    [
      "three zram devices",
      (s) => {
        s.system.zram = [zram("zram0"), zram("zram1"), zram("zram2")];
      },
    ],
  ];
  for (const [name, plant] of rows) {
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
      ).toBe(false);
      if (name === "three zram devices") {
        for (const device of ["zram0", "zram1", "zram2"])
          expect(
            tiles.some((line) =>
              line.includes(`${device}: 1.0 GiB compressed to 256.0 MiB`),
            ),
          ).toBe(true);
        expect(tiles.join("\n")).not.toMatch(/of .*on zram/);
      }
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
  async function landOn(target: { kind: "group"; path: string }) {
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
  const gone = await landOn({ kind: "group", path: "/gone" });
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
      const [target, setTarget] = useState<{
        kind: "group";
        path: string;
      } | null>({ kind: "group", path: `${name}.scope` });
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

test("a group with an unread threshold input is graded a warning, not clear", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const unread = groupSnapshot({
    cpuPercent: 5,
    memory: null,
    high: 100,
    pressure: { cpu: null, memory: null, io: null },
  });
  const partly = groupSnapshot({
    pressure: { cpu: { some: 0, full: 0, total: 0 }, memory: null },
  });
  const memoryOnly = groupSnapshot({
    memory: null,
    high: 100,
    pressure: {
      cpu: { some: 0, full: 0, total: 0 },
      memory: { some: 0, full: 0, total: 0 },
      io: { some: 0, full: 0, total: 0 },
    },
  });
  for (const g of [unread, partly, memoryOnly]) {
    expect(groupCause(g, s, c)).toEqual({ kind: "unread", level: "warn" });
    expect(groupLevel(g, s, c)).toBe("warn");
  }
  s.groups = [unread];
  const t = await mount(s, c, { width: 100, height: 40 });
  try {
    await t.press(c.keys.resources);
    expect(t.frame()).toContain("a threshold reading is not available");
  } finally {
    await t.close();
  }
});

test("Resources displays and orders measured service windows without grading warm-up CPU", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.groups = [
    groupSnapshot({ path: "a.scope", name: "a.scope", cpuPercent: 1 }),
  ];
  const unit = (name: string, o: Parameters<typeof serviceSnapshot>[0]) =>
    serviceSnapshot({
      path: `system.slice/${name}.service`,
      name: `${name}.service`,
      ...o,
    });
  const hot = c.serviceCpuPercent * 2;
  const cool = c.serviceCpuPercent / 5;
  const rows: [ReturnType<typeof serviceSnapshot>, ServiceState][] = [
    [
      unit("unread", { read: false, cpuHourPercent: null }),
      { kind: "unread", level: "warn" },
    ],
    [
      unit("cool", { cpuHourPercent: cool }),
      { kind: "clear", level: "ok", hour: cool },
    ],
    [
      unit("young", { cpuHourPercent: null }),
      { kind: "measuring", level: "ok" },
    ],
    [
      unit("warming", { cpuSoFarPercent: 30, cpuSoFarMs: 12 * 60_000 }),
      { kind: "warming", level: "ok", average: 30, spanMs: 12 * 60_000 },
    ],
    [
      unit("zero", { cpuSoFarPercent: 0, cpuSoFarMs: 60_000 }),
      { kind: "warming", level: "ok", average: 0, spanMs: 60_000 },
    ],
    [
      unit("hot", {
        cpuHourPercent: hot,
        cpuSoFarPercent: 99,
        cpuSoFarMs: 60_000,
      }),
      {
        kind: "busy",
        level: "warn",
        hour: hot,
        threshold: c.serviceCpuPercent,
      },
    ],
  ];
  s.services = rows.map(([service]) => service);
  // The row is graded by the units the service cause raised, so the table and
  // the card cannot disagree about which unit is busy.
  const busy = new Set(
    causes(s, c)
      .find((cause) => cause.id === "service-cpu")
      ?.groups.map((g) => g.path),
  );
  for (const [service, expected] of rows)
    expect(serviceState(service, busy, c), service.name).toEqual(expected);
  expect(resourceRows(s, false).map((row) => [row.kind, row.path])).toEqual([
    ["group", "a.scope"],
    ["service", "system.slice/hot.service"],
    ["service", "system.slice/warming.service"],
    ["service", "system.slice/cool.service"],
    ["service", "system.slice/zero.service"],
    ["service", "system.slice/unread.service"],
    ["service", "system.slice/young.service"],
  ]);
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press(c.keys.resources);
    const lines = t.frame().split("\n");
    const row = (name: string) =>
      present(
        lines.find((line) => line.trimStart().startsWith(name)),
        `the ${name} row`,
      );
    expect(row("hot")).toContain("50.0%");
    expect(row("hot")).toContain("· 1h");
    expect(row("cool")).toContain("5.0%");
    // These are the window labels and bar the Resources reader consumes.
    expect(row("warming")).toContain("30.0% · 12m");
    expect(row("warming")).toMatch(/██/);
    expect(row("zero")).toContain("0.0% · 1m");
    expect(row("zero")).toContain("────────");
    expect(
      lines.find((line) => line.includes("Service") && line.includes("CPU")),
    ).toBeDefined();
    expect(t.frame()).not.toContain("Hour avg %/core");
    for (const name of ["unread", "young"])
      expect(row(name)).not.toMatch(/\d%/);
    // A unit vsys has watched for under an hour may have run for days, so
    // the cell names the reading, never the unit's age.
    expect(row("young")).toContain("measuring");
    // The drawn row carries the same grade: the busy unit is marked, the one
    // under the threshold is not.
    const colour = (name: string) => {
      for (const line of t.ui.captureSpans().lines) {
        const span = line.spans.find((span) => span.text.includes(name));
        if (span) return shown(span.fg, "fg");
      }
      return "missing";
    };
    const warn = shown(levelColor("warn"), "fg");
    expect(colour("hot")).toBe("default fg");
    const hot = present(
      t.ui
        .captureSpans()
        .lines.find((line) =>
          line.spans.some((span) => span.text.includes("hot")),
        ),
      "hot service row",
    );
    expect(
      hot.spans.some(
        (span) => span.text.trim() === "Warning" && span.fg.equals(ui.warn),
      ),
    ).toBe(true);
    expect(colour("cool")).not.toBe(warn);
    expect(colour("cool")).not.toBe("missing");
    expect(colour("warming")).not.toBe(warn);
    // The keyboard leaves the last group for the busiest service.
    await t.press("down");
    expect(selectedRow(t.frame())).toMatch(/^hot\b/);
    await t.press("down");
    expect(selectedRow(t.frame())).toMatch(/^warming\b/);
    const detailLines = t.frame().split("\n");
    const panelColumn = present(
      detailLines.find((line) => line.includes("Status")),
      "the selected service status",
    ).indexOf("Status");
    const detail = detailLines
      .map((line) => line.slice(panelColumn))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(detail).toContain(
      "averaged 30.0% of one core over the last 12 minutes;",
    );
    expect(detail).toContain("the hour average needs 48 more minutes");
    await t.update({
      ...s,
      services: s.services.filter((service) => service.cpuHourPercent !== null),
    });
    expect(t.frame()).toContain("Hour avg %/core");
    expect(t.frame()).not.toContain("· 1h");
  } finally {
    await t.close();
  }
});

test("the service CPU card copies its journal read and Enter lands on the unit's row", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // More groups than the screen holds: the services table keeps its share,
  // so the unit the card names, and the one beside it, stay in view.
  s.groups = Array.from({ length: 60 }, (_, i) => `g${i}`).map((name) =>
    groupSnapshot({
      path: `${name}.scope`,
      name: `${name}.scope`,
      cpuPercent: 1,
    }),
  );
  s.services = [
    serviceSnapshot({
      path: "system.slice/calm.service",
      name: "calm.service",
      cpuHourPercent: 1,
    }),
    serviceSnapshot({
      path: "system.slice/loop.service",
      name: "loop.service",
      cpuHourPercent: c.serviceCpuPercent * 2,
    }),
  ];
  const card = present(
    attention(s, c).find((item) => item.id === "service-cpu"),
    "the service CPU card",
  );
  expect(card.target).toEqual({
    kind: "service",
    path: "system.slice/loop.service",
  });
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press(c.keys.home);
    await t.press(c.keys.copy);
    // The shell reads the copied line, so it is pinned whole: a read of the
    // unit's journal, and no restart.
    expect(t.written).toEqual([
      osc52("journalctl -u loop.service --since '1 hour ago'"),
    ]);
    await t.press("enter");
    expect(selectedRow(t.frame())).toMatch(/^loop\b/);
    expect(
      t
        .frame()
        .split("\n")
        .some((line) => /^\s*calm\b/.test(line)),
    ).toBe(true);
  } finally {
    await t.close();
  }
});

test.each([
  { width: 80, height: 24, alone: true },
  { width: 100, height: 28, alone: false },
])(
  "at $width x $height the selected row and every detail field stay on the screen",
  async ({ alone, ...size }) => {
    const c = defaults();
    const s = emptySnapshot();
    s.groups = Array.from({ length: 12 }, (_, i) =>
      groupSnapshot({
        path: `g${i}.scope`,
        name: `g${i}.scope`,
        cpuPercent: 1,
      }),
    );
    s.services = Array.from({ length: 30 }, (_, i) =>
      serviceSnapshot({
        path: `system.slice/s${i}.service`,
        name: `s${i}.service`,
        cpuHourPercent: i,
      }),
    );
    /** The heading line of the table titled `title`, if it is drawn. */
    const heading = (frame: string, title: string) =>
      frame.split("\n").find((line) => line.trimStart().startsWith(title));
    /** Whether the detail draws the field `label`, at the start of a line. */
    const field = (frame: string, label: string) =>
      frame
        .split("\n")
        .some((line) => new RegExp(`^\\s*${label}\\b`).test(line));
    const t = await mount(s, c, size);
    try {
      await t.press(c.keys.resources);
      await t.press("down");
      let frame = t.frame();
      expect(selectedRow(frame)).toMatch(/g1\b/);
      // A table drawn alone names the other, so the reader knows the arrows
      // reach it; where both are drawn, neither heading carries the note.
      expect({
        groups: heading(frame, "Groups"),
        services: heading(frame, "System services") !== undefined,
      }).toEqual({
        groups: expect.stringContaining(
          alone ? "Groups  12 · 30 system services below " : "Groups  12 ─",
        ),
        services: !alone,
      });
      for (const label of ["Unit", "Status", "Memory high"])
        expect({ label, drawn: field(frame, label) }).toEqual({
          label,
          drawn: true,
        });
      const fields = present(
        t.ui.renderer.root.findDescendantById("resource-fields"),
        "stacked resource fields",
      );
      expect(t.frame()).toContain("PgUp/PgDn");
      const fieldFrame = () =>
        t
          .frame()
          .split("\n")
          .slice(fields.y, fields.y + fields.height)
          .join("\n");
      const reached = new Set<string>();
      for (let i = 0; i < 4; i++) {
        await t.press("\u001b[6~");
        for (const label of [
          "CPU quota",
          "Page cache",
          "Written",
          "CPU wait",
          "Memory wait",
          "Disk wait",
        ])
          if (field(fieldFrame(), label)) reached.add(label);
      }
      expect([...reached].sort()).toEqual(
        [
          "CPU quota",
          "Page cache",
          "Written",
          "CPU wait",
          "Memory wait",
          "Disk wait",
        ].sort(),
      );
      expect(selectedRow(t.frame())).toMatch(/g1\b/);
      for (let i = 0; i < 4; i++) await t.press("\u001b[5~");
      expect(field(t.frame(), "Unit")).toBe(true);
      if (!(fields instanceof ScrollBoxRenderable))
        throw new Error("resource-fields is not a scroll viewport");
      for (let i = 0; i < fields.scrollHeight; i++)
        await t.wheel(fields.x + 15, fields.y + 2, "down");
      expect(field(fieldFrame(), "Disk wait")).toBe(true);
      // Past the last group, the busiest service.
      for (let i = 1; i < s.groups.length; i++) await t.press("down");
      frame = t.frame();
      expect(selectedRow(frame)).toMatch(/^s29\b/);
      expect({
        groups: heading(frame, "Groups") !== undefined,
        services: heading(frame, "System services"),
      }).toEqual({
        groups: !alone,
        services: expect.stringContaining(
          alone
            ? "System services  30 · 12 groups above "
            : "System services  30 ─",
        ),
      });
      for (const label of ["Unit", "Status", "Cgroup"])
        expect({ label, drawn: field(frame, label) }).toEqual({
          label,
          drawn: true,
        });
    } finally {
      await t.close();
    }
  },
);

test("Resources labels each selected value and expresses a quota in percent of one core", async () => {
  const c = defaults(),
    s = emptySnapshot();
  s.groups = [
    groupSnapshot({
      name: "agents.slice",
      cpuMax: "50000 100000",
      tasks: 42,
      cpuPercent: 25,
      cache: 4096,
      writeRate: 1024,
      pressure: {
        cpu: { some: 1, full: 0, total: 0 },
        memory: { some: 2, full: 0, total: 0 },
        io: { some: 3, full: 0, total: 0 },
      },
    }),
  ];
  s.system.memory = {
    MemTotal: 1024,
    MemAvailable: 512,
    SwapTotal: 66249867264,
    SwapFree: 63800000000,
  };
  s.system.zram = [
    {
      device: "zram0",
      original: 2362232013,
      compressed: 897581056,
      used: 897581056,
    },
  ];
  const t = await mount(s, c, { width: 180, height: 54 });
  try {
    await t.press("3");
    const rows = t.frame().split("\n");
    for (const label of [
      "Memory high",
      "Memory max",
      "Swap",
      "Tasks max",
      "CPU weight",
      "CPU quota",
      "Page cache",
      "Written",
      "CPU wait",
      "Memory wait",
      "Disk wait",
    ])
      expect(rows.some((row) => row.includes(label))).toBe(true);
    expect(t.frame()).toMatch(/CPU quota\s+50.0% of one core/);
    expect(t.frame()).toMatch(/Status\s+OK/);
    expect(t.frame()).toContain("desktop swap");
    expect(t.frame()).toContain("of 61.7 GiB");
    expect(t.frame()).toContain("zram0: 2.2 GiB compressed to 856.0 MiB");
    const selected = selectedRow(t.frame());
    expect(selected).toMatch(/\b42\s+OK/);
    expect(selected).not.toContain("42 tasks");
    await t.update({
      ...s,
      groups: [
        groupSnapshot({
          name: "agents.slice",
          cpuMax: "250000 100000",
          cpuPercent: 25,
        }),
      ],
    });
    expect(t.frame()).toMatch(/CPU quota\s+250.0% of one core/);
  } finally {
    await t.close();
  }
});
