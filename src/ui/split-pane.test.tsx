import { expect, test } from "bun:test";
import type { BaseRenderable, Renderable } from "@opentui/core";
import { defaults } from "../config/config";
import { History } from "../store/history";
import { everyCauseSnapshot } from "../test/fixture";
import { mount } from "../test/harness";
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
 * Each screen on the shared split pane, the key that opens it, and where its
 * detail sits on a narrow terminal. `inline` selects a row that has a detail
 * and answers its block's id, whose second child is the detail drawn under
 * it, and how many rows down from the first it is.
 */
const screens: {
  name: string;
  key: string;
  narrow: Narrow;
  inline?: (t: Mounted) => Promise<{ id: string; downs: number }>;
}[] = [
  { name: "Agents", key: "2", narrow: "none" },
  { name: "Resources", key: "3", narrow: "below" },
  {
    name: "Storage",
    key: "5",
    narrow: "inline",
    // The first filesystem's integrity row, which Storage opens on.
    inline: async () => ({ id: "storage-0", downs: 0 }),
  },
  {
    name: "Timeline",
    key: "6",
    narrow: "inline",
    // The first change whose block draws anything under its row, walked to
    // with the arrows: only a change about a cgroup has a unit to draw.
    inline: async (t) => {
      for (let at = 0; at < 30; at++) {
        if (childCount(t, `change-${at}`) > 1)
          return { id: `change-${at}`, downs: at };
        await t.press("down");
      }
      throw new Error("No change draws a detail under its row");
    },
  },
];

const find = (t: Mounted, id: string): Renderable | undefined =>
  t.ui.renderer.root.findDescendantById(id) as Renderable | undefined;
const childCount = (t: Mounted, id: string): number =>
  (find(t, id) as BaseRenderable | undefined)?.getChildrenCount() ?? 0;

async function mounted() {
  const c = { ...defaults(), pressureHoldSeconds: 0 };
  const h = new History(c);
  const first = everyCauseSnapshot(c);
  first.groups = first.groups.map((g) =>
    g.name === "gnome.scope"
      ? { ...g, name: "app-Hyprland-ghostty-b95bd288.scope" }
      : g,
  );
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
          continue;
        }
        expect({ ...at, list: find(t, "split-list") }).toEqual({
          ...at,
          list: undefined,
        });
        if (screen.narrow === "below") {
          // Across the screen under the list, where the bottom fields were.
          const panel = present(detail, "the detail under the list");
          expect({ ...at, x: panel.x, width: panel.width }).toEqual({
            ...at,
            x: screenPad,
            width: width - screenPad * 2,
          });
        } else {
          expect({ ...at, detail }).toEqual({ ...at, detail: undefined });
          if (screen.narrow === "inline")
            expect({ ...at, under: under > 1 }).toEqual({ ...at, under: true });
        }
      } finally {
        await t.close();
      }
    }
  }
});
