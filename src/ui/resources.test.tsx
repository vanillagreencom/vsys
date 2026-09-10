import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { collectGroups } from "../collect/cgroups";
import { Reader } from "../collect/io";
import { defaults } from "../config/config";
import { emptySnapshot, fixture, groupSnapshot } from "../test/fixture";
import { mount } from "../test/harness";
import { type KeyHandler, KeyProvider } from "./keys";
import {
  groupLabels,
  groupLevel,
  groupRows,
  idle,
  Resources,
  treePrefixes,
} from "./resources";

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
  const capped = groupSnapshot({ max: c.memoryFloor - 1, maxRead: true });
  s.groups = [capped];
  expect(groupLevel(capped, s, c)).toBe("danger");
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
      ui.renderer.destroy();
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
