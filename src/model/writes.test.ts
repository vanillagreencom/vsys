import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, groupSnapshot } from "../test/fixture";
import { writeTotals } from "./writes";

const c = defaults();
function snapshot() {
  const s = emptySnapshot();
  s.groups = [
    groupSnapshot({
      path: ".",
      parent: ".",
      name: "user@1000.service",
      ioWrite: 3_000_000,
    }),
    groupSnapshot({
      path: "agents.slice",
      parent: ".",
      name: "agents.slice",
      ioWrite: 2_000_000,
    }),
    groupSnapshot({
      path: "app.slice",
      parent: ".",
      name: "app.slice",
      ioWrite: 1_000_000,
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
  s.storage.deviceWrites = { "259:0": 2_000_000, "8:0": 1_000_000 };
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
    { name: "sda", written: null },
  ]);
  expect(t.devicesAvailable).toBe(true);
});
test("an unreadable counter stays unknown rather than becoming zero", () => {
  const s = snapshot();
  s.storage.deviceWrites = null;
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
test("a drive with no readable report keeps a named row of its own", () => {
  const s = snapshot();
  s.storage.devices = [
    { name: "sda", number: "8:0", model: null, lifetimeWritten: null },
    { name: "nvme0n1", number: "259:0", model: null, lifetimeWritten: 7 },
  ];
  expect(writeTotals(s, c).lifetime).toEqual([
    { name: "nvme0n1", written: 7 },
    { name: "sda", written: null },
  ]);
});
