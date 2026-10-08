import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { lanes } from "../model/lanes";
import { emptySnapshot, groupSnapshot, processSnapshot } from "../test/fixture";
import { present } from "../test/present";
import { EventLog } from "./events";

test("A3-4 an unread memory cap keeps its alert and verdict open", () => {
  const c = defaults();
  const hold = c.pressureHoldSeconds * 1000;
  const sample = (time: number, readable: boolean) => {
    const s = emptySnapshot(time);
    s.groups = [
      groupSnapshot({
        pids: [40],
        max: readable ? c.memoryFloor / 2 : null,
        maxRead: readable,
      }),
    ];
    s.procs = [processSnapshot()];
    s.lanes = lanes(s.groups, s.procs, c);
    return s;
  };
  const log = new EventLog();
  log.advance(emptySnapshot(1000), c);
  log.advance(sample(2000, true), c);
  const opened = log.advance(sample(2000 + hold, true), c);
  expect(
    opened.some(
      (event) => event.kind === "alert-open" && event.cause === "memory-cap",
    ),
  ).toBe(true);
  const unread = sample(3000 + hold, false);
  expect(present(unread.lanes[0], "same lane").memoryMaxKnown).toBe(false);
  log.advance(unread, c);
  const events = log.advance(sample(3000 + 2 * hold, false), c);
  expect(
    events.filter(
      (event) => event.kind === "alert-close" || event.kind === "verdict",
    ),
  ).toEqual([]);
});
