import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { laneSnapshot } from "../test/fixture";
import {
  type LaneAction,
  type LaneEffect,
  laneActions,
  laneCommand,
  laneTarget,
} from "./actions";

const c = defaults();
const dir = `${c.cgroupRoot}/agents.slice/a.scope`;

test("each action names the lane's own scope and the exact work it would do", () => {
  const target = laneTarget(laneSnapshot(), c);
  expect(target).toEqual({ scope: "a.scope", directory: dir });
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
    const command = laneCommand(action, target);
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
