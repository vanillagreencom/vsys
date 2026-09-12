import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { escapedSnapshot, processSnapshot } from "../test/fixture";
import { launcherCopy, launcherTrail, pathPrefix } from "./launcher";

const base = ["/usr/local/bin", "/usr/bin", "/bin"];

function escapedAgent(env: Record<string, string>) {
  const shell = processSnapshot({
    pid: 10,
    ppid: 5,
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
  return { procs: [tmux, shell, agent], agent };
}
/** The one sentence a set of processes writes, both parts joined. */
const sentence = (procs: ReturnType<typeof escapedAgent>) =>
  launcherCopy([procs.agent], procs.procs, defaults(), base)
    .map((s) => `${s.conclusion}${s.started}`)
    .join(" ");

test("caps present with the wrong cgroup means the launcher was shadowed", () => {
  const c = defaults();
  const set = escapedAgent({
    CARGO_BUILD_JOBS: "16",
    RUST_TEST_THREADS: "8",
    PATH: "/home/user/.shadow/bin:/usr/bin:/bin",
  });
  expect(launcherTrail(set.agent, set.procs, c, base).conclusion).toBe(
    "shadowed",
  );
  expect(sentence(set)).toBe(
    "The launcher was shadowed: RUST_TEST_THREADS and CARGO_BUILD_JOBS are set, " +
      "but PID 11 sits in the scope tmux-spawn-4.scope. PATH starts with " +
      "/home/user/.shadow/bin, which the login shell does not have. " +
      "Started from PID 11: bash in tmux-spawn-4.scope, tmux in tmux-server.scope.",
  );
});

test("caps absent is a bare launch, and an unreadable environment neither", () => {
  const c = defaults();
  const bare = escapedAgent({ PATH: "/usr/bin:/bin" });
  expect(launcherTrail(bare.agent, bare.procs, c, base).conclusion).toBe(
    "bare",
  );
  expect(sentence(bare)).toContain(
    "Launched bare: none of RUST_TEST_THREADS, CARGO_BUILD_JOBS is set on " +
      "PID 11 in the scope tmux-spawn-4.scope.",
  );
  // The marker list is configuration, so a set cap under another name is bare.
  const other = escapedAgent({ CARGO_BUILD_JOBS: "16" });
  const renamed = { ...c, capMarkers: ["MAKEFLAGS"] };
  expect(
    launcherCopy([other.agent], other.procs, renamed, base)[0].conclusion,
  ).toContain("none of MAKEFLAGS is set");
  // An environment vsys could not read is neither conclusion.
  const blind = escapedAgent({});
  blind.agent.envAvailable = false;
  expect(launcherTrail(blind.agent, blind.procs, c, base).conclusion).toBe(
    "unknown",
  );
  expect(sentence(blind)).toContain(
    "Cannot read the environment of PID 11 in the scope tmux-spawn-4.scope, " +
      "so the launcher is unknown.",
  );
});

test("PATH prefix stops at the first entry the login shell also has", () => {
  expect(pathPrefix("/a:/b:/usr/bin:/c", base)).toEqual(["/a", "/b"]);
  expect(pathPrefix("/usr/bin:/a", base)).toEqual([]);
  expect(pathPrefix("", base)).toEqual([]);
});

/** An escaped machine, as its whole process list and the escaped subset. */
function fleet(scopes: number, each: number, env?: Record<string, string>) {
  const procs = escapedSnapshot({ lanes: scopes * each, scopes, env }).procs;
  return { procs, escaped: procs.filter((p) => p.tool) };
}

test("many processes in one scope are one sentence, and two scopes are two", () => {
  const c = defaults();
  const one = fleet(1, 6);
  const single = launcherCopy(one.escaped, one.procs, c, base);
  expect(single).toHaveLength(1);
  expect(single[0].conclusion).toBe(
    "Launched bare: none of RUST_TEST_THREADS, CARGO_BUILD_JOBS is set on " +
      "6 processes in the scope tmux-spawn-0.scope.",
  );
  // The chain is a clause of its own, for an example the reader can find,
  // and a repeated neighbour in it is written once.
  expect(single[0].started).toBe(
    " Started from PID 1000: systemd in init.scope.",
  );
  const two = fleet(2, 5);
  const pair = launcherCopy(two.escaped, two.procs, c, base);
  expect(pair).toHaveLength(2);
  expect(pair[0].conclusion).toContain(
    "5 processes in the scope tmux-spawn-0.scope",
  );
  expect(pair[1].conclusion).toContain(
    "5 processes in the scope tmux-spawn-1.scope",
  );
  expect(launcherCopy([], two.procs, c, base)).toEqual([]);
});

test("a group is the processes agreeing on all four facts its sentence states", () => {
  const c = defaults();
  // One scope, one conclusion, but two marker sets: two sentences, each
  // naming the markers its own processes carry.
  const caps = fleet(1, 1, { CARGO_BUILD_JOBS: "16" });
  const both = fleet(1, 1, {
    CARGO_BUILD_JOBS: "16",
    RUST_TEST_THREADS: "8",
  });
  const markers = launcherCopy(
    [...caps.escaped, ...both.escaped],
    [...caps.procs, ...both.escaped],
    c,
    base,
  );
  expect(markers).toHaveLength(2);
  expect(markers[0].conclusion).toContain("CARGO_BUILD_JOBS is set, but PID");
  expect(markers[1].conclusion).toContain(
    "RUST_TEST_THREADS and CARGO_BUILD_JOBS are set, but PID",
  );
  // One scope, one marker set, two PATH prefixes: two sentences again,
  // because the prefix is what tells the reader which launcher ran.
  const near = fleet(1, 2, { CARGO_BUILD_JOBS: "16", PATH: "/a/bin:/usr/bin" });
  const far = fleet(1, 3, { CARGO_BUILD_JOBS: "16", PATH: "/b/bin:/usr/bin" });
  const paths = launcherCopy(
    [...near.escaped, ...far.escaped],
    [...near.procs, ...far.escaped],
    c,
    base,
  );
  expect(paths).toHaveLength(2);
  expect(paths[0].conclusion).toContain("2 processes sit in");
  expect(paths[0].conclusion).toContain("PATH starts with /a/bin");
  expect(paths[1].conclusion).toContain("3 processes sit in");
  expect(paths[1].conclusion).toContain("PATH starts with /b/bin");
});
