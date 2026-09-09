import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { processSnapshot } from "../test/fixture";
import { launcherTrail, pathPrefix } from "./launcher";

const base = ["/usr/local/bin", "/usr/bin", "/bin"];

function escapedAgent(env: Record<string, string>) {
  const shell = processSnapshot({
    pid: 10,
    ppid: 1,
    start: 50,
    comm: "bash",
    command: ["/bin/bash"],
    executable: "/usr/bin/bash",
    group: "/user.slice/app.slice/tmux-spawn-4.scope",
    tool: null,
  });
  const agent = processSnapshot({
    pid: 11,
    ppid: 10,
    start: 60,
    group: "/user.slice/app.slice/tmux-spawn-4.scope",
    env,
  });
  const tmux = processSnapshot({
    pid: 5,
    ppid: 1,
    start: 20,
    comm: "tmux",
    command: ["/usr/bin/tmux"],
    executable: "/usr/bin/tmux",
    group: "/user.slice/app.slice/tmux-server.scope",
    tool: null,
  });
  shell.ppid = 5;
  return { procs: [tmux, shell, agent], agent };
}

test("caps present with the wrong cgroup means the launcher was shadowed", () => {
  const c = defaults();
  const { procs, agent } = escapedAgent({
    CARGO_BUILD_JOBS: "16",
    RUST_TEST_THREADS: "8",
    PATH: "/home/user/.shadow/bin:/usr/bin:/bin",
  });
  const trail = launcherTrail(agent, procs, c, base);
  expect(trail.conclusion).toBe("shadowed");
  expect(trail.summary).toBe(
    "The launcher was shadowed: RUST_TEST_THREADS and CARGO_BUILD_JOBS are set, " +
      "but the process sits in the scope tmux-spawn-4.scope. PATH starts with " +
      "/home/user/.shadow/bin, which the login shell does not have. " +
      "Started from: bash in tmux-spawn-4.scope, tmux in tmux-server.scope.",
  );
});

test("caps absent means the agent was launched bare", () => {
  const c = defaults();
  const { procs, agent } = escapedAgent({ PATH: "/usr/bin:/bin" });
  const trail = launcherTrail(agent, procs, c, base);
  expect(trail.conclusion).toBe("bare");
  expect(trail.summary).toContain("Launched bare");
  // The marker list is configuration, so a set cap under another name is bare.
  const other = escapedAgent({ CARGO_BUILD_JOBS: "16" });
  const renamed = launcherTrail(
    other.agent,
    other.procs,
    {
      ...c,
      capMarkers: ["MAKEFLAGS"],
    },
    base,
  );
  expect(renamed.conclusion).toBe("bare");
  expect(renamed.summary).toContain("MAKEFLAGS");
});

test("an unreadable environment is not reported as a bare launch", () => {
  const c = defaults();
  const { procs, agent } = escapedAgent({});
  agent.envAvailable = false;
  const trail = launcherTrail(agent, procs, c, base);
  expect(trail.conclusion).toBe("unknown");
  expect(trail.summary).toContain("unknown");
});

test("PATH prefix stops at the first entry the login shell also has", () => {
  expect(pathPrefix("/a:/b:/usr/bin:/c", base)).toEqual(["/a", "/b"]);
  expect(pathPrefix("/usr/bin:/a", base)).toEqual([]);
  expect(pathPrefix("", base)).toEqual([]);
});
