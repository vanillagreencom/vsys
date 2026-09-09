import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, groupSnapshot } from "../test/fixture";
import { changed, type Point, point } from "./point";

test("CPU split follows configured slice names within nested layouts", () => {
  const c = {
    ...defaults(),
    agentSlice: "workers.slice",
    desktopSlice: "desktop.slice",
  };
  const s = emptySnapshot();
  s.groups = [
    groupSnapshot({
      name: "workers.slice",
      path: "tenant.slice/workers.slice",
      cpuPercent: 50,
    }),
    groupSnapshot({
      name: "desktop.slice",
      path: "tenant.slice/desktop.slice",
      cpuPercent: 100,
    }),
  ];
  expect(point(s, c).agents).toBe(50);
  expect(point(s, c).desktop).toBe(100);
});
test("unknown memory readings stay unknown instead of becoming zero", () => {
  const s = emptySnapshot();
  delete s.system.memory.MemAvailable;
  expect(point(s, defaults()).memory).toBeNull();
});
test("missing mount information cannot report zero corruption", () => {
  const s = emptySnapshot();
  expect(point(s, defaults()).corruption).toBe(0);
  s.storage.mountsAvailable = false;
  expect(point(s, defaults()).corruption).toBeNull();
});
test("an empty event list is not a change, and only a legacy point falls back", () => {
  const alert = {
    time: 1000,
    rule: "scrub" as const,
    subject: "/x",
    message: "problem",
  };
  const base = point(emptySnapshot(), defaults());
  expect(changed({ ...base, events: [], alerts: [alert] })).toBe(false);
  expect(
    changed({
      ...base,
      events: [
        {
          time: 1000,
          kind: "verdict",
          subject: "",
          subjectId: "",
          cause: "",
          names: {},
          values: {},
        },
      ],
      alerts: [],
    }),
  ).toBe(true);
  // A row written before events existed still marks its recorded alerts.
  const legacy = { ...base, alerts: [alert] } as Point;
  legacy.events = undefined as unknown as Point["events"];
  expect(changed(legacy)).toBe(true);
});
