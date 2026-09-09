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
    role: "pane",
  });
  const agent = processSnapshot({
    pid: 11,
    ppid: 10,
    start: 60,
    group: "/user.slice/app.slice/tmux-spawn-4.scope",
    env,
  });
  return { procs: [shell, agent], agent };
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
  expect(trail.scope).toBe("tmux-spawn-4.scope");
  expect(trail.capsPresent).toEqual(["RUST_TEST_THREADS", "CARGO_BUILD_JOBS"]);
  expect(trail.capsMissing).toEqual([]);
  expect(trail.pathPrefix).toEqual(["/home/user/.shadow/bin"]);
  expect(trail.summary).toContain("shadowed");
  expect(trail.summary).toContain("/home/user/.shadow/bin");
  // The ancestor chain carries each ancestor's cgroup and scope unit.
  expect(trail.ancestors).toHaveLength(1);
  expect(trail.ancestors[0]).toMatchObject({
    pid: 10,
    scope: "tmux-spawn-4.scope",
    executable: "/usr/bin/bash",
  });
});

test("caps absent means the agent was launched bare", () => {
  const c = defaults();
  const { procs, agent } = escapedAgent({ PATH: "/usr/bin:/bin" });
  const trail = launcherTrail(agent, procs, c, base);
  expect(trail.conclusion).toBe("bare");
  expect(trail.capsPresent).toEqual([]);
  expect(trail.pathPrefix).toEqual([]);
  expect(trail.summary).toContain("Launched bare");
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
  expect(pathPrefix("/a:/b", base)).toEqual(["/a", "/b"]);
  expect(pathPrefix("", base)).toEqual([]);
});
