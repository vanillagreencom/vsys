import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, groupSnapshot, processSnapshot } from "../test/fixture";
import { present } from "../test/present";
import { laneIntent, laneTarget, resolveIntent } from "./actions";
import { lanes } from "./lanes";

test("A2-1 Stop refuses a scope below a configured container root", () => {
  const kernelRoot =
    "/user.slice/user-1000.slice/user@1000.service/app.slice/libpod-abc.scope/container";
  const c = {
    ...defaults(),
    cgroupRoot: `/sys/fs/cgroup${kernelRoot}`,
    writeMode: true,
  };
  const s = emptySnapshot();
  const path = "app.slice/build.scope";
  s.groups = [
    groupSnapshot({
      path,
      name: "build.scope",
      pids: [40],
      kernelPath: `${kernelRoot}/${path}`,
    }),
  ];
  s.procs = [processSnapshot({ group: `${kernelRoot}/${path}` })];
  s.lanes = lanes(s.groups, s.procs, c);
  const lane = present(s.lanes[0], "container lane");
  const target = present(
    laneTarget(lane, c, s.procs) ?? undefined,
    "container target",
  );
  const result = resolveIntent(laneIntent("Stop", target), s, c);
  if (result.state === "ready")
    expect(result.command.effect).toEqual({
      kind: "run",
      argv: ["systemctl", "--user", "kill", "--signal=TERM", "build.scope"],
    });
  expect(result.state).toBe("unaddressable");
});
