import { expect, test } from "bun:test";
import { act } from "react";
import type { Config } from "../config/config";
import { choices, defaults } from "../config/config";
import type { Snapshot } from "../model/types";
import { History } from "../store/history";
import { emptySnapshot, everyCauseSnapshot } from "../test/fixture";
import { isChildLine, mount, selectedRow } from "../test/harness";
import { settingGroups, settingHelp } from "./settings";
import { settingItems, sourceCounts } from "./settings-screen";

test("every stored setting sits in exactly one group, and no group names a stranger", () => {
  const known = Object.keys(defaults()).filter((key) => key !== "keys");
  const grouped = settingGroups.flatMap(([, keys]) => keys);
  expect(new Set(grouped).size).toBe(grouped.length);
  expect([...grouped].sort()).toEqual([...known].sort());
});

test("the Settings list opens with the sources row and ends with the keys", () => {
  const items = settingItems(defaults());
  expect(items[0]).toEqual({ kind: "sources" });
  expect(items.at(-1)).toEqual({ kind: "setting", key: "keys.exportMarkdown" });
  expect(items.filter((i) => i.kind === "setting").length).toBe(
    Object.keys(defaults()).length - 1 + Object.keys(defaults().keys).length,
  );
});

test("unreadable sources are counted once each, most failed reads first", () => {
  const s = emptySnapshot();
  s.errors = [
    { source: "/proc/2", message: "denied" },
    { source: "/proc/1", message: "denied" },
    { source: "/proc/2", message: "denied" },
    { source: "/proc/0", message: "denied" },
  ];
  expect(sourceCounts(s)).toEqual([
    ["/proc/2", 2],
    ["/proc/0", 1],
    ["/proc/1", 1],
  ]);
  expect(sourceCounts(emptySnapshot())).toEqual([]);
});

test("Settings edits a value in place and honours a changed quit binding", async () => {
  const c = defaults();
  c.keys.quit = "alt+q";
  const s = emptySnapshot();
  let saved: Config | undefined;
  let quits = 0;
  const t = await mount(s, c, undefined, {
    onSave: async (next) => {
      saved = next;
    },
    onQuit: () => {
      quits++;
    },
  });
  try {
    await t.press("7");
    expect(t.frame()).toContain("Refresh interval");
    // The capability rows and the unreadable-sources row come before the
    // settings, and the refresh interval is the last of the five Display
    // settings above it.
    const above = s.capabilities.length + 1 + 5;
    for (let i = 0; i < above; i++) await t.press("down");
    await t.press("enter");
    expect(t.frame()).toContain("Enter saves");
    await act(async () => {
      t.ui.mockInput.pressKey("END");
      for (let i = 0; i < 4; i++) t.ui.mockInput.pressBackspace();
    });
    await act(async () => {
      await t.ui.mockInput.typeText("500");
    });
    await t.press("enter");
    expect(saved?.refreshMs).toBe(500);
    // While the editor is open, a tab digit is text, never navigation.
    await t.press("enter");
    await act(async () => {
      await t.ui.mockInput.typeText("2");
    });
    await t.ui.renderOnce();
    expect(t.frame()).toContain("Enter saves");
    await t.press("escape");
    await act(async () => {
      t.ui.mockInput.pressKey("q", { meta: true });
    });
    expect(quits).toBe(1);
    await act(async () => {
      t.ui.mockInput.pressCtrlC();
    });
    expect(quits).toBe(2);
  } finally {
    await t.close();
  }
});

test("Settings lists a capability it could not read, with the reason", async () => {
  const c = defaults();
  const s = everyCauseSnapshot(c);
  s.capabilities = s.capabilities.map((cap) =>
    cap.id === "psi"
      ? {
          ...cap,
          available: false,
          failure: "absent" as const,
          source: "/proc/pressure/cpu",
          detail: "ENOENT: no such file or directory",
        }
      : cap,
  );
  const t = await mount(s, c, { width: 200, height: 40 });
  try {
    await t.press("7");
    const settings = t.frame();
    expect(settings).toContain("Data sources  1 not available");
    // The marker says there is more here before the reader presses anything.
    expect(settings).toMatch(
      /○ ▸ Pressure stall information\s+no PSI on this kernel/,
    );
    expect(settings).toMatch(/● Resource groups \(cgroup v2\)\s+available/);
    expect(settings).toMatch(/● Resource groups \(cgroup v2\)\s+available/);
  } finally {
    await t.close();
  }
});

test("Settings opens on a snapshot stored before the capability probe", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // What History.at returns for a row an older build wrote.
  s.capabilities = [];
  const t = await mount(s, c, { width: 160, height: 40 });
  try {
    await t.press("7");
    const frame = t.frame();
    expect(frame).toContain("before vsys probed its sources");
    // The list shows the value in the unit the reader reads; the editor
    // still opens the stored number.
    expect(frame).toMatch(/Refresh interval\s+1s/);
    expect(frame).toMatch(/Low memory limit\s+1\.0 GiB/);
    expect(frame).toMatch(/Save history\s+Off/);
    expect(frame).toMatch(/Table columns\s+name, account, cwd, and 18 more/);
    expect(frame).not.toContain("not available");
  } finally {
    await t.close();
  }
});

test("Settings reports the running program while a past sample is pinned", async () => {
  const c = defaults();
  // A retained sample an older build wrote, and a live one that probed.
  const stored = emptySnapshot(1000);
  stored.capabilities = [];
  const live = emptySnapshot(2000);
  live.capabilities = live.capabilities.map((cap) =>
    cap.id === "psi"
      ? {
          ...cap,
          available: false,
          failure: "absent" as const,
          source: "/proc/pressure/cpu",
          detail: "ENOENT: no such file or directory",
        }
      : cap,
  );
  const h = new History(c);
  h.add(stored);
  const t = await mount(live, c, { width: 160, height: 40 }, { history: h });
  try {
    await t.press("p");
    expect(t.frame()).toContain("show ");
    await t.press("7");
    expect(t.frame()).toContain("no PSI on this kernel");
  } finally {
    await t.close();
  }
});

/**
 * How far down a setting sits, from the same list the screen selects through.
 * Counting rows in the frame would break on the first row that scrolls.
 */
function rowIndex(c: Config, s: Snapshot, key: string): number {
  const at = settingItems(c, s.capabilities).findIndex(
    (item) => item.kind === "setting" && item.key === key,
  );
  expect(at).toBeGreaterThan(-1);
  return at;
}

/** Open Settings and put the selection on one setting's row. */
async function onSetting(
  t: Awaited<ReturnType<typeof mount>>,
  c: Config,
  s: Snapshot,
  key: string,
) {
  await t.press("7");
  const at = rowIndex(c, s, key);
  for (let i = 0; i < at; i++) await t.press("down");
}

test("Enter on a boolean toggles it, with no editor and no grammar", async () => {
  const c = defaults();
  const s = emptySnapshot();
  let saved: Config | undefined;
  const t = await mount(s, c, undefined, {
    onSave: async (next) => {
      saved = next;
    },
  });
  try {
    await onSetting(t, c, s, "persistence");
    await t.press("enter");
    expect(saved?.persistence).toBe(!c.persistence);
    // The reader never sees a box asking them to type `true`.
    expect(t.frame()).not.toContain("Enter saves");
  } finally {
    await t.close();
  }
});

test("Enter on an enum offers its words and saves the one chosen", async () => {
  const c = defaults();
  const s = emptySnapshot();
  let saved: Config | undefined;
  const t = await mount(s, c, undefined, {
    onSave: async (next) => {
      saved = next;
    },
  });
  try {
    await onSetting(t, c, s, "units");
    // The selected row explains itself until the list takes its place.
    expect(t.frame()).toContain("Binary units count 1024 to the step");
    await t.press("enter");
    const list = t.frame();
    expect(list).not.toContain("Binary units count 1024 to the step");
    // The list offers exactly what the validator accepts, from one table.
    for (const word of choices.units ?? []) expect(list).toContain(word);
    await t.press("down");
    await t.press("enter");
    expect(saved?.units).toBe("decimal");
    expect(saved?.units).not.toBe(c.units);
  } finally {
    await t.close();
  }
});

test("a list edits as text but reads one item per line", async () => {
  const c = defaults();
  const s = emptySnapshot();
  let saved: Config | undefined;
  const t = await mount(s, c, undefined, {
    onSave: async (next) => {
      saved = next;
    },
  });
  try {
    await onSetting(t, c, s, "agentTools");
    await t.press("enter");
    const open = t.frame();
    expect(open).toContain("Enter saves");
    // Numbered lines, so a reader can count a list they cannot read in one row.
    c.agentTools.forEach((tool, at) => {
      expect(open).toContain(`${at + 1}. ${tool}`);
    });
    await act(async () => {
      t.ui.mockInput.pressKey("END");
      for (let i = 0; i < c.agentTools.length * 24; i++)
        t.ui.mockInput.pressBackspace();
    });
    await act(async () => {
      await t.ui.mockInput.typeText('["claude", "pi"]');
    });
    await t.ui.renderOnce();
    // The items track the text as it is typed, not the value that was stored.
    expect(t.frame()).toContain("2. pi");
    await t.press("enter");
    expect(saved?.agentTools).toEqual(["claude", "pi"]);
  } finally {
    await t.close();
  }
});

test("a value the validator refuses is reported and never saved", async () => {
  const c = defaults();
  const s = emptySnapshot();
  let saves = 0;
  const t = await mount(s, c, undefined, {
    onSave: async () => {
      saves++;
    },
  });
  try {
    await onSetting(t, c, s, "refreshMs");
    await t.press("enter");
    await act(async () => {
      t.ui.mockInput.pressKey("END");
      for (let i = 0; i < 8; i++) t.ui.mockInput.pressBackspace();
    });
    await act(async () => {
      await t.ui.mockInput.typeText("0");
    });
    await t.press("enter");
    expect(saves).toBe(0);
    expect(t.frame()).toContain("Refresh interval must be between 100");
  } finally {
    await t.close();
  }
});

test("a missing capability wraps its reason and its source under the row", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.capabilities = s.capabilities.map((cap) =>
    cap.id === "psi"
      ? {
          ...cap,
          available: false,
          failure: "absent" as const,
          source: "/proc/pressure/cpu",
          detail: "ENOENT: no such file or directory",
        }
      : cap,
  );
  // Eighty columns is the width the issue names; the diagnostic is seventy-six
  // characters, so it cannot reach the reader on one indented row.
  const t = await mount(s, c, { width: 80, height: 30 });
  try {
    await t.press("7");
    const at = settingItems(c, s.capabilities).findIndex(
      (item) => item.kind === "capability" && item.id === "psi",
    );
    expect(at).toBeGreaterThan(-1);
    // Unselected, the row carries the reason and nothing that would be cut.
    expect(t.frame()).not.toContain("/proc/pressure/cpu");
    for (let i = 0; i < at; i++) await t.press("down");
    expect(selectedRow(t.frame())).toContain("Pressure stall information");
    const lines = t.frame().split("\n");
    const source = lines.findIndex((line) =>
      line.includes("/proc/pressure/cpu"),
    );
    expect(source).toBeGreaterThan(-1);
    // It runs onto a second line rather than being cut at the terminal edge,
    // and the whole diagnostic is there to be read across the two.
    expect(lines[source + 1]?.trim()).not.toBe("");
    const joined = `${lines[source]} ${lines[source + 1]}`
      // The scrollbar draws in the last column of every line.
      .replace(/[^\x20-\x7e]/g, " ")
      .replace(/\s+/g, " ");
    expect(joined).toContain("ENOENT: no such file or directory");
  } finally {
    await t.close();
  }
});

test("Settings filters by name and by the label the reader sees", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const t = await mount(s, c, { width: 180, height: 40 });
  try {
    await t.press("7");
    expect(t.frame()).toContain("Storage units");
    // "wait" appears in no setting's stored name; it is what the labels say.
    await t.press("/");
    for (const ch of "wait") await t.press(ch);
    const byLabel = t.frame();
    expect(byLabel).toContain("Wait warning");
    expect(byLabel).toContain("Wait before alert");
    expect(byLabel).not.toContain("Storage units");
    // The stored name finds it too, not only the label.
    await t.press("escape");
    await t.press("/");
    for (const ch of "swapfloor") await t.press(ch);
    const byKey = t.frame();
    expect(byKey).toContain("Desktop swap warning");
    expect(byKey).not.toContain("Wait warning");
  } finally {
    await t.close();
  }
});

test("a filtered Settings list opens the row the highlight is on", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press("7");
    await t.press("/");
    for (const ch of "wait") await t.press(ch);
    // Enter closes the find box and keeps the query, so the list is filtered
    // and the first match carries the highlight.
    await t.press("enter");
    await t.press("enter");
    // The editor is titled with the setting it edits, so its presence names
    // the row Enter actually opened.
    const frame = t.frame();
    expect(frame).toContain("Wait warning");
    expect(frame).toContain("Enter saves");
    expect(frame).not.toContain("Storage units");
  } finally {
    await t.close();
  }
});

test("walking down Settings keeps the selected row on the screen", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const t = await mount(s, c, { width: 140, height: 35 });
  try {
    await t.press("7");
    // Far enough that the list has to scroll. The row the reader is standing
    // on comes with it: the arrow moves the selection, never the viewport as
    // well.
    for (let i = 0; i < 30; i++) {
      expect(selectedRow(t.frame())).not.toBe("");
      await t.press("down");
    }
    expect(selectedRow(t.frame())).not.toBe("");
  } finally {
    await t.close();
  }
});

test("a query that matches nothing leaves Enter with nothing to open", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press("7");
    await t.press("/");
    for (const ch of "zzzz") await t.press(ch);
    await t.press("enter");
    // No row is selected, so Enter opens nothing rather than reading past the
    // end of the list. The read past the end throws inside the key emitter,
    // which swallows it, so what this pins is the list the render walks: the
    // sources row is not a setting, the filter drops it from `items`, and a
    // render driven by `items` therefore does not draw it either. While it
    // was drawn from a counter beside the list, it stayed on screen holding
    // the highlight that belonged to a row further down.
    await t.press("enter");
    const frame = t.frame();
    expect(frame).toContain("Data sources");
    expect(frame).not.toContain("Every source was read");
    expect(frame).not.toContain("Enter saves");
    expect(frame).not.toContain("Storage units");
  } finally {
    await t.close();
  }
});

test("the editor opens in view when the layout moves the row it edits", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const t = await mount(s, c, { width: 180, height: 30 });
  try {
    await t.press("7");
    // Walk to the last setting. Two columns hold it on the right-hand side.
    for (let i = 0; i < 80; i++) await t.press("j");
    const marker = (frame: string) => {
      const line = frame.split("\n").find((row) => row.includes("▍"));
      return line === undefined ? -1 : line.indexOf("▍");
    };
    expect(marker(t.frame())).toBeGreaterThan(90);
    // Opening the editor collapses the two columns into one, so this row
    // moves below the whole left column. The scroll has to follow the layout
    // that moved it, not the selection, which did not change.
    await t.press("enter");
    // The scroll measures where the row currently sits, so it waits for the
    // new layout to be drawn: the editor is in view on the frame after the
    // collapse. Republishing the sample draws that frame and types nothing.
    await t.update(s);
    const frame = t.frame();
    // This row's editor, named by the row it edits. Measuring on the old
    // layout scrolled to the top of the list, where the opened row is not.
    expect(frame).toContain("Export markdown · Enter saves");
    expect(frame).not.toContain("Storage units");
  } finally {
    await t.close();
  }
});

test("a list the reader has not finished says why it was not saved", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const saved: Config[] = [];
  const t = await mount(
    s,
    c,
    { width: 140, height: 40 },
    {
      onSave: async (next) => {
        saved.push(next);
      },
    },
  );
  try {
    await t.press("7");
    await t.press("/");
    for (const ch of "agent programs") await t.press(ch);
    await t.press("enter");
    // The row this opens holds a list, which is the kind whose grammar the
    // text box deliberately lets a reader half-type.
    await t.press("enter");
    expect(t.frame()).toContain("Enter saves");
    // A bracket appended to the list already in the box: the reader has typed
    // something the grammar does not accept, which is the case this editor
    // exists to keep them from having to think about.
    const quiet = t.frame();
    await t.press("]");
    await t.press("enter");
    const frame = t.frame();
    // Two things this program owes the reader, and neither is a wording. The
    // value did not reach the file.
    expect(saved).toEqual([]);
    expect(frame).not.toContain("Agent programs saved");
    // And they were told something rather than nothing, which is the whole of
    // the finding: evaluated outside the guard the throw escaped `save`, and
    // Enter did nothing and said nothing.
    expect(frame).not.toBe(quiet);
    // What the notice says is the parser's business. It is Bun's sentence, not
    // ours, and pinning it here failed on a runner with a different Bun while
    // the behaviour was correct.
  } finally {
    await t.close();
  }
});

test("a picker keeps its choice on the screen on a short terminal", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // Short enough that the options cannot all be drawn at once.
  const t = await mount(s, c, { width: 140, height: 16 });
  try {
    await t.press("7");
    await t.press("/");
    for (const ch of "sort column") await t.press(ch);
    await t.press("enter");
    await t.press("enter");
    const options = [...choices.sort];
    // What the fixture must hold: more options than the terminal has rows, so
    // a picker drawing them all runs off the bottom.
    expect(options.length).toBeGreaterThan(16);
    // The list row under the picker stays marked, so the picker's own choice
    // is the last marked line rather than the first.
    const chosen = () =>
      t
        .frame()
        .split("\n")
        .filter((l) => l.includes("▍"))
        .at(-1) ?? "";
    // It opens on the value the setting holds, not on the first option.
    const from = options.indexOf(c.sort);
    expect(from).toBeGreaterThan(-1);
    expect(chosen()).toContain(options[from]);
    // Walk to the last option. Every step keeps the choice on the screen;
    // drawn in full it left the viewport and the rest were chosen blind.
    for (let i = from + 1; i < options.length; i++) {
      await t.press("j");
      expect({ i, on: chosen().includes(options[i]) }).toEqual({ i, on: true });
    }
  } finally {
    await t.close();
  }
});

test("search does not open behind a picker", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press("7");
    await t.press("/");
    for (const ch of "sort column") await t.press(ch);
    await t.press("enter");
    await t.press("enter");
    const options = [...choices.sort];
    const chosen = () =>
      t
        .frame()
        .split("\n")
        .filter((l) => l.includes("▍"))
        .at(-1) ?? "";
    const from = options.indexOf(c.sort);
    expect(chosen()).toContain(options[from]);
    // The find key inside a picker. It used to open search, reset the
    // selection and leave the picker running unseen, swallowing every key.
    await t.press("/");
    expect(t.frame()).not.toContain("Find a setting");
    // The picker is still what receives keys, which is what the reader needs:
    // the next arrow moves the choice rather than a list they cannot see.
    await t.press("j");
    expect(chosen()).toContain(options[from + 1]);
  } finally {
    await t.close();
  }
});

test("a query that matches no setting leaves no row selected", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press("7");
    await t.press("/");
    for (const ch of "zzzz") await t.press(ch);
    // The capability rows are listed whatever the filter says, so there are
    // rows on the screen; none of them is what the reader asked for.
    expect(t.frame()).toContain("Data sources");
    // Nothing is highlighted, and Enter opens nothing.
    expect(selectedRow(t.frame())).toBe("");
    await t.press("enter");
    expect(t.frame()).not.toContain("Enter saves");
    expect(selectedRow(t.frame())).toBe("");
  } finally {
    await t.close();
  }
});

test("reopening the find box keeps the query on the row it matched", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const t = await mount(s, c, { width: 140, height: 40 });
  try {
    await t.press("7");
    await t.press("/");
    for (const ch of "wait warning") await t.press(ch);
    await t.press("enter");
    // The query stands and the row it matched is selected.
    expect(selectedRow(t.frame())).toContain("Wait warning");
    // Open the box again without changing anything, and submit. The query is
    // still there, so the row it matched is still the row Enter opens: reset
    // to the top it landed on a capability row, which is listed whatever the
    // filter says and is never what the query matched.
    await t.press("/");
    expect(t.frame()).toContain("Find a setting");
    await t.press("enter");
    expect(selectedRow(t.frame())).toContain("Wait warning");
    await t.press("enter");
    // The editor is titled with the setting it edits, so its title names the
    // row Enter actually opened. The capability rows are on the screen either
    // way, so their presence says nothing.
    expect(t.frame()).toContain("Wait warning · Enter saves");
  } finally {
    await t.close();
  }
});

test("a row's detail is indented under it, its wrapped lines included", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.capabilities = s.capabilities.map((cap) =>
    cap.id === "psi"
      ? {
          ...cap,
          available: false,
          failure: "absent" as const,
          source: "/proc/pressure/cpu",
          detail: "ENOENT: no such file or directory",
        }
      : cap,
  );
  const t = await mount(s, c, { width: 80, height: 30 });
  try {
    await t.press("7");
    const at = settingItems(c, s.capabilities).findIndex(
      (item) => item.kind === "capability" && item.id === "psi",
    );
    for (let i = 0; i < at; i++) await t.press("down");
    const lines = t.frame().split("\n");
    const row = lines.findIndex((line) => line.includes("▍○ ▾ Pressure"));
    expect(row).toBeGreaterThan(-1);
    // The screen's own margin is two columns and the detail adds three, so a
    // detail line starts at column five. The second line is the one that
    // matters: padding on a text element leaves every wrapped line at the
    // margin, which reads as the next row rather than as part of this one.
    // The row itself carries no rule; both of its continuation lines do, and
    // the wrapped one is the line an indent alone never reached.
    expect(isChildLine(lines[row])).toBe(false);
    expect(isChildLine(lines[row + 1])).toBe(true);
    expect(isChildLine(lines[row + 2])).toBe(true);
    expect(lines[row + 1]).toContain("/proc/pressure/cpu");
    expect(lines[row + 2].trimEnd().endsWith("directory)")).toBe(true);
  } finally {
    await t.close();
  }
});

test("a source that could not be read shows why, at the end of a short list", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // The last capability is the one that could not be read, so walking to it
  // puts it at the bottom edge of a viewport too short for the list.
  const last = s.capabilities[s.capabilities.length - 1];
  s.capabilities = s.capabilities.map((cap) =>
    cap.id === last.id
      ? {
          ...cap,
          available: false,
          failure: "absent" as const,
          source: "/proc/pressure/cpu",
          detail: "ENOENT: no such file or directory",
        }
      : cap,
  );
  const t = await mount(s, c, { width: 140, height: 10 });
  try {
    await t.press("7");
    const at = settingItems(c, s.capabilities).findIndex(
      (item) => item.kind === "capability" && item.id === last.id,
    );
    expect(at).toBeGreaterThan(0);
    for (let i = 0; i < at; i++) await t.press("down");
    const frame = t.frame();
    // The row is the one selected, and the sentence saying why it could not be
    // read is on the screen with it. Scrolled to the row alone, the row landed
    // flush against the bottom edge and this line was the one below the fold —
    // which is the whole of what the reader selected it for.
    expect(selectedRow(frame)).toContain("Drive lifetime reports");
    expect(frame).toContain("(/proc/pressure/cpu: ENOENT");
  } finally {
    await t.close();
  }
});

test("Enter on a readable source brings its own source line with it", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // The last capability, so opening it at the bottom edge of a short viewport
  // is where the line it opens would fall past the fold.
  const last = s.capabilities[s.capabilities.length - 1];
  const t = await mount(s, c, { width: 140, height: 10 });
  try {
    await t.press("7");
    const at = settingItems(c, s.capabilities).findIndex(
      (item) => item.kind === "capability" && item.id === last.id,
    );
    expect(at).toBeGreaterThan(0);
    for (let i = 0; i < at; i++) await t.press("down");
    // Nothing is open yet, so the source is not on the screen to begin with.
    expect(t.frame()).not.toContain(last.source);
    await t.press("enter");
    const frame = t.frame();
    expect(selectedRow(frame)).toContain("Drive lifetime reports");
    // Enter is what opened this, so Enter has to be what moves the view: with
    // `openCap` outside the effect's dependencies the block grew a line and
    // nothing re-ran, leaving that line below the fold.
    expect(frame).toContain(last.source);
  } finally {
    await t.close();
  }
});

test("a selected setting keeps its help sentence on the screen", async () => {
  const c = defaults();
  const s = emptySnapshot();
  const items = settingItems(c, s.capabilities);
  // The row whose help falls past the bottom edge on this viewport. Asserted
  // here rather than assumed: a row with no help, or one the viewport has room
  // for either way, would pass whatever the screen did with it.
  const at = items.findIndex(
    (item) => item.kind === "setting" && item.key === "units",
  );
  expect(at).toBeGreaterThan(0);
  const help = settingHelp("units");
  expect(help).not.toBe("");
  const t = await mount(s, c, { width: 140, height: 9 });
  try {
    await t.press("7");
    for (let i = 0; i < at; i++) await t.press("down");
    const frame = t.frame();
    expect(selectedRow(frame)).toContain("Storage units");
    // Scrolled to the row alone, the row landed against the bottom edge and
    // the sentence explaining it was the line below the fold.
    expect(frame).toContain(help);
  } finally {
    await t.close();
  }
});

test("the sources list opens with its last entry readable", async () => {
  const c = defaults();
  const s = emptySnapshot();
  // Four unreadable sources: enough that the opened list does not fit under
  // the row where it sits, and few enough that the whole of it fits the
  // viewport once the row is moved up for it. Both halves matter — a list
  // taller than the viewport cannot be shown by any scroll position, and a
  // list that fits either way could not tell one scroll from another.
  s.errors = Array.from({ length: 4 }, (_, i) => ({
    source: `/proc/source-${i}`,
    message: `read failed ${i}`,
  }));
  const at = settingItems(c, s.capabilities).findIndex(
    (item) => item.kind === "sources",
  );
  // Every capability is listed ahead of it, so this index is not a constant.
  expect(at).toBeGreaterThan(0);
  const t = await mount(s, c, { width: 140, height: 12 });
  try {
    await t.press("7");
    for (let i = 0; i < at; i++) await t.press("down");
    // Closed, the list is not on the screen at all.
    expect(t.frame()).not.toContain("/proc/source-3");
    await t.press("enter");
    const frame = t.frame();
    // The phrase both spellings of this row share: the design pass rewrites
    // its label, and which row is selected is the claim, not its wording.
    expect(selectedRow(frame)).toContain("vsys cannot read");
    // The row moved up far enough for the whole list, last entry included.
    // Brought into view as a row instead, the row sits at the bottom edge and
    // every entry it opened is below it.
    expect(frame).toContain("/proc/source-3");
  } finally {
    await t.close();
  }
});
