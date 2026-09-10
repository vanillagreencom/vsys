import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, laneSnapshot } from "../test/fixture";
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
import type { Lane } from "./types";

const c = defaults();
const dir = `${c.cgroupRoot}/agents.slice/a.scope`;
const world = (lanes: Lane[]) => ({ ...emptySnapshot(), lanes });
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
  const target = laneTarget(lane, c);
  expect(target).toEqual({
    laneId: "agents.slice/a.scope",
    mainPid: 40,
    scope: "a.scope",
    directory: dir,
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
      target: laneTarget(laneSnapshot({ cgroup }), c),
    }).toEqual({ reason, target: null });
});

test("a copied command survives an escaped scope name and a path with a space", () => {
  // Real scope names carry systemd's own escapes: the Resources screen on a
  // desktop machine shows app-Hyprland-chromium\x2dpersonal-af7ff2b7.scope.
  const scope = "app-Hyprland-chromium\\x2dpersonal-af7ff2b7.scope";
  const root = "/tmp/vsys test/cgroup";
  const lane = laneSnapshot({ cgroup: `agents.slice/${scope}` });
  const target = laneTarget(lane, { ...c, cgroupRoot: root });
  expect(target).toEqual({
    laneId: lane.id,
    mainPid: lane.mainPid,
    scope,
    directory: `${root}/agents.slice/${scope}`,
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
  const target = laneTarget(lane, c);
  if (target === null) throw new Error("the fixture lane runs in a scope");
  const intent = laneIntent("Stop", target);
  // What a screen holds is the reader's half alone. There is no effect on it
  // to run, whatever happens to the lane afterwards.
  expect(intent).toEqual({
    action: "Stop",
    laneId: "agents.slice/a.scope",
    mainPid: 40,
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
