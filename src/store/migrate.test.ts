import { expect, test } from "bun:test";
import { normalizeLane } from "./migrate";

test("a stored lane that predates jobsKnown keeps its recorded make reading known", () => {
  const recorded = normalizeLane({ id: "a", jobs: 6, jobserver: null });
  expect(recorded.jobsKnown).toBe(true);
  expect(normalizeLane({ id: "b", jobserver: "fifo:/tmp/f" }).jobsKnown).toBe(
    true,
  );
  // Nulls stored before the flag cannot tell unset from unread.
  expect(
    normalizeLane({ id: "c", jobs: null, jobserver: null }).jobsKnown,
  ).toBe(false);
  // A stored flag is kept as it was.
  expect(
    normalizeLane({ id: "d", jobs: null, jobserver: null, jobsKnown: true })
      .jobsKnown,
  ).toBe(true);
});
