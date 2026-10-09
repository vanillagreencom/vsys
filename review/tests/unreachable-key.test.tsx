import { expect, test } from "bun:test";
import { act } from "react";
import type { Config } from "../../src/config/config";
import { defaults } from "../../src/config/config";
import { emptySnapshot } from "../../src/test/fixture";
import { mount } from "../../src/test/harness";

test("Settings refuses a key binding no keypress can produce", async () => {
  const c = defaults();
  const s = emptySnapshot();
  let saved: Config | undefined;
  const t = await mount(
    s,
    c,
    { width: 140, height: 40 },
    {
      onSave: async (next) => {
        saved = next;
      },
    },
  );
  try {
    await t.press("7");
    await t.press("/");
    for (const ch of "keys.open") await t.press(ch);
    await t.press("enter"); // close the find box, keep the filter
    await t.press("enter"); // open the editor on keys.open
    expect(t.frame()).toContain("Enter saves");
    await act(async () => {
      t.ui.mockInput.pressKey("END");
      for (let i = 0; i < 6; i++) t.ui.mockInput.pressBackspace();
    });
    // Every screen labels this key "Enter"; the reader writes it that way.
    await act(async () => {
      await t.ui.mockInput.typeText("enter");
    });
    await t.press("enter");
    // The save went through: the binding is now a name no key event carries.
    const accepted = saved?.keys.open;
    // Enter on the selected row no longer opens anything.
    await t.press("enter");
    const opened = t.frame().includes("saves ·");
    expect({ accepted, opened }).toEqual({ accepted: undefined, opened: true });
  } finally {
    await t.close();
  }
});
