// Proof tests for the lane findings in review/cloud-defect-review.md.
// Every test here FAILS on the reviewed commit; each failure is the defect.
// Run from the repository root:
//   PATH="$PWD/node_modules/.bin:$PATH" bun test review/tests/lanes.test.ts
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Collector } from "../../src/collect/collector";
import { defaults } from "../../src/config/config";
import { laneIntent, laneTarget, resolveIntent } from "../../src/model/actions";
import { lanes } from "../../src/model/lanes";
import {
  fixture,
  groupSnapshot,
  processSnapshot,
} from "../../src/test/fixture";
import { present } from "../../src/test/present";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

// A rootless container booted with systemd and a memory limit under the floor
// (`podman run --memory=512m <systemd image>`): the container's own systemd
// sits in a nested `init.scope`. The capped ancestor makes that nested scope a
// lane, and Stop names it to the USER manager by its bare name, which is the
// user manager's own unit (`user@UID.service/init.scope`). SIGTERM to a
// systemd user manager starts exit.target, ending the user's whole session.
test("Stop on a scope nested in a capped container never names the user manager's init.scope", async () => {
  const f = fixture();
  fixtures.push(f);
  const container = "user.slice/libpod-abc.scope";
  f.group("user.slice");
  f.group(container);
  f.write(join(f.config.cgroupRoot, container, "memory.max"), "536870912");
  f.group(`${container}/container`);
  f.group(`${container}/container/init.scope`, [500]);
  f.proc(500, `${container}/container/init.scope`, {
    command: ["/sbin/init"],
    comm: "systemd",
  });
  const s = await new Collector(f.config, 100, 4096).sample(1000);
  const lane = present(
    s.lanes.find((l) => l.cgroup === `${container}/container/init.scope`),
    "the nested init.scope lane",
  );
  const target = laneTarget(lane, f.config);
  const resolved =
    target === null
      ? null
      : resolveIntent(laneIntent("Stop", target), s, f.config);
  const argv =
    resolved?.state === "ready" && resolved.command.effect.kind === "run"
      ? resolved.command.effect.argv
      : null;
  // Received: ["systemctl","--user","kill","--signal=TERM","init.scope"]
  expect(argv).not.toEqual([
    "systemctl",
    "--user",
    "kill",
    "--signal=TERM",
    "init.scope",
  ]);
});

const kernelRoot = "/user.slice/user-1000.slice/user@1000.service";

// An escaped agent in a user service rather than a scope (`tmux.service`,
// `systemd-run --user` without --scope) gets a lane keyed by its absolute
// kernel path, which effectiveMax() compares against root-relative paths.
test("a group-less agent lane reports the 512 MiB cap of the service it runs in", () => {
  const c = defaults();
  const groups = [
    groupSnapshot({ path: ".", name: "user@1000.service", parent: "." }),
    groupSnapshot({ path: "app.slice", name: "app.slice", parent: "." }),
    groupSnapshot({
      path: "app.slice/agent.service",
      name: "agent.service",
      parent: "app.slice",
      pids: [7],
      max: 512 * 1024 * 1024,
      kernelPath: `${kernelRoot}/app.slice/agent.service`,
    }),
  ];
  const proc = processSnapshot({
    pid: 7,
    group: `${kernelRoot}/app.slice/agent.service`,
  });
  const lane = present(lanes(groups, [proc], c)[0], "the agent lane");
  // Received {max: null, known: true}, which the UI draws as "unlimited".
  expect({ max: lane.memoryMax, known: lane.memoryMaxKnown }).toEqual({
    max: 512 * 1024 * 1024,
    known: true,
  });
});

// An agent outside the configured root (an SSH login's session-N.scope)
// borrows the root group's answer and reads as known.
test("an agent outside the configured root does not read as known-unlimited", () => {
  const c = defaults();
  const groups = [
    groupSnapshot({ path: ".", name: "user@1000.service", parent: "." }),
  ];
  const proc = processSnapshot({
    pid: 8,
    group: "/user.slice/user-1000.slice/session-2.scope",
  });
  const lane = present(lanes(groups, [proc], c)[0], "the agent lane");
  expect(lane.memoryMaxKnown).toBe(false);
});

// A watched scope whose group CPU delta is unknown (its first sample) and
// whose listed process could not be read draws 0 % CPU and 0 B swap.
test("unknown group CPU and swap with no readable member stay unknown", () => {
  const c = defaults();
  const group = groupSnapshot({
    path: "app.slice/app-foo-1.scope",
    name: "app-foo-1.scope",
    parent: "app.slice",
    pids: [99],
    cpuPercent: null,
    swap: null,
  });
  const lane = present(lanes([group], [], c)[0], "the watched lane");
  expect({ cpu: lane.cpu, swap: lane.swap }).toEqual({ cpu: null, swap: null });
});

test("end to end: a listed pid that exited before /proc was read leaves CPU unknown", async () => {
  const f = fixture();
  fixtures.push(f);
  f.group("agents.slice/gone.scope", [77]);
  const s = await new Collector(f.config, 100, 4096).sample(1000);
  const lane = present(
    s.lanes.find((l) => l.cgroup === "agents.slice/gone.scope"),
    "the watched lane",
  );
  expect(lane.cpu).toBeNull();
});
