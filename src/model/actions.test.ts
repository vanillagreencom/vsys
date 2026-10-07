import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Collector } from "../collect/collector";
import { defaults } from "../config/config";
import {
  emptySnapshot,
  fixture,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../test/fixture";
import { present } from "../test/present";
import {
  type LaneAction,
  type LaneCommand,
  type LaneEffect,
  type LaneResolution,
  type LaneTarget,
  laneActions,
  laneIntent,
  laneTarget,
  resolveIntent,
} from "./actions";
import { lanes } from "./lanes";
import type { Lane } from "./types";

const c = defaults();
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
const dir = `${c.cgroupRoot}/agents.slice/a.scope`;
const procs = [processSnapshot()];
const world = (lanes: Lane[]) => ({ ...emptySnapshot(), lanes, procs });

test.each(laneActions)(
  "%s refuses a replacement with a reused process ID",
  (action) => {
    const sample = (start: number) => {
      const s = emptySnapshot();
      s.groups = [groupSnapshot({ pids: [40] })];
      s.procs = [processSnapshot({ pid: 40, start })];
      s.lanes = lanes(s.groups, s.procs, c);
      return s;
    };
    const before = sample(100);
    const target = present(
      laneTarget(
        present(before.lanes[0], "the confirmed lane"),
        c,
        before.procs,
      ) ?? undefined,
      "the confirmed target",
    );
    const intent = laneIntent(action, target);
    expect(resolveIntent(intent, before, c).state).toBe("ready");
    expect(resolveIntent(intent, sample(900), c).state).toBe("replaced");
  },
);

test("a lane with no readable leading process gets no action target", () => {
  // The collector produces a memberless scope when its process reads fail.
  const lane = laneSnapshot({ mainPid: 0, pids: [] });
  expect(laneTarget(lane, c, [])).toBeNull();
});

test.each(laneActions)(
  "%s refuses when the current sample cannot identify the leading process",
  (action) => {
    const lane = laneSnapshot();
    const target = present(
      laneTarget(lane, c, procs) ?? undefined,
      "the confirmed target",
    );
    const intent = laneIntent(action, target);
    expect(
      resolveIntent(intent, { ...world([lane]), procs: [] }, c).state,
    ).toBe("unaddressable");
  },
);
/**
 * The command an action reaches through the module's own seam. Nothing
 * outside builds one: an effect exists only where a snapshot justified it.
 */
function commandFor(
  action: LaneAction,
  target: LaneTarget,
  lanes: Lane[],
  config = c,
): LaneCommand {
  const resolved = resolveIntent(
    laneIntent(action, target),
    world(lanes),
    config,
  );
  if (resolved.state !== "ready")
    throw new Error(
      `the fixture lane resolves ${action}, not ${resolved.state}`,
    );
  return resolved.command;
}

test("each action names the lane's own scope and the exact work it would do", () => {
  const lane = laneSnapshot();
  const target = laneTarget(lane, c, procs);
  expect(target).toEqual({
    laneId: "agents.slice/a.scope",
    mainPid: 40,
    mainStart: 100,
    scope: "a.scope",
    directory: dir,
    actions: ["Freeze", "Thaw", "Stop"],
  });
  if (target === null) throw new Error("the fixture lane runs in a scope");
  const rows: [LaneAction, string, LaneEffect][] = [
    [
      "Freeze",
      `echo 1 > ${dir}/cgroup.freeze`,
      { kind: "cgroup", path: `${dir}/cgroup.freeze`, value: "1" },
    ],
    [
      "Thaw",
      `echo 0 > ${dir}/cgroup.freeze`,
      { kind: "cgroup", path: `${dir}/cgroup.freeze`, value: "0" },
    ],
    [
      "Stop",
      "systemctl --user kill --signal=TERM a.scope",
      {
        kind: "run",
        argv: ["systemctl", "--user", "kill", "--signal=TERM", "a.scope"],
      },
    ],
  ];
  // The menu is the source of the expected set, so an action added there
  // without a row here fails rather than going untested.
  expect(rows.map(([action]) => action)).toEqual([...laneActions]);
  for (const [action, text, effect] of rows) {
    const command = commandFor(action, target, [lane]);
    expect(command.action).toBe(action);
    expect(command.scope).toBe("a.scope");
    expect(command.text).toBe(text);
    expect(command.effect).toEqual(effect);
  }
});

test("a lane vsys cannot address by scope gets no target at all", () => {
  const rows: [string, string][] = [
    ["/user.slice/user-1000.slice/a.scope", "a kernel path from /proc"],
    ["agents.slice", "a slice, which systemctl kill would not address"],
    [".", "the watched root itself"],
    ["", "a lane with no cgroup"],
    ["agents.slice/../app.slice/a.scope", "a path that climbs out of the root"],
  ];
  // The reason travels with the row so a failure names which case broke.
  for (const [cgroup, reason] of rows)
    expect({
      reason,
      target: laneTarget(laneSnapshot({ cgroup }), c, procs),
    }).toEqual({ reason, target: null });
});

test("Stop is offered only for a scope systemd created as a unit", () => {
  // Stop names the scope by its bare name, so a scope systemd did not create
  // would name whichever unit holds that name. Freeze and Thaw write the
  // lane's own directory and stay.
  const rows: [string, LaneAction[]][] = [
    ["a.scope", ["Freeze", "Thaw", "Stop"]],
    ["agents.slice/a.scope", ["Freeze", "Thaw", "Stop"]],
    ["app.slice/app-x.slice/b.scope", ["Freeze", "Thaw", "Stop"]],
    ["user.slice/libpod-abc.scope/init.scope", ["Freeze", "Thaw"]],
    ["user.slice/libpod-abc.scope/container/init.scope", ["Freeze", "Thaw"]],
    // The container's own systemd makes slices of its own below the scope, so
    // a slice parent alone does not make the scope a host unit.
    [
      "user.slice/libpod-abc.scope/container/system.slice/a.scope",
      ["Freeze", "Thaw"],
    ],
    [
      "user.slice/libpod-abc.scope/container/user.slice/user-0.slice/user@0.service/app.slice/app-x.scope",
      ["Freeze", "Thaw"],
    ],
  ];
  for (const [cgroup, actions] of rows)
    expect({
      cgroup,
      actions: laneTarget(laneSnapshot({ cgroup }), c, procs)?.actions,
    }).toEqual({ cgroup, actions });
});

// A rootless container booted with systemd and a memory limit under the floor
// (`podman run --memory=512m <systemd image>`): the container's own systemd
// sits in a nested `init.scope`, and the capped ancestor makes it a lane. To
// the user manager that bare name is its own `user@UID.service/init.scope`,
// and SIGTERM there ends the reader's whole session.
test("Stop on a scope nested in a capped container never names the user manager's init.scope", async () => {
  const f = fixture();
  fixtures.push(f);
  const container = "user.slice/libpod-abc.scope";
  const nested = `${container}/container/init.scope`;
  f.group("user.slice");
  f.group(container);
  f.write(join(f.config.cgroupRoot, container, "memory.max"), "536870912");
  f.group(`${container}/container`);
  f.group(nested, [500]);
  f.proc(500, nested, { command: ["/sbin/init"], comm: "systemd" });
  f.group("agents.slice/a.scope", [40]);
  f.proc(40, "agents.slice/a.scope");
  const s = await new Collector(f.config, 100, 4096).sample(1000);
  const resolve = (cgroup: string, action: LaneAction) => {
    const lane = present(
      s.lanes.find((l) => l.cgroup === cgroup),
      `the ${cgroup} lane`,
    );
    const target = present(
      laneTarget(lane, f.config, s.procs) ?? undefined,
      cgroup,
    );
    return resolveIntent(laneIntent(action, target), s, f.config);
  };
  expect(resolve(nested, "Stop").state).toBe("unaddressable");
  expect(resolve(nested, "Freeze").state).toBe("ready");
  const stop = resolve("agents.slice/a.scope", "Stop");
  expect(stop.state === "ready" ? stop.command.effect : stop.state).toEqual({
    kind: "run",
    argv: ["systemctl", "--user", "kill", "--signal=TERM", "a.scope"],
  });
});

test("a copied command survives an escaped scope name and a path with a space", () => {
  // Real scope names carry systemd's own escapes: the Resources screen on a
  // desktop machine shows app-Hyprland-chromium\x2dpersonal-af7ff2b7.scope.
  const scope = "app-Hyprland-chromium\\x2dpersonal-af7ff2b7.scope";
  const root = "/tmp/vsys test/cgroup";
  const lane = laneSnapshot({ cgroup: `agents.slice/${scope}` });
  const target = laneTarget(lane, { ...c, cgroupRoot: root }, procs);
  expect(target).toEqual({
    laneId: lane.id,
    mainPid: lane.mainPid,
    mainStart: 100,
    scope,
    directory: `${root}/agents.slice/${scope}`,
    actions: ["Freeze", "Thaw", "Stop"],
  });
  if (target === null) throw new Error("the fixture lane runs in a scope");
  const freeze = commandFor("Freeze", target, [lane], {
    ...c,
    cgroupRoot: root,
  });
  const stop = commandFor("Stop", target, [lane], { ...c, cgroupRoot: root });
  expect(freeze.text).toBe(
    `echo 1 > '${root}/agents.slice/${scope}/cgroup.freeze'`,
  );
  expect(stop.text).toBe(`systemctl --user kill --signal=TERM '${scope}'`);
  // Quoting is for the reader's shell alone. The effect reaches the kernel and
  // systemd as values, so a quote in either would name a path or a unit that
  // does not exist.
  expect(freeze.effect).toEqual({
    kind: "cgroup",
    path: `${root}/agents.slice/${scope}/cgroup.freeze`,
    value: "1",
  });
  expect(stop.effect).toEqual({
    kind: "run",
    argv: ["systemctl", "--user", "kill", "--signal=TERM", scope],
  });
});

test("an intent reaches an effect only while it still names the same work", () => {
  const lane = laneSnapshot();
  const target = laneTarget(lane, c, procs);
  if (target === null) throw new Error("the fixture lane runs in a scope");
  const intent = laneIntent("Stop", target);
  // What a screen holds is the reader's half alone. There is no effect on it
  // to run, whatever happens to the lane afterwards.
  expect(intent).toEqual({
    action: "Stop",
    laneId: "agents.slice/a.scope",
    mainPid: 40,
    mainStart: 100,
    scope: "a.scope",
    text: "systemctl --user kill --signal=TERM a.scope",
  });
  const rows: [string, Lane[], LaneResolution["state"]][] = [
    ["the lane the reader confirmed", [lane], "ready"],
    ["a lane that ended", [], "ended"],
    [
      "its scope name taken by a later process",
      [laneSnapshot({ mainPid: 41 })],
      "replaced",
    ],
    [
      "a lane whose cgroup is no longer a scope",
      [laneSnapshot({ cgroup: "agents.slice" })],
      "unaddressable",
    ],
    [
      "a lane that moved to another scope",
      [laneSnapshot({ cgroup: "agents.slice/b.scope" })],
      "changed",
    ],
  ];
  // The reason travels with the row so a failure names which case broke.
  for (const [reason, lanes, state] of rows)
    expect({
      reason,
      state: resolveIntent(intent, world(lanes), c).state,
    }).toEqual({ reason, state });
  const ready = resolveIntent(intent, world([lane]), c);
  if (ready.state !== "ready") throw new Error("the same lane resolves");
  expect(ready.command.effect).toEqual({
    kind: "run",
    argv: ["systemctl", "--user", "kill", "--signal=TERM", "a.scope"],
  });
});
