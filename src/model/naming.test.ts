import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { processSnapshot } from "../test/fixture";
import { accountName, jobserver, laneName, paneName } from "./naming";

test("the account comes from whichever agent configuration directory is set", () => {
  const c = defaults();
  const claude = processSnapshot({
    env: { CLAUDE_CONFIG_DIR: "/home/x/.2claude" },
  });
  const codex = processSnapshot({ env: { CODEX_HOME: "/home/x/.codex-work" } });
  expect(accountName(claude, c)).toBe(".2claude");
  expect(accountName(codex, c)).toBe(".codex-work");
  expect(accountName(processSnapshot({ env: {} }), c)).toBe("default");
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

test("the make jobserver is read from MAKEFLAGS, and absence is not zero", () => {
  expect(
    jobserver(
      processSnapshot({
        env: { MAKEFLAGS: " -j8 --jobserver-auth=fifo:/tmp/GMfifo1" },
      }),
    ),
  ).toEqual({ jobs: 8, jobserver: "fifo:/tmp/GMfifo1" });
  expect(jobserver(processSnapshot({ env: {} }))).toEqual({
    jobs: null,
    jobserver: null,
  });
});
