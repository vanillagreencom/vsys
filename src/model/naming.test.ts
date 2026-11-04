import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { processSnapshot } from "../test/fixture";
import {
  accountName,
  jobserver,
  laneName,
  paneName,
  programName,
  unitLabel,
} from "./naming";

test("program names follow argv rather than a renamed main thread", () => {
  const rows: [string[], string, string][] = [
    [["/opt/copilot/bin/copilot"], "MainThread", "copilot"],
    [["/usr/bin/node"], "node-MainThread", "node"],
    [["/usr/bin/bun run /repo/app.ts"], "MainThread", "bun"],
    [
      ["npm exec @modelcontextprotocol/server-filesystem /home/u/proj"],
      "npm exec @mod",
      "npm",
    ],
    [["npm exec @playwright/mcp@latest"], "npm exec @play", "npm"],
    [
      [
        "/opt/google/chrome/chrome --type=renderer --user-data-dir=/tmp/playwright_chromiumdev_profile-x",
      ],
      "chrome",
      "chrome",
    ],
    [["worker: pool"], "MainThread", "worker"],
    [["-bash"], "bash", "bash"],
    [["/bin/-zsh: login"], "zsh", "zsh"],
    [[], "kworker/0:1", "kworker/0:1"],
    [[""], "zombie", "zombie"],
    [["/opt/copilot-bin/MainThread"], "MainThread", "MainThread"],
  ];
  for (const [command, comm, expected] of rows)
    expect(
      programName(processSnapshot({ command, comm })),
      command.join(" "),
    ).toBe(expected);
});

test("account selection prefers its tool, excludes other tools and preserves configured fallback order", () => {
  const c = defaults();
  const mixed = {
    CLAUDE_CONFIG_DIR: "/home/u/.2claude",
    CODEX_HOME: "/home/u/.codex-work",
    COPILOT_HOME: "/home/u/.1copilot",
  };
  const rows: [
    string,
    string[],
    Record<string, string>,
    boolean,
    string | null,
  ][] = [
    [
      "copilot",
      c.accountEnv,
      { COPILOT_HOME: mixed.COPILOT_HOME },
      true,
      ".1copilot",
    ],
    ["copilot", c.accountEnv, mixed, true, ".1copilot"],
    ["claude", c.accountEnv, mixed, true, ".2claude"],
    ["codex", c.accountEnv, mixed, true, ".codex-work"],
    [
      "copilot",
      c.accountEnv,
      { CLAUDE_CONFIG_DIR: mixed.CLAUDE_CONFIG_DIR },
      true,
      null,
    ],
    [
      "copilot",
      ["ACCOUNT_DIR", "COPILOT_HOME"],
      { ...mixed, ACCOUNT_DIR: "/x/fallback" },
      true,
      ".1copilot",
    ],
    [
      "copilot",
      ["CLAUDE_CONFIG_DIR", "ACCOUNT_DIR", "OTHER_DIR"],
      { ...mixed, ACCOUNT_DIR: "/x/first", OTHER_DIR: "/x/second" },
      true,
      "first",
    ],
    [
      "copilot",
      ["COPILOT_ALT", "COPILOT_HOME"],
      { ...mixed, COPILOT_ALT: "/x/first" },
      true,
      "first",
    ],
    ["copilot", c.accountEnv, mixed, false, null],
    ["copilot", c.accountEnv, {}, true, null],
    ["copilot", c.accountEnv, { COPILOT_HOME: "" }, true, null],
    ["", c.accountEnv, mixed, true, null],
  ];
  for (const [tool, accountEnv, env, envAvailable, expected] of rows)
    expect({
      tool,
      account: accountName(
        processSnapshot({ env, envAvailable }),
        { ...c, accountEnv },
        tool,
      ),
    }).toEqual({ tool, account: expected });
  expect(accountName(undefined, c, "copilot")).toBeNull();
  expect(
    accountName(
      processSnapshot({ env: { LOCAL_HOME: "/x/local" } }),
      {
        ...c,
        agentTools: [...c.agentTools, "local"],
        accountEnv: ["LOCAL_HOME"],
      },
      "copilot",
    ),
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
  ).toEqual({ jobs: 8, jobserver: "fifo:/tmp/GMfifo1", jobsKnown: true });
  expect(jobserver(processSnapshot({ env: {} }), c.jobserverEnv)).toEqual({
    jobs: null,
    jobserver: null,
    jobsKnown: true,
  });
  // The variable is configuration, so another build system can be watched.
  expect(
    jobserver(processSnapshot({ env: { NINJAFLAGS: " -j2" } }), ["NINJAFLAGS"]),
  ).toEqual({ jobs: 2, jobserver: null, jobsKnown: true });
});

test("an unread environment or lead process leaves make jobs unknown, not unset", () => {
  const envNames = defaults().jobserverEnv;
  expect(
    jobserver(processSnapshot({ env: {}, envAvailable: false }), envNames),
  ).toEqual({ jobs: null, jobserver: null, jobsKnown: false });
  expect(jobserver(undefined, envNames)).toEqual({
    jobs: null,
    jobserver: null,
    jobsKnown: false,
  });
  expect(
    jobserver(processSnapshot({ env: {}, envAvailable: true }), envNames)
      .jobsKnown,
  ).toBe(true);
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

// systemd escapes each byte of a UTF-8 character on its own, so
// `systemd-escape 'café'` prints `caf\xc3\xa9`.
test("a UTF-8 character systemd escaped byte by byte decodes to that character", () => {
  expect(unitLabel("app-niri-caf\\xc3\\xa9-1234.scope")).toBe("café");
  expect(unitLabel("run-r\\xc3\\xa9sum\\xc3\\xa9.service")).toBe("run résumé");
});
