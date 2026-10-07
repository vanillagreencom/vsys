import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { present } from "../test/present";
import { collectDevices, smartReports, smartWrites } from "./devices";
import { Reader } from "./io";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
test("a reused device name rejects the previous drive report", () => {
  const f = fixture();
  fixtures.push(f);
  f.write(join(f.config.sysBlockRoot, "sda/dev"), "8:0\n");
  f.write(join(f.config.sysBlockRoot, "sda/device/model"), "Replacement SSD\n");
  f.write(join(f.config.sysBlockRoot, "sda/device/serial"), "REPLACEMENT\n");
  f.write(
    join(f.config.smartDir, "sda.txt"),
    "Device Model: Previous SSD\nSerial Number: PREVIOUS\n241 Total_LBAs_Written 0x0032 099 099 000 Old_age Always - 2000000\n",
  );
  const reader = new Reader();
  const device = present(
    collectDevices(reader, f.config, smartReports(reader, f.config).reports)[0],
    "replacement drive",
  );
  expect(reader.errors).toEqual([]);
  expect({
    model: device.model,
    lifetimeWritten: device.lifetimeWritten,
    source: device.source,
  }).toEqual({ model: null, lifetimeWritten: null, source: null });
});
test("a saved drive total requires matching nonempty serial numbers", () => {
  const f = fixture();
  fixtures.push(f);
  const serialPath = join(f.config.sysBlockRoot, "sda/device/serial");
  const reportPath = join(f.config.smartDir, "sda.txt");
  f.write(join(f.config.sysBlockRoot, "sda/dev"), "8:0\n");
  const rows = [
    { current: "SN-1", reported: "SN-1", accepted: true },
    { current: "SN-2", reported: "SN-1", accepted: false },
    { current: null, reported: "SN-1", accepted: false },
    { current: "", reported: "SN-1", accepted: false },
    { current: "SN-1", reported: null, accepted: false },
    { current: "SN-1", reported: "", accepted: false },
  ];
  for (const row of rows) {
    if (row.current === null) rmSync(serialPath);
    else f.write(serialPath, `${row.current}\n`);
    f.write(
      reportPath,
      `Device Model: Same model\n${row.reported === null ? "" : `Serial Number: ${row.reported}\n`}241 Total_LBAs_Written 0x0032 099 099 000 Old_age Always - 2000000\n`,
    );
    const reader = new Reader();
    const device = present(
      collectDevices(reader, f.config, new Map([["sda", reportPath]]))[0],
      "current drive",
    );
    expect({
      row,
      model: device.model,
      written: device.lifetimeWritten,
      source: device.source,
    }).toEqual({
      row,
      model: row.accepted ? "Same model" : null,
      written: row.accepted ? 1_024_000_000 : null,
      source: row.accepted ? "smartctl" : null,
    });
    expect(reader.errors).toEqual([]);
  }
});
const nvme = `smartctl 7.4 2023-08-01 r5530 [x86_64-linux] (local build)

=== START OF SMART DATA SECTION ===
SMART/Health Information (NVMe Log 0x02)
Model Number:                       Samsung SSD 990 PRO 2TB
Serial Number:                      NVME-DRIVE
Data Units Read:                    1,000,000 [512 GB]
Data Units Written:                 8,000,000 [4.09 TB]
Power On Hours:                     1,234
`;
const ata = `smartctl 7.4 2023-08-01 r5530 [x86_64-linux] (local build)

Model Family:     Crucial/Micron Client SSDs
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
test("a family name is used only when the drive names no model of its own", () => {
  expect(smartWrites("Model Family: Crucial SSDs\n").model).toBe(
    "Crucial SSDs",
  );
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
  f.write(join(f.config.sysBlockRoot, "loop0/dev"), "7:0\n");
  // With no report directory both drives are still named, neither is dropped,
  // and the missing directory is a capability rather than a source error.
  const r = new Reader();
  const none = smartReports(r, f.config);
  expect(none.outcome?.failure).toBe("absent");
  expect(collectDevices(r, f.config, none.reports)).toEqual([
    {
      name: "nvme0n1",
      number: "259:0",
      model: null,
      lifetimeWritten: null,
      source: null,
    },
    {
      name: "sda",
      number: "8:0",
      model: null,
      lifetimeWritten: null,
      source: null,
    },
  ]);
  f.write(join(f.config.smartDir, "nvme0n1.txt"), nvme);
  f.write(join(f.config.sysBlockRoot, "nvme0n1/device/serial"), "NVME-DRIVE\n");
  const listed = smartReports(r, f.config);
  expect(listed.outcome).toBeNull();
  // One report among two drives leaves both rows, one of them still unknown.
  expect(collectDevices(r, f.config, listed.reports)).toEqual([
    {
      name: "nvme0n1",
      number: "259:0",
      model: "Samsung SSD 990 PRO 2TB",
      lifetimeWritten: 4_096_000_000_000,
      source: "smartctl",
    },
    {
      name: "sda",
      number: "8:0",
      model: null,
      lifetimeWritten: null,
      source: null,
    },
  ]);
  expect(r.errors).toEqual([]);
});
test("udisks fills a drive only where it has no report, and names itself", () => {
  const f = fixture();
  fixtures.push(f);
  f.write(join(f.config.sysBlockRoot, "nvme0n1/dev"), "259:0\n");
  f.write(join(f.config.sysBlockRoot, "sda/dev"), "8:0\n");
  f.write(join(f.config.sysBlockRoot, "sdb/dev"), "8:16\n");
  f.write(join(f.config.smartDir, "nvme0n1.txt"), nvme);
  f.write(join(f.config.sysBlockRoot, "nvme0n1/device/serial"), "NVME-DRIVE\n");
  const r = new Reader();
  const { reports } = smartReports(r, f.config);
  const udisks = [
    {
      name: "nvme0n1",
      model: "Other",
      written: 1,
      identity: null,
      detected: null,
    },
    {
      name: "sda",
      model: "Crucial CT1000MX500SSD1",
      written: 1024,
      identity: "SN-SDA",
      detected: null,
    },
    {
      name: "sdb",
      model: "Old Disk",
      written: null,
      identity: null,
      detected: null,
    },
  ];
  expect(collectDevices(r, f.config, reports, udisks)).toEqual([
    {
      name: "nvme0n1",
      number: "259:0",
      model: "Samsung SSD 990 PRO 2TB",
      lifetimeWritten: 4_096_000_000_000,
      source: "smartctl",
    },
    {
      name: "sda",
      number: "8:0",
      model: "Crucial CT1000MX500SSD1",
      lifetimeWritten: 1024,
      source: "udisks",
    },
    // A total udisks did not give stays unknown, with no source to name.
    {
      name: "sdb",
      number: "8:16",
      model: "Old Disk",
      lifetimeWritten: null,
      source: null,
    },
  ]);
});
test("a report directory that cannot be listed for any reason but absence is a source error", () => {
  const f = fixture();
  fixtures.push(f);
  // A file where the directory should be cannot be listed, whoever runs this.
  f.write(f.config.smartDir, "not a directory\n");
  const r = new Reader();
  expect(smartReports(r, f.config).reports.size).toBe(0);
  expect(r.errors.map((e) => e.source)).toEqual([f.config.smartDir]);
});
