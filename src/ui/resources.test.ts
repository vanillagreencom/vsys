import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, groupSnapshot } from "../test/fixture";
import {
  groupLabels,
  groupLevel,
  groupRows,
  idle,
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
