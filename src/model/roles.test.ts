import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { processSnapshot } from "../test/fixture";
import { classify, excludedArgv, paneScope, scopeUnit } from "./roles";

test("configured argv patterns exclude tool processes that are not lanes", () => {
  const c = defaults();
  expect(
    excludedArgv(["/usr/bin/claude", "--chrome-native-host"], c.excludeArgv),
  ).toBe(true);
  expect(excludedArgv(["/usr/bin/claude"], c.excludeArgv)).toBe(false);
  // An empty pattern must not match everything.
  expect(excludedArgv(["/usr/bin/claude"], [""])).toBe(false);
});

test("the pane shell and the agent it started get different roles", () => {
  const c = defaults();
  const pane = processSnapshot({
    pid: 10,
    comm: "bash",
    command: ["/bin/bash"],
    group: "/user.slice/app.slice/tmux-spawn-4.scope",
    tool: null,
  });
  const agent = processSnapshot({
    pid: 11,
    ppid: 10,
    group: "/user.slice/app.slice/tmux-spawn-4.scope",
    tool: "claude",
  });
  expect(classify(pane, true, c)).toBe("pane");
  // The agent is a child inside the same scope and stays an agent.
  expect(classify(agent, false, c)).toBe("agent");
  expect(classify(agent, true, c)).toBe("agent");
  // A shell that is not the scope main is not the pane.
  expect(classify(pane, false, c)).toBe("other");
});

test("an excluded tool process is a helper, not an agent", () => {
  const c = defaults();
  const host = processSnapshot({
    command: ["/usr/bin/claude", "--chrome-native-host"],
    group: "/user.slice/app.slice/chrome.scope",
  });
  expect(classify(host, false, c)).toBe("helper");
});

test("scope unit and pane prefix come from the cgroup path", () => {
  expect(scopeUnit("/user.slice/app.slice/tmux-spawn-4.scope")).toBe(
    "tmux-spawn-4.scope",
  );
  expect(scopeUnit("/user.slice/agents.slice")).toBe(null);
  expect(paneScope("/app.slice/tmux-spawn-4.scope", ["tmux-spawn-"])).toBe(
    true,
  );
  expect(paneScope("/agents.slice/lane.scope", ["tmux-spawn-"])).toBe(false);
});
