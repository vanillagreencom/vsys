import { expect, test } from "bun:test";
import type {
  BaseRenderable,
  Renderable,
  ScrollBoxRenderable,
} from "@opentui/core";
import { act } from "react";
import { defaults } from "../config/config";
import { unitLabel } from "../model/naming";
import type { Snapshot } from "../model/types";
import { History } from "../store/history";
import { everyCauseSnapshot, groupSnapshot } from "../test/fixture";
import { mount, selectedRow } from "../test/harness";
import { present } from "../test/present";
import { screenPad, wideWidth } from "./chrome";

type Mounted = Awaited<ReturnType<typeof mount>>;

/** Where a screen draws the selected item's detail below `wideWidth`. */
type Narrow =
  /** Nowhere: the screen has no detail beside a list narrower than this. */
  | "none"
  /** Under the whole list, across the screen. */
  | "below"
  /** Under the selected row, inside that row's block. */
  | "inline";

/**
 * Values planted in the fixture, each longer than the panel's own row, so a
 * panel that cut instead of wrapping loses part of one.
 */
const longGroup = `${"a-long-slice-name-".repeat(3)}first.slice`;
const longOptions = [
  "rw",
  "relatime",
  "compress=zstd:3",
  "ssd",
  "discard=async",
  "space_cache=v2",
  "subvolid=5",
  "subvol=/",
];
const longUnit = `app-Hyprland-${"averylongterminalname".repeat(2)}-b95bd288.scope`;

/**
 * Each screen on the shared split pane, the key that opens it, and where its
 * detail sits on a narrow terminal. `inline` selects a row that has a detail
 * and answers its block's id, whose second child is the detail drawn under
 * it, and how many rows down from the first it is. `whole` is what the wide
 * panel draws in full for that row.
 */
const screens: {
  name: string;
  key: string;
  narrow: Narrow;
  inline?: (t: Mounted) => Promise<{ id: string; downs: number }>;
  whole: string[];
}[] = [
  { name: "Agents", key: "2", narrow: "none", whole: [] },
  // The planted slice is the first row, which Resources opens on.
  { name: "Resources", key: "3", narrow: "below", whole: [longGroup] },
  {
    name: "Storage",
    key: "5",
    narrow: "inline",
    // The first filesystem's first mount, one row under its integrity row.
    inline: async (t) => {
      await t.press("down");
      return { id: "storage-1", downs: 1 };
    },
    whole: [longOptions.join(", ")],
  },
  {
    name: "Timeline",
    key: "6",
    narrow: "inline",
    // The change about the planted unit, walked to with the arrows: the
    // marked row is the one naming what the unit decodes to.
    inline: async (t) => {
      const name = unitLabel(longUnit).slice(0, 20);
      for (let at = 0; at < 30; at++) {
        if (selectedRow(t.frame()).includes(name))
          return { id: `change-${at}`, downs: at };
        await t.press("down");
      }
      throw new Error("No change names the planted unit");
    },
    // The name the row's subject decodes to, which the row cuts at the list's
    // edge, and the unit it was decoded from.
    whole: [longUnit, unitLabel(longUnit)],
  },
];

const find = (t: Mounted, id: string): Renderable | undefined =>
  t.ui.renderer.root.findDescendantById(id) as Renderable | undefined;
const childCount = (t: Mounted, id: string): number =>
  (find(t, id) as BaseRenderable | undefined)?.getChildrenCount() ?? 0;
/**
 * The cells a renderable covers on the frame, with every blank dropped, so a
 * value wrapped over several rows reads as one run of characters.
 */
const cells = (t: Mounted, box: Renderable): string =>
  t
    .frame()
    .split("\n")
    .slice(box.y, box.y + box.height)
    .map((line) => line.slice(box.x, box.x + box.width))
    .join("")
    .replace(/\s/g, "");

function planted(s: Snapshot): Snapshot {
  // A slice is never hidden as idle, so this one leads the Resources tree.
  s.groups = [
    groupSnapshot({ path: "first.slice", parent: ".", name: longGroup }),
    ...s.groups.map((g) =>
      g.name === "gnome.scope" ? { ...g, name: longUnit } : g,
    ),
  ];
  s.storage.volumes = s.storage.volumes.map((v) => ({
    ...v,
    options: longOptions,
  }));
  return s;
}

async function mounted() {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  const first = planted(everyCauseSnapshot(c));
  h.add(first);
  const latest = { ...first, time: first.time + 1000 };
  h.add(latest);
  return { c, h, latest };
}

test("from wideWidth up the selected item's detail sits right of its list, and below it where it was", async () => {
  const { c, h, latest } = await mounted();
  for (const screen of screens) {
    // The narrow side of the threshold first, so the selected row whose detail
    // sits inline there is the row the wide terminal is then checked on.
    let row: { id: string; downs: number } | undefined;
    for (const width of [wideWidth - 1, wideWidth]) {
      const t = await mount(latest, c, { width, height: 44 }, { history: h });
      try {
        await t.press(screen.key);
        if (screen.inline && row === undefined) row = await screen.inline(t);
        else if (row !== undefined)
          for (let down = 0; down < row.downs; down++) await t.press("down");
        const detail = find(t, "split-detail");
        const under = row === undefined ? 0 : childCount(t, row.id);
        const at = { screen: screen.name, width };
        if (width >= wideWidth) {
          const list = present(find(t, "split-list"), "the list column");
          const panel = present(detail, "the detail panel");
          // Beside the list, from its top, and nothing left under the row.
          expect({ ...at, right: panel.x >= list.x + list.width }).toEqual({
            ...at,
            right: true,
          });
          expect({ ...at, top: panel.y }).toEqual({ ...at, top: list.y });
          if (row !== undefined)
            expect({ ...at, under }).toEqual({ ...at, under: 1 });
          // What the selected row stands for, whole in the panel, once the
          // panel's scroll bar has been measured away on the frame after the
          // panel's first.
          await t.settle();
          // Each value found is taken out of what is left, so a value drawn
          // inside another counts once, as the other.
          let drawn = cells(t, panel);
          for (const value of screen.whole) {
            const run = value.replace(/\s/g, "");
            const found = drawn.indexOf(run);
            if (found >= 0)
              drawn = drawn.slice(0, found) + drawn.slice(found + run.length);
            expect({ ...at, value, drawn: found >= 0 }).toEqual({
              ...at,
              value,
              drawn: true,
            });
          }
          continue;
        }
        if (screen.narrow === "below") {
          // Across the screen under the list, where the bottom fields were.
          const panel = present(detail, "the detail under the list");
          const marked = t
            .frame()
            .split("\n")
            .findIndex((line) => line.includes("▍"));
          expect({
            ...at,
            x: panel.x,
            width: panel.width,
            under: marked >= 0 && panel.y > marked,
          }).toEqual({
            ...at,
            x: screenPad,
            width: width - screenPad * 2,
            under: true,
          });
        } else {
          expect({ ...at, panel: detail !== undefined }).toEqual({
            ...at,
            panel: false,
          });
          if (screen.narrow === "inline")
            expect({ ...at, under: under > 1 }).toEqual({ ...at, under: true });
        }
      } finally {
        await t.close();
      }
    }
  }
});

test("the panel opens each newly selected item at its top", async () => {
  const { c, h, latest } = await mounted();
  // Short enough that every group's detail runs past the panel's bottom, so
  // the next group's could stay scrolled where the last one was left.
  const t = await mount(
    latest,
    c,
    { width: wideWidth, height: 14 },
    { history: h },
  );
  try {
    await t.press("3");
    await t.settle();
    const panel = present(
      find(t, "split-detail") as ScrollBoxRenderable | undefined,
      "the detail panel",
    );
    panel.scrollTop = 2;
    expect(panel.scrollTop).toBe(2);
    await t.press("down");
    await t.settle();
    expect(panel.scrollHeight - panel.height).toBeGreaterThanOrEqual(2);
    expect(panel.scrollTop).toBe(0);
  } finally {
    await t.close();
  }
});

/** A Storage screen with more scratch roots than a short terminal shows. */
function manyRoots(c: ReturnType<typeof defaults>): Snapshot {
  const s = everyCauseSnapshot(c);
  s.storage.scratch = Array.from({ length: 30 }, (_, i) => ({
    path: `/scratch/root-${String(i).padStart(2, "0")}`,
    bytes: 1024,
    age: 60,
    error: null,
    origin: "configured" as const,
  }));
  return s;
}

test("a terminal resized across wideWidth keeps the selected Storage row in view", async () => {
  const c = defaults();
  const t = await mount(manyRoots(c), c, { width: wideWidth, height: 20 });
  const resize = async (width: number) => {
    await act(async () => {
      t.ui.resize(width, 20);
    });
    await t.ui.renderOnce();
    await t.settle();
  };
  try {
    await t.press("5");
    // The last root, far below the first screenful, so the list has scrolled.
    await t.press(c.keys.scratch);
    for (let down = 0; down < 29; down++) await t.press("down");
    await t.settle();
    const chosen = selectedRow(t.frame()).match(/\/scratch\/root-\d+/)?.[0];
    expect(chosen).toBe("/scratch/root-29");
    // The list's own scroll box, which holds the scroll position: the same one
    // at both widths, not a fresh one scrolled back to the top.
    const scroller = () =>
      (find(t, "split-list") as BaseRenderable | undefined)?.getChildren()[0];
    const mounted = scroller();
    expect(mounted === undefined).toBe(false);
    for (const width of [wideWidth - 1, wideWidth]) {
      await resize(width);
      expect({ width, same: scroller() === mounted }).toEqual({
        width,
        same: true,
      });
      expect({
        width,
        row: selectedRow(t.frame()).includes(chosen ?? ""),
      }).toEqual({ width, row: true });
    }
  } finally {
    await t.close();
  }
});

test("the panel draws a selected scratch root's failure whole, with no origin known", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  const error = `Scratch path is not a directory: /tmp/${"a-scratch-root-".repeat(4)}end`;
  s.storage.scratch = [
    { path: "/tmp/scratch", bytes: null, age: null, error, origin: null },
  ];
  const t = await mount(s, c, { width: wideWidth, height: 44 });
  try {
    await t.press("5");
    await t.press(c.keys.scratch);
    await t.settle();
    const panel = present(find(t, "split-detail"), "the detail panel");
    expect(cells(t, panel).includes(error.replace(/\s/g, ""))).toBe(true);
  } finally {
    await t.close();
  }
});
