import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, groupSnapshot } from "../test/fixture";
import { point } from "./point";

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
