import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { collectDevices, smartWrites } from "./devices";
import { Reader } from "./io";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
const nvme = `smartctl 7.4 2023-08-01 r5530 [x86_64-linux] (local build)

=== START OF SMART DATA SECTION ===
SMART/Health Information (NVMe Log 0x02)
Model Number:                       Samsung SSD 990 PRO 2TB
Data Units Read:                    1,000,000 [512 GB]
Data Units Written:                 8,000,000 [4.09 TB]
Power On Hours:                     1,234
`;
const ata = `smartctl 7.4 2023-08-01 r5530 [x86_64-linux] (local build)

Device Model:     Crucial CT1000MX500SSD1
ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
  9 Power_On_Hours          0x0032   099   099   000    Old_age   Always       -       4321
241 Total_LBAs_Written      0x0032   099   099   000    Old_age   Always       -       2000000
`;
test("lifetime writes come from NVMe data units and ATA logical blocks", () => {
  expect(smartWrites(nvme)).toEqual({
    model: "Samsung SSD 990 PRO 2TB",
    lifetimeWritten: 8_000_000 * 512 * 1000,
  });
  expect(smartWrites(ata)).toEqual({
    model: "Crucial CT1000MX500SSD1",
    lifetimeWritten: 2_000_000 * 512,
  });
});
test("a drive reporting no write counter stays unknown, never zero", () => {
  expect(smartWrites("Device Model: Old Disk\nPower_On_Hours 10\n")).toEqual({
    model: "Old Disk",
    lifetimeWritten: null,
  });
});
test("device numbers name io.stat devices and a missing report is not zero", () => {
  const f = fixture();
  fixtures.push(f);
  f.write(join(f.config.sysBlockRoot, "nvme0n1/dev"), "259:0\n");
  f.write(join(f.config.sysBlockRoot, "sda/dev"), "8:0\n");
  const absent = collectDevices(new Reader(), f.config);
  expect(absent.smartAvailable).toBe(false);
  expect(absent.devices).toEqual([
    { name: "nvme0n1", number: "259:0", model: null, lifetimeWritten: null },
    { name: "sda", number: "8:0", model: null, lifetimeWritten: null },
  ]);
  f.write(join(f.config.smartDir, "nvme0n1.txt"), nvme);
  const r = new Reader();
  const present = collectDevices(r, f.config);
  expect(present.smartAvailable).toBe(true);
  expect(present.devices[0]).toEqual({
    name: "nvme0n1",
    number: "259:0",
    model: "Samsung SSD 990 PRO 2TB",
    lifetimeWritten: 4_096_000_000_000,
  });
  expect(present.devices[1].lifetimeWritten).toBeNull();
  expect(r.errors).toEqual([]);
});
