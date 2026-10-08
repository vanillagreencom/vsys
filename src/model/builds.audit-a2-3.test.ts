import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, processSnapshot } from "../test/fixture";
import { present } from "../test/present";
import { buildsSummary, jobservers } from "./builds";

test("A2-3 an incomplete process sample keeps make token use unknown", () => {
  const c = defaults();
  const s = emptySnapshot();
  s.procs = [40, 41, 42].map((pid) =>
    processSnapshot({
      pid,
      tool: null,
      build: "cc",
      env: { MAKEFLAGS: "-j4 --jobserver-auth=fifo:/fixture/GMfifo" },
    }),
  );
  expect(present(jobservers(s, c)?.[0], "complete pool").inUse).toBe(3);
  s.procs.pop();
  s.processRead = "incomplete";
  s.errors = [{ source: `${c.procRoot}/42`, message: "EACCES" }];
  expect(buildsSummary(s, c).builds).toBeNull();
  expect(jobservers(s, c)).toBeNull();
  expect(buildsSummary(s, c).jobservers).toBeNull();
});
