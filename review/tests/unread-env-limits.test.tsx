// Cloud defect review 7, finding: the agent detail's Limits line says
// "make jobs not set · jobserver not set" for a lane whose leading process's
// environment vsys could not read. Run from the repository root:
//   bun test review/tests/unread-env-limits.test.tsx
// The first test asserts the promised behaviour and fails on main; the control
// shows the same words are right where the environment was read.
import { expect, test } from "bun:test";
import { defaults } from "../../src/config/config";
import { jobserver } from "../../src/model/naming";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../../src/test/fixture";
import { mount } from "../../src/test/harness";

async function limitsLine(envAvailable: boolean): Promise<string> {
  const s = emptySnapshot();
  // The model's own answer for an unread environment: jobs and jobserver come
  // back null, the same null an environment without MAKEFLAGS gives.
  s.lanes = [laneSnapshot({ jobs: null, jobserver: null })];
  s.groups = [groupSnapshot()];
  s.procs = [processSnapshot({ env: {}, envAvailable })];
  const t = await mount(s, defaults(), { width: 200, height: 60 });
  try {
    await t.press("2");
    await t.press("enter");
    const line = t
      .frame()
      .split("\n")
      .find((l) => l.includes("make jobs"));
    return line ?? "";
  } finally {
    await t.close();
  }
}

test("an unread environment leaves make jobs and the jobserver unknown, not unset", async () => {
  const line = await limitsLine(false);
  expect(line).toContain("make jobs");
  expect({
    saysNotSet: line.includes("not set"),
    saysUnknown: line.includes("make jobs not available"),
  }).toEqual({ saysNotSet: false, saysUnknown: true });
});

test("control: a read environment without the variables is not set", async () => {
  const line = await limitsLine(true);
  expect(line).toContain("make jobs not set");
});

test("the model gives one answer for both, so the screen cannot tell them apart", () => {
  // lanes() takes jobs and jobserver from jobserver(), which reads through
  // firstEnv() and returns null for an unreadable environment as it does for
  // an absent variable.
  const envNames = defaults().jobserverEnv;
  const unread = jobserver(
    processSnapshot({ env: {}, envAvailable: false }),
    envNames,
  );
  const unset = jobserver(
    processSnapshot({ env: {}, envAvailable: true }),
    envNames,
  );
  expect(unread).toEqual(unset);
  expect(unread).toEqual({ jobs: null, jobserver: null });
});
