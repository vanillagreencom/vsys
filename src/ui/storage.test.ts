import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, groupSnapshot } from "../test/fixture";
import { writeLines } from "./storage";

const c = defaults();
test("write totals lead the Storage view with slice, device and drive rows", () => {
  const s = emptySnapshot();
  s.groups = [
    groupSnapshot({
      path: ".",
      parent: ".",
      name: "user@1000.service",
      ioWrite: 3298534883328,
    }),
    groupSnapshot({
      path: "agents.slice",
      parent: ".",
      name: "agents.slice",
      ioWrite: 2199023255552,
    }),
  ];
  s.storage.deviceWrites = { "259:0": 3298534883328, "253:0": 3298534883328 };
  s.storage.devices = [
    {
      name: "nvme0n1",
      number: "259:0",
      model: "Samsung",
      lifetimeWritten: 45079976738816,
    },
    { name: "dm-0", number: "253:0", model: null, lifetimeWritten: null },
  ];
  expect(writeLines(s, c)).toEqual([
    "Written since boot, by slice",
    "  agents.slice 2.0 TiB",
    "  app.slice not available",
    "Written since boot, by device",
    "  dm-0 3.0 TiB",
    "  nvme0n1 3.0 TiB",
    "  A dm- row repeats the writes of the disk beneath it.",
    "Lifetime writes reported by the drive",
    "  nvme0n1 (Samsung) 41.0 TiB",
    "  dm-0 not available",
  ]);
});
test("an unreadable source says so and never renders a blank row", () => {
  const s = emptySnapshot();
  expect(writeLines(s, c)).toEqual([
    "Written since boot, by slice",
    "  agents.slice not available",
    "  app.slice not available",
    "Written since boot, by device",
    "  not available",
    "Lifetime writes reported by the drive",
    "  not available",
  ]);
});
