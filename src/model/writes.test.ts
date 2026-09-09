import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, groupSnapshot } from "../test/fixture";
import { deviceWrites, writeTotals } from "./writes";

const c = defaults();
function snapshot() {
  const s = emptySnapshot();
  s.groups = [
    groupSnapshot({
      path: ".",
      parent: ".",
      name: "user@1000.service",
      ioWrite: 3_000_000,
      ioWriteByDevice: { "259:0": 2_000_000, "8:0": 1_000_000 },
    }),
    groupSnapshot({
      path: "agents.slice",
      parent: ".",
      name: "agents.slice",
      ioWrite: 2_000_000,
      ioWriteByDevice: { "259:0": 2_000_000 },
    }),
    groupSnapshot({
      path: "app.slice",
      parent: ".",
      name: "app.slice",
      ioWrite: 1_000_000,
      ioWriteByDevice: { "8:0": 1_000_000 },
    }),
  ];
  s.storage.devices = [
    {
      name: "nvme0n1",
      number: "259:0",
      model: "Samsung",
      lifetimeWritten: 9_000_000,
    },
    { name: "sda", number: "8:0", model: null, lifetimeWritten: null },
  ];
  s.storage.smartAvailable = true;
  return s;
}
test("written bytes are reported per slice and per named device", () => {
  const t = writeTotals(snapshot(), c);
  expect(t.slices).toEqual([
    { name: "agents.slice", written: 2_000_000 },
    { name: "app.slice", written: 1_000_000 },
  ]);
  expect(t.devices).toEqual([
    { name: "nvme0n1", written: 2_000_000 },
    { name: "sda", written: 1_000_000 },
  ]);
  expect(t.lifetime).toEqual([
    { name: "nvme0n1 (Samsung)", written: 9_000_000 },
  ]);
  expect(t.devicesAvailable).toBe(true);
});
test("the cgroup root holds the device totals, so subtrees are not counted twice", () => {
  const s = snapshot();
  expect(deviceWrites(s.groups)).toEqual({
    "259:0": 2_000_000,
    "8:0": 1_000_000,
  });
  s.groups = s.groups.filter((g) => g.path !== ".");
  expect(deviceWrites(s.groups)).toEqual({
    "259:0": 2_000_000,
    "8:0": 1_000_000,
  });
});
test("an unreadable counter stays unknown rather than becoming zero", () => {
  const s = snapshot();
  s.groups[0].ioWriteByDevice = null;
  expect(deviceWrites(s.groups)).toBeNull();
  const missing = writeTotals(s, c);
  expect(missing.devicesAvailable).toBe(false);
  expect(missing.devices).toEqual([]);
  s.groups = s.groups.map((g) =>
    g.name === "app.slice" ? { ...g, ioWrite: null } : g,
  );
  expect(writeTotals(s, c).slices).toEqual([
    { name: "agents.slice", written: 2_000_000 },
    { name: "app.slice", written: null },
  ]);
});
test("SMART output that cannot be read leaves lifetime writes unavailable", () => {
  const s = snapshot();
  s.storage.smartAvailable = false;
  s.storage.devices = [
    { name: "sda", number: "8:0", model: null, lifetimeWritten: null },
  ];
  const t = writeTotals(s, c);
  expect(t.smartAvailable).toBe(false);
  expect(t.lifetime).toEqual([]);
});
