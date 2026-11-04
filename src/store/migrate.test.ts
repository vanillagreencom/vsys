import { expect, test } from "bun:test";
import { emptySnapshot, serviceSnapshot } from "../test/fixture";
import { present } from "../test/present";
import { normalizeLane, normalizeSnapshot } from "./migrate";

test("snapshot replay leaves missing service warm-up readings unknown and keeps recorded values", () => {
  for (const values of [
    {},
    { cpuSoFarPercent: 0, cpuSoFarMs: 60_000 },
    { cpuSoFarPercent: 30, cpuSoFarMs: 720_000 },
  ]) {
    const s = emptySnapshot();
    const {
      cpuSoFarPercent: _percent,
      cpuSoFarMs: _span,
      ...legacy
    } = serviceSnapshot({ cpuHourPercent: 50 });
    const stored = JSON.parse(
      JSON.stringify({
        ...s,
        services: [{ ...legacy, ...values }],
      }),
    );
    const replay = normalizeSnapshot(stored);
    expect(present(replay.services?.[0], "the replayed service")).toMatchObject(
      {
        cpuHourPercent: 50,
        cpuSoFarPercent: values.cpuSoFarPercent ?? null,
        cpuSoFarMs: values.cpuSoFarMs ?? null,
      },
    );
    expect(normalizeSnapshot(replay)).toEqual(replay);
    expect(stored.services[0]).toEqual({ ...legacy, ...values });
  }
});

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
