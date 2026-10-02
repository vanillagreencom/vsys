import { expect, test } from "bun:test";
import type { CapabilityFailure } from "../model/types";
import { fakeBus, noBus } from "../test/udisks";
import { spawnText } from "./io";
import {
  ataWritten,
  classifyBusctl,
  nvmeWritten,
  readUdisks,
  Udisks,
  udisksHoldMs,
} from "./udisks";

/** Never answers, the shape a wedged busctl call over D-Bus takes. */
const hangs = () => new Promise<never>(() => {});

/** An ATA attribute row: id, name, flags, value, worst, threshold, pretty, unit, expansion. */
const ata = (pretty: number, unit: number) => [
  [9, "power-on-hours", 50, 99, 99, 0, 15_000_000, 2, {}],
  [241, "total-lbas-written", 50, 99, 99, 0, pretty, unit, {}],
];
const reply = (data: unknown) => JSON.stringify({ type: "x", data: [data] });

test("busctl's refusals are classified from its own words", () => {
  const rows: [string, CapabilityFailure][] = [
    // This host, which has no system bus.
    ["Failed to connect to bus: No such file or directory", "absent"],
    [
      "Failed to connect to system scope bus via local transport: No such file or directory",
      "absent",
    ],
    [
      "Call failed: The name org.freedesktop.UDisks2 was not provided by any .service files",
      "absent",
    ],
    ["Call failed: Unit udisks2.service not found.", "absent"],
    ["Call failed: Access denied", "unreadable"],
    // A reachable udisks2 refusing this user, not an absent bus.
    ["Failed to connect to bus: Permission denied", "unreadable"],
    [
      "Failed to connect to system scope bus via local transport: Operation not permitted",
      "unreadable",
    ],
    ["Failed to connect to bus: Connection refused", "unreadable"],
  ];
  for (const [error, failure] of rows)
    expect({ error, ...classifyBusctl(`${error}\n`) }).toEqual({
      error,
      failure,
      detail: error,
    });
});
test("NVMe gives bytes, and ATA gives bytes only where attribute 241 is in sectors", () => {
  expect(
    nvmeWritten(reply({ total_data_written: { type: "t", data: 4096000 } })),
  ).toBe(4096000);
  expect(
    nvmeWritten(reply({ percent_used: { type: "y", data: 3 } })),
  ).toBeNull();
  expect(ataWritten(reply(ata(2_000_000, 3)))).toBe(2_000_000 * 512);
  // Any other unit is not a count vsys can scale without a guess.
  expect(ataWritten(reply(ata(2_000_000, 1)))).toBeNull();
  expect(ataWritten(reply(ata(2_000_000, 0)))).toBeNull();
  expect(ataWritten(reply([]))).toBeNull();
});
test("each whole disk with a SMART drive is read, and a partition is no row", async () => {
  const calls: string[][] = [];
  const reading = await readUdisks(
    fakeBus(
      [
        {
          name: "nvme0n1",
          model: "Samsung SSD 990 PRO 2TB",
          kind: "nvme",
          attributes: { total_data_written: { type: "t", data: 9_000_000 } },
        },
        {
          name: "sda",
          model: "Crucial CT1000MX500SSD1",
          kind: "ata",
          attributes: ata(1000, 3),
        },
      ],
      calls,
    ),
  );
  expect(reading).toEqual({
    outcome: null,
    drives: [
      { name: "nvme0n1", model: "Samsung SSD 990 PRO 2TB", written: 9_000_000 },
      { name: "sda", model: "Crucial CT1000MX500SSD1", written: 512_000 },
    ],
  });
  expect(calls.slice(1).map((argv) => argv.slice(5, 7))).toEqual([
    [
      "/org/freedesktop/UDisks2/drives/nvme0n1_drive",
      "org.freedesktop.UDisks2.NVMe.Controller",
    ],
    [
      "/org/freedesktop/UDisks2/drives/sda_drive",
      "org.freedesktop.UDisks2.Drive.Ata",
    ],
  ]);
});
test("a source that could not be asked, or answered for no drive, says why", async () => {
  expect(await readUdisks(noBus)).toEqual({
    drives: [],
    outcome: {
      failure: "absent",
      detail: "Failed to connect to bus: No such file or directory",
    },
  });
  const missing = await readUdisks(async () => {
    throw Object.assign(new Error('Executable not found in $PATH: "busctl"'), {
      code: "ENOENT",
    });
  });
  expect(missing.outcome?.failure).toBe("absent");
  // A launch failure that is not a confirmed absence — the process limit
  // reached, say — is its own cause rather than mislabeled as no busctl on
  // the path.
  const launchFailure = Object.assign(
    new Error("EAGAIN: resource temporarily unavailable, posix_spawn"),
    { code: "EAGAIN" },
  );
  const stalled = await readUdisks(async () => {
    throw launchFailure;
  });
  expect(stalled).toEqual({
    drives: [],
    outcome: { failure: "unreadable", detail: String(launchFailure) },
  });
  const garbled = await readUdisks(async () => ({
    out: "{",
    error: "",
    status: 0,
    timedOut: false,
  }));
  expect(garbled.outcome?.failure).toBe("malformed");
  // One refusal among two drives keeps both rows and is no outcome; refusals
  // for every drive are.
  const bus = (second: unknown) =>
    fakeBus([
      {
        name: "nvme0n1",
        model: "A",
        kind: "nvme",
        attributes: { refuse: "Access denied" },
      },
      { name: "sda", model: "B", kind: "ata", attributes: second },
    ]);
  const one = await readUdisks(bus(ata(10, 3)));
  expect(one.outcome).toBeNull();
  expect(one.drives.map((d) => d.written)).toEqual([null, 5120]);
  const both = await readUdisks(bus({ refuse: "Access denied" }));
  expect(both.outcome).toEqual({
    failure: "incomplete",
    detail: "Call failed: Access denied",
  });
  expect(both.drives.map((d) => d.written)).toEqual([null, null]);
});
test("a block device with no drive, and a drive with no SMART interface, are excluded", async () => {
  const calls: string[][] = [];
  const reading = await readUdisks(
    fakeBus(
      [
        {
          name: "sda",
          model: "Crucial CT1000MX500SSD1",
          kind: "ata",
          attributes: ata(1000, 3),
        },
        {
          name: "sdb",
          model: "Unsupported Drive",
          kind: "none",
          attributes: null,
        },
      ],
      calls,
      ["dm-0"],
    ),
  );
  expect(reading.drives.map((d) => d.name)).toEqual(["sda"]);
  // Only sda's drive is ever asked for SmartGetAttributes: dm-0 has no Drive
  // to ask, and sdb's drive answers on neither SMART interface.
  expect(calls.slice(1)).toHaveLength(1);
});
test("a real child that outlives its deadline is read as an explained timeout, not an ordinary unexplained refusal", async () => {
  // A real busctl, not an unresolved promise: `trap "" TERM` makes it immune
  // to spawnText's own SIGTERM, so it is still running when spawnText's
  // deadline fires. Its outcome rests on spawnText's own `timedOut`, never on
  // which of two same-valued timers happened to fire first, so the explained
  // timeout lands every time, not only when the race broke vsys's way.
  const stalled = async (_argv: string[], timeoutMs?: number) =>
    spawnText(["bash", "-c", 'trap "" TERM; sleep 30'], timeoutMs);
  const reading = await readUdisks(stalled, 50);
  expect(reading).toEqual({
    drives: [],
    outcome: {
      failure: "unreadable",
      detail: "busctl did not answer within 50 ms",
    },
  });
});
test("a listing that never answers is abandoned at the deadline, not left hanging", async () => {
  const reading = await readUdisks(hangs, 10);
  expect(reading).toEqual({
    drives: [],
    outcome: {
      failure: "unreadable",
      detail: "busctl did not answer within 10 ms",
    },
  });
});
test("a drive whose SMART query fails to launch keeps its row, written unknown, rather than reject the whole reading", async () => {
  const calls: string[][] = [];
  const run = fakeBus(
    [{ name: "sda", model: "B", kind: "ata", attributes: ata(10, 3) }],
    calls,
  );
  const launchFailure = Object.assign(
    new Error("EAGAIN: resource temporarily unavailable, posix_spawn"),
    { code: "EAGAIN" },
  );
  const reading = await readUdisks(async (argv) => {
    if (argv.includes("GetManagedObjects")) return run(argv);
    throw launchFailure;
  });
  expect(reading).toEqual({
    drives: [{ name: "sda", model: "B", written: null }],
    outcome: { failure: "incomplete", detail: launchFailure.message },
  });
});
test("a drive query spawnText reports timed out is read as a timeout, even though its status and empty stderr alone look like an ordinary SIGTERM exit", async () => {
  const calls: string[][] = [];
  const run = fakeBus(
    [{ name: "sda", model: "B", kind: "ata", attributes: ata(10, 3) }],
    calls,
  );
  const reading = await readUdisks(async (argv) => {
    if (argv.includes("GetManagedObjects")) return run(argv);
    // The exact ambiguity a deadline-killed busctl can leave behind: the
    // same status and empty stderr an ordinary SIGTERM exit would have.
    // `timedOut` is the one field telling this apart from that.
    return { out: "", error: "", status: 143, timedOut: true };
  }, 50);
  expect(reading).toEqual({
    drives: [{ name: "sda", model: "B", written: null }],
    outcome: {
      failure: "incomplete",
      detail: "busctl did not answer within 50 ms",
    },
  });
});
test("a drive whose SMART query never answers keeps its row, written unknown", async () => {
  const calls: string[][] = [];
  const run = fakeBus(
    [{ name: "sda", model: "B", kind: "ata", attributes: ata(10, 3) }],
    calls,
  );
  const reading = await readUdisks(async (argv) => {
    if (argv.includes("GetManagedObjects")) return run(argv);
    return hangs();
  }, 10);
  expect(reading).toEqual({
    drives: [{ name: "sda", model: "B", written: null }],
    outcome: {
      failure: "incomplete",
      detail: "busctl did not answer within 10 ms",
    },
  });
});
test("a read is held for the hold time on the clock it is given", async () => {
  const calls: string[][] = [];
  let now = 0;
  const udisks = new Udisks(
    fakeBus(
      [{ name: "sda", model: "B", kind: "ata", attributes: ata(10, 3) }],
      calls,
    ),
    () => now,
  );
  await udisks.read();
  now = udisksHoldMs - 1;
  await udisks.read();
  expect(calls).toHaveLength(2);
  now = udisksHoldMs;
  await udisks.read();
  expect(calls).toHaveLength(4);
});
