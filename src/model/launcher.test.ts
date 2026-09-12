import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { processSnapshot } from "../test/fixture";
import { launcherCopy, launcherTrail, pathPrefix } from "./launcher";

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

/** One lane's worth of processes, all bare, spread over the named scopes. */
function fleet(scopes: string[], each: number) {
  const init = processSnapshot({
    pid: 1,
    ppid: 0,
    start: 0,
    comm: "systemd",
    command: ["/usr/lib/systemd/systemd"],
    executable: "/usr/lib/systemd/systemd",
    group: "/init.scope",
    tool: null,
  });
  const procs = [init];
  const escaped = [];
  for (const [i, scope] of scopes.entries()) {
    const shell = processSnapshot({
      pid: 100 + i,
      ppid: 1,
      start: 10,
      comm: "systemd",
      command: ["/usr/lib/systemd/systemd"],
      executable: "/usr/lib/systemd/systemd",
      group: `/init.scope`,
      tool: null,
    });
    procs.push(shell);
    for (let n = 0; n < each; n++) {
      const agent = processSnapshot({
        pid: 1000 + i * 100 + n,
        ppid: 100 + i,
        start: 20,
        group: `/user.slice/${scope}`,
        env: { PATH: "/usr/bin:/bin" },
      });
      procs.push(agent);
      escaped.push(agent);
    }
  }
  return { procs, escaped };
}

test("many processes in one scope are one sentence, and two scopes are two", () => {
  const c = defaults();
  const one = fleet(["tmux-spawn-4.scope"], 6);
  const single = launcherCopy(one.escaped, one.procs, c, base);
  expect(single).toHaveLength(1);
  expect(single[0]).toBe(
    "Launched bare: none of RUST_TEST_THREADS, CARGO_BUILD_JOBS is set on " +
      "6 processes in the scope tmux-spawn-4.scope. " +
      "Started from PID 1000: systemd in init.scope.",
  );
  // The marker list, the scope and the chain are each written once, however
  // many processes the group holds.
  expect(single[0].split("RUST_TEST_THREADS")).toHaveLength(2);
  expect(single[0].split("tmux-spawn-4.scope")).toHaveLength(2);
  // A repeated neighbour in the chain is written once, not once per ancestor.
  expect(single[0].split("systemd in init.scope")).toHaveLength(2);
  const two = fleet(["tmux-spawn-4.scope", "tmux-spawn-3.scope"], 5);
  const pair = launcherCopy(two.escaped, two.procs, c, base);
  expect(pair).toHaveLength(2);
  expect(pair[0]).toContain("5 processes in the scope tmux-spawn-4.scope");
  expect(pair[1]).toContain("5 processes in the scope tmux-spawn-3.scope");
  // One process in a scope is still one process, not one processes.
  const alone = fleet(["solo.scope"], 1);
  expect(launcherCopy(alone.escaped, alone.procs, c, base)[0]).toContain(
    "is set on 1 process in the scope solo.scope",
  );
  expect(launcherCopy([], two.procs, c, base)).toEqual([]);
});

test("a conclusion is its own group, and its sentence states that conclusion", () => {
  const c = defaults();
  const { procs, agent } = escapedAgent({
    CARGO_BUILD_JOBS: "16",
    PATH: "/home/user/.shadow/bin:/usr/bin",
  });
  const bare = processSnapshot({
    pid: 12,
    ppid: 10,
    start: 60,
    group: "/user.slice/app.slice/tmux-spawn-4.scope",
    env: { PATH: "/usr/bin" },
  });
  const blind = processSnapshot({
    pid: 13,
    ppid: 10,
    start: 60,
    group: "/user.slice/app.slice/tmux-spawn-4.scope",
    envAvailable: false,
  });
  const all = [...procs, bare, blind];
  const copy = launcherCopy([agent, bare, blind], all, c, base);
  expect(copy).toHaveLength(3);
  expect(copy[0]).toContain("The launcher was shadowed");
  expect(copy[0]).toContain(
    "PATH starts with /home/user/.shadow/bin, which the login shell does not have.",
  );
  expect(copy[1]).toContain("Launched bare");
  expect(copy[2]).toContain(
    "Cannot read the environment of 1 process in the scope tmux-spawn-4.scope",
  );
});
