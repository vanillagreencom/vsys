import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import {
  firstRow,
  resolvedRow,
  type Selection,
  useSelection,
} from "./selection";

test("a selection resolves to its item wherever it moved, else to the nearest row", () => {
  // The rows drawn, the selection held, and the row it resolves to.
  const cases: [string, string[], Selection, number][] = [
    ["the chosen item where it was", ["a", "b", "c"], { index: 1, id: "b" }, 1],
    ["the chosen item moved down", ["x", "a", "b"], { index: 1, id: "b" }, 2],
    ["the chosen item moved up", ["b", "c"], { index: 1, id: "b" }, 0],
    ["a gone item keeps its row", ["a", "c", "d"], { index: 1, id: "b" }, 1],
    ["a gone item past the end", ["a"], { index: 2, id: "c" }, 0],
    ["nothing chosen yet", ["a", "b"], firstRow, 0],
    ["no rows names none", [], { index: 1, id: "b" }, -1],
    ["a row number below the first", ["a", "b"], { index: -1, id: null }, 0],
  ];
  for (const [name, ids, selection, row] of cases)
    expect({ name, row: resolvedRow(ids, selection) }).toEqual({
      name,
      row,
    });
});

/**
 * One list under `useSelection`, whose rows a test replaces between renders
 * the way a sample does, reporting the item it draws as selected.
 */
async function list(initial: string[]) {
  let publish: ((ids: string[]) => void) | null = null;
  let choose: ((index: number) => void) | null = null;
  let held: Selection = firstRow;
  function Probe() {
    const [ids, setIds] = useState(initial);
    const [selection, setSelection] = useState(firstRow);
    const chosen = useSelection(ids, selection, setSelection);
    publish = setIds;
    choose = chosen.choose;
    held = selection;
    return <text>{`on ${ids[chosen.selected] ?? "nothing"}`}</text>;
  }
  const ui = await testRender(<Probe />, { width: 20, height: 1 });
  await ui.renderOnce();
  const on = () => ui.captureCharFrame().trim();
  return {
    on,
    held: () => held,
    rows: async (ids: string[]) => {
      await act(async () => publish?.(ids));
      await ui.renderOnce();
    },
    pick: async (index: number) => {
      await act(async () => choose?.(index));
      await ui.renderOnce();
    },
    close: async () => {
      await act(async () => {
        ui.renderer.destroy();
      });
    },
  };
}

test("a row that took over from a gone item stays chosen when another lands on its number", async () => {
  const t = await list(["a", "b", "c", "d"]);
  try {
    await t.pick(2);
    expect(t.on()).toBe("on c");
    // The chosen item leaves, and the row now at its number takes over.
    await t.rows(["a", "b", "d"]);
    expect(t.on()).toBe("on d");
    // A re-sorting list puts a newcomer on exactly that number. Resolved but
    // not recorded, the selection still names the gone item and its number,
    // so the highlight would leave the row the reader is on for the newcomer.
    await t.rows(["a", "b", "x", "d"]);
    expect(t.on()).toBe("on d");
    expect(t.held()).toEqual({ index: 3, id: "d" });
  } finally {
    await t.close();
  }
});

test("the first row is a choice before any key, and an empty list keeps the choice", async () => {
  const t = await list(["a", "b"]);
  try {
    // Recorded on the first render that has rows, so a row arriving above
    // does not take the highlight off the row the reader was reading.
    expect(t.held()).toEqual({ index: 0, id: "a" });
    await t.rows(["z", "a", "b"]);
    expect(t.on()).toBe("on a");
    await t.pick(2);
    expect(t.on()).toBe("on b");
    // With no rows nothing is selected, and nothing is recorded over the
    // choice, so the rows coming back land the reader where they were.
    await t.rows([]);
    expect(t.on()).toBe("on nothing");
    expect(t.held()).toEqual({ index: 2, id: "b" });
    await t.rows(["b", "c"]);
    expect(t.on()).toBe("on b");
  } finally {
    await t.close();
  }
});
