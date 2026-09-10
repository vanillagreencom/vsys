import { expect, test } from "bun:test";
import {
  type Ask,
  capturePane,
  capturePaneArgv,
  insideTmux,
  isPaneId,
  paneFormat,
  paneLines,
  parsePanes,
  switchClientArgv,
  switchCommand,
} from "./tmux";

test("a pane resolves to its session, window and pane, and a partial line is dropped", () => {
  const panes = parsePanes(
    [
      "%9\tvsys:1.1\tken-1298",
      "%13\tvsys:2.1\tken-1295",
      "%17\tvsys:3.1\teditor",
      "%21\tvsys:3.2\teditor",
      // A session named with a space still splits, because the fields are
      // separated by tabs rather than by the character a name may contain.
      "%25\tmy work:1.1\tbuild logs",
      // Dropped: no window field at all, and no address to send a reader to.
      "%29",
      "",
      // Dropped: not a pane id, so nothing can act on it.
      "9\tvsys:4.1\tstray",
    ].join("\n"),
  );
  expect(panes.get("%9")).toEqual({ address: "vsys:1.1", window: "ken-1298" });
  // Two agents in one worktree are told apart by the window, not the pane.
  expect(panes.get("%13")?.address).toBe("vsys:2.1");
  // Two panes in one window differ in the last field alone.
  expect(panes.get("%17")?.address).toBe("vsys:3.1");
  expect(panes.get("%21")?.address).toBe("vsys:3.2");
  expect(panes.get("%25")).toEqual({
    address: "my work:1.1",
    window: "build logs",
  });
  expect(panes.has("%29")).toBe(false);
  expect(panes.has("9")).toBe(false);
  expect(panes.size).toBe(5);
  // The format asks for those three fields and separates them the same way.
  expect(paneFormat.split("\t")).toHaveLength(3);
});

test("captured pane text cannot move the cursor, repaint or write the clipboard", () => {
  // Written as escapes rather than as bytes, so this file stays readable
  // in any editor and no tool can strip the very characters under test.
  const esc = "\u001b";
  const hostile = [
    `${esc}[2J${esc}[Hcleared your screen`,
    `${esc}]52;c;aGVsbG8=\u0007wrote your clipboard`,
    `${esc}[31mred${esc}[0m text`,
    "bell \u0007 and a tab\tstays",
    "",
    "",
  ].join("\n");
  const lines = paneLines(hostile);
  const joined = lines.join("\n");
  // No escape, no bell, no other control byte survives: what a program drew
  // is read as text, never obeyed as instructions.
  const control = (line: string) =>
    [...line].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });
  for (const line of lines)
    expect({ line, control: control(line) }).toEqual({ line, control: false });
  expect(joined).not.toContain("52;c;");
  expect(joined).not.toContain("[2J");
  // The words the reader wanted are still there.
  expect(lines[0]).toBe("cleared your screen");
  expect(lines[1]).toBe("wrote your clipboard");
  expect(lines[2]).toBe("red text");
  // Blank lines at the end are trimmed, so the box is not mostly empty.
  expect(lines).toHaveLength(4);
});

test("only the last lines are kept, so a long scrollback cannot fill the screen", () => {
  const lines = paneLines(
    Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"),
    10,
  );
  expect(lines).toHaveLength(10);
  expect(lines.at(-1)).toBe("line 499");
  expect(lines[0]).toBe("line 490");
});

test("a pane id is tmux's own grammar, and the copied line names that pane", () => {
  for (const id of ["%0", "%9", "%1234"]) expect(isPaneId(id)).toBe(true);
  for (const id of ["", "9", "%", "%9x", "%9; rm -rf /", "$1", "@2"])
    expect(isPaneId(id)).toBe(false);
  expect(switchCommand("%9")).toBe("tmux switch-client -t %9");
});

test("vsys can move the reader's view only from inside a tmux client", () => {
  expect(insideTmux({ TMUX: "/tmp/tmux-1000/default,12345,0" })).toBe(true);
  expect(insideTmux({})).toBe(false);
  expect(insideTmux({ TMUX: "" })).toBe(false);
  // A pane id in the environment is not a client: an agent's own pane says
  // nothing about which server vsys itself is attached to.
  expect(insideTmux({ TMUX_PANE: "%9" })).toBe(false);
});

test("a configured address is a target tmux accepts, not one vsys refuses", async () => {
  // `-t` takes a target, and `session:window.pane` is one. Refusing it was
  // vsys's own restriction, and it refused the value the documentation tells
  // a reader to put in `VSYS_PANE`.
  expect(capturePaneArgv("work:2.1")).toEqual([
    "tmux",
    "capture-pane",
    "-p",
    "-t",
    "work:2.1",
  ]);
  // A stand-in server, so this asserts what vsys does rather than what the
  // machine running the suite happens to have. Asked for the real thing, this
  // passed on a machine with no tmux: the spawn threw `Executable not found
  // in $PATH`, which is neither empty nor the old sentence, so a test named
  // for tmux accepting an address passed where tmux did not exist.
  const asked: string[][] = [];
  const server = (said: string): Ask => {
    return (argv) => {
      asked.push(argv);
      return Promise.reject(new Error(said));
    };
  };
  // The configured address reaches the server as the target it is, unchanged.
  await expect(
    capturePane("work:2.1", server("can't find pane: work:2.1")),
  ).rejects.toThrow("can't find pane: work:2.1");
  expect(asked).toEqual([["tmux", "capture-pane", "-p", "-t", "work:2.1"]]);
  // What reaches the reader when the server refuses is the server's own
  // words. What used to reach them was `work:2.1 is not a pane address`,
  // about a value they were told to set.
  const lines = await capturePane("work:2.1", async (argv) => {
    asked.push(argv);
    return "one\ntwo\n";
  });
  expect(lines).toEqual(["one", "two"]);
  // A pane with nothing to name is still refused, because there is nothing to
  // ask about, and nothing is asked.
  const before = asked.length;
  await expect(capturePane("")).rejects.toThrow("exported no pane");
  expect(asked.length).toBe(before);
});

test("the copied line quotes its target, and the arguments do not", () => {
  // A session named with a space pastes as two words: the command then runs
  // against something else, or fails.
  expect(switchCommand("my work:1.1")).toBe(
    "tmux switch-client -t 'my work:1.1'",
  );
  // The argv path hands tmux separate arguments, so a quote there would be
  // part of the target rather than around it.
  expect(switchClientArgv("my work:1.1")).toEqual([
    "tmux",
    "switch-client",
    "-t",
    "my work:1.1",
  ]);
});
