import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { processSnapshot } from "../test/fixture";
import {
  accountName,
  jobserver,
  laneName,
  paneName,
  unitLabel,
} from "./naming";

test("the account comes from whichever agent configuration directory is set", () => {
  const c = defaults();
  const claude = processSnapshot({
    env: { CLAUDE_CONFIG_DIR: "/home/x/.2claude" },
  });
  const codex = processSnapshot({ env: { CODEX_HOME: "/home/x/.codex-work" } });
  expect(accountName(claude, c)).toBe(".2claude");
  expect(accountName(codex, c)).toBe(".codex-work");
  expect(accountName(processSnapshot({ env: {} }), c)).toBeNull();
  expect(
    accountName(processSnapshot({ env: {}, envAvailable: false }), c),
  ).toBeNull();
});

test("config chooses which parts name a lane and in which order", () => {
  const parts = {
    account: "work",
    tool: "claude",
    pane: "main:2.1",
    title: "",
    workspace: "kendex",
  };
  expect(laneName(parts, [...defaults().laneNameParts])).toBe(
    "work claude main:2.1 kendex",
  );
  expect(laneName(parts, ["workspace", "account"])).toBe("kendex work");
  expect(laneName(parts, ["title"])).toBe("");
});

test("the pane address is read from the first exported variable", () => {
  const c = defaults();
  expect(paneName(processSnapshot({ env: { TMUX_PANE: "%12" } }), c)).toBe(
    "%12",
  );
  expect(
    paneName(
      processSnapshot({ env: { VSYS_PANE: "work:2.1", TMUX_PANE: "%12" } }),
      c,
    ),
  ).toBe("work:2.1");
  expect(paneName(processSnapshot({ env: {} }), c)).toBe("");
});

test("the make jobserver is read from the configured variable", () => {
  const c = defaults();
  expect(
    jobserver(
      processSnapshot({
        env: { MAKEFLAGS: " -j8 --jobserver-auth=fifo:/tmp/GMfifo1" },
      }),
      c.jobserverEnv,
    ),
  ).toEqual({ jobs: 8, jobserver: "fifo:/tmp/GMfifo1" });
  expect(jobserver(processSnapshot({ env: {} }), c.jobserverEnv)).toEqual({
    jobs: null,
    jobserver: null,
  });
  // The variable is configuration, so another build system can be watched.
  expect(
    jobserver(processSnapshot({ env: { NINJAFLAGS: " -j2" } }), ["NINJAFLAGS"]),
  ).toEqual({ jobs: 2, jobserver: null });
});

test("the pane address is kept as the handle the server gave, never rewritten", () => {
  const c = defaults();
  // `%9` addresses a pane on the tmux server: `switch-client -t %9` reaches
  // it. vsys stores it as it is and names no lane with it, because the number
  // says nothing about which window the pane sits in.
  const lane = paneName(processSnapshot({ env: { TMUX_PANE: "%9" } }), c);
  expect(lane).toBe("%9");
  expect(
    laneName({ account: "work", tool: "claude", workspace: "vsys" }, [
      ...c.laneNameParts,
    ]),
  ).toBe("work claude vsys");
});

test("a unit name loses systemd's machinery and keeps what names it", () => {
  const rows: [string, string][] = [
    // The documented desktop form: the launcher and the unique value go.
    [
      "app-Hyprland-chromium\\x2dpersonal-af7ff2b7.scope",
      "chromium (personal)",
    ],
    ["app-Hyprland-ghostty-3d98e590.scope", "ghostty"],
    ["app-org.chromium.Chromium-391090.scope", "org.chromium.Chromium"],
    ["app-graphical.slice", "graphical"],
    // No convention to follow: the outer field is context, the inner names it.
    ["agent-confine-854045-20986.scope", "agent 854045"],
    // Nothing generated, so nothing is dropped.
    ["tmux.service", "tmux"],
    ["wayland-wm@hyprland.desktop.service", "wayland wm@hyprland.desktop"],
    ["session.slice", "session"],
    ["user@1000.service", "user@1000"],
    // More than one escaped hyphen is a name of its own, not a program and an
    // instance, so it is left whole.
    [
      "app-limine\\x2dsnapper\\x2dnotify@autostart-1234abcd.scope",
      "limine-snapper-notify@autostart",
    ],
  ];
  for (const [unit, expected] of rows)
    expect({ unit, label: unitLabel(unit) }).toEqual({ unit, label: expected });
  // Nothing a screen renders still carries an escape, a type suffix or the
  // launcher prefix.
  for (const [unit] of rows) {
    const label = unitLabel(unit);
    expect(label).not.toContain("\\x");
    expect(label.endsWith(".scope")).toBe(false);
    expect(label.startsWith("app-")).toBe(false);
  }
});
