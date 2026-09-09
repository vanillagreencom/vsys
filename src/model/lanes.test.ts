import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { processSnapshot } from "../test/fixture";
import { lanes, parentChain, processTree } from "./lanes";

test("process trees keep children under their own parent despite PID order", () => {
  const a = processSnapshot({ pid: 40, ppid: 1, start: 10 });
  const b = processSnapshot({ pid: 20, ppid: 1, start: 20 });
  const child = processSnapshot({ pid: 10, ppid: 40, start: 30 });
  const grandchild = processSnapshot({ pid: 30, ppid: 10, start: 40 });
  expect(
    processTree([child, b, grandchild, a]).map(({ proc, depth }) => [
      proc.pid,
      depth,
    ]),
  ).toEqual([
    [40, 0],
    [10, 1],
    [30, 2],
    [20, 0],
  ]);
  expect(parentChain(child, [child, { ...a, start: 50 }])).toEqual([]);
});

test("an ungrouped lane takes its main PID from the scope root, not enumeration order", () => {
  const c = defaults();
  const wrapper = processSnapshot({
    pid: 100,
    ppid: 1,
    start: 100,
    comm: "wrapper",
    cwd: "/repo/wrapper",
    group: "/user.slice/escaped",
  });
  const child = processSnapshot({
    pid: 50,
    ppid: 100,
    start: 200,
    comm: "claude",
    cwd: "/repo/child",
    group: "/user.slice/escaped",
  });
  const [only] = lanes([], [child, wrapper], c);
  expect([only.mainPid, only.name]).toEqual([100, "wrapper"]);
});
