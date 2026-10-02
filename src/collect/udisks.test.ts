import { expect, test } from "bun:test";
import type { CapabilityFailure } from "../model/types";
import type { FakeDrive } from "../test/udisks";
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
      {
        name: "nvme0n1",
        model: "Samsung SSD 990 PRO 2TB",
        written: 9_000_000,
        identity: null,
        detected: null,
      },
      {
        name: "sda",
        model: "Crucial CT1000MX500SSD1",
        written: 512_000,
        identity: null,
        detected: null,
      },
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
      detail: "busctl runner abandoned after 2510 ms with no response",
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
    drives: [
      {
        name: "sda",
        model: "B",
        written: null,
        identity: null,
        detected: null,
      },
    ],
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
    drives: [
      {
        name: "sda",
        model: "B",
        written: null,
        identity: null,
        detected: null,
      },
    ],
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
    drives: [
      {
        name: "sda",
        model: "B",
        written: null,
        identity: null,
        detected: null,
      },
    ],
    outcome: {
      failure: "incomplete",
      detail: "busctl runner abandoned after 2510 ms with no response",
    },
  });
});
test("the SMART query is held for the hold time, but the cheap listing is asked every sample", async () => {
  const calls: string[][] = [];
  let now = 0;
  const udisks = new Udisks(
    fakeBus(
      [
        {
          name: "sda",
          model: "B",
          kind: "ata",
          attributes: ata(10, 3),
          serial: "SN1",
        },
      ],
      calls,
    ),
    () => now,
  );
  await udisks.read();
  expect(calls).toHaveLength(2); // listing + SmartGetAttributes
  now = udisksHoldMs - 1;
  await udisks.read();
  // Within the hold the listing runs again to check identity, costing one
  // more call, but the SMART query is not repeated.
  expect(calls).toHaveLength(3);
  now = udisksHoldMs;
  await udisks.read();
  // The hold has expired: the full read, listing and query both, runs again.
  expect(calls).toHaveLength(5);
});
test("a kernel name reused by a different drive within the hold is read fresh, not served the departed drive's numbers", async () => {
  const calls: string[][] = [];
  let now = 0;
  let live = [
    {
      name: "sda",
      model: "Old Drive",
      kind: "ata" as const,
      attributes: ata(1000, 3),
      serial: "SERIAL-OLD",
    },
  ];
  const run: typeof spawnText = (argv, timeoutMs) =>
    fakeBus(live, calls)(argv, timeoutMs);
  const udisks = new Udisks(run, () => now);
  const first = await udisks.read();
  expect(first).toEqual({
    outcome: null,
    drives: [
      {
        name: "sda",
        model: "Old Drive",
        written: 512_000,
        identity: "SERIAL-OLD",
        detected: null,
      },
    ],
  });
  // The physical drive behind sda is swapped well inside the hold window:
  // same kernel name, a different serial and a different SMART history.
  now = udisksHoldMs - 1;
  live = [
    {
      name: "sda",
      model: "New Drive",
      kind: "ata" as const,
      attributes: ata(5, 3),
      serial: "SERIAL-NEW",
    },
  ];
  const second = await udisks.read();
  expect(second).toEqual({
    outcome: null,
    drives: [
      {
        name: "sda",
        model: "New Drive",
        written: 2_560,
        identity: "SERIAL-NEW",
        detected: null,
      },
    ],
  });
  // A same-identity re-read within the hold still serves the held reading,
  // never re-querying the drive.
  const queriesSoFar = calls.filter((argv) =>
    argv.includes("SmartGetAttributes"),
  ).length;
  now = udisksHoldMs; // still within the hold the swap read started
  const third = await udisks.read();
  expect(third).toEqual(second);
  expect(
    calls.filter((argv) => argv.includes("SmartGetAttributes")).length,
  ).toBe(queriesSoFar);
});
test("a drive that loses its identity, with no TimeDetected either, goes unknown rather than keep serving the departed drive's numbers; one that later regains an identity is read fresh again", async () => {
  let now = 0;
  let live: FakeDrive[] = [
    {
      name: "sda",
      model: "Has Identity",
      kind: "ata",
      attributes: ata(1000, 3),
      serial: "SERIAL-OLD",
    },
  ];
  const run: typeof spawnText = (argv, timeoutMs) =>
    fakeBus(live)(argv, timeoutMs);
  const udisks = new Udisks(run, () => now);
  const first = await udisks.read();
  expect(first.drives).toEqual([
    {
      name: "sda",
      model: "Has Identity",
      written: 512_000,
      identity: "SERIAL-OLD",
      detected: null,
    },
  ]);
  // Swapped, still inside the hold, for a drive reporting neither a serial,
  // a WWN nor a TimeDetected: the old identity disappearing is itself a
  // sign the drive changed, but the replacement gives nothing left to
  // confirm or query it by, so it reads as unknown rather than keep the
  // departed drive's numbers or invent new ones.
  now = udisksHoldMs - 1;
  live = [
    { name: "sda", model: "No Identity", kind: "ata", attributes: ata(5, 3) },
  ];
  const second = await udisks.read();
  expect(second.drives).toEqual([
    {
      name: "sda",
      model: null,
      written: null,
      identity: null,
      detected: null,
    },
  ]);
  // A drive now reporting an identity again, after a stretch answering
  // unprovable: the reappearing identity is read fresh, the same as any
  // other provable drive the held reading has nothing for yet.
  now = 2 * udisksHoldMs - 2;
  live = [
    {
      name: "sda",
      model: "Has Identity Again",
      kind: "ata",
      attributes: ata(1, 3),
      serial: "SERIAL-NEW",
    },
  ];
  const third = await udisks.read();
  expect(third.drives).toEqual([
    {
      name: "sda",
      model: "Has Identity Again",
      written: 512,
      identity: "SERIAL-NEW",
      detected: null,
    },
  ]);
});
test("two identity-less drives swapped under one kernel name are told apart by TimeDetected, never serving the departed drive's reading", async () => {
  const calls: string[][] = [];
  let now = 0;
  let live: FakeDrive[] = [
    {
      name: "sda",
      model: "Old Drive",
      kind: "ata",
      attributes: ata(1000, 3),
      detected: 1_000_000,
    },
  ];
  const run: typeof spawnText = (argv, timeoutMs) =>
    fakeBus(live, calls)(argv, timeoutMs);
  const udisks = new Udisks(run, () => now);
  const first = await udisks.read();
  expect(first.drives).toEqual([
    {
      name: "sda",
      model: "Old Drive",
      written: 512_000,
      identity: null,
      detected: 1_000_000,
    },
  ]);
  // The physical drive behind sda is swapped inside the hold for another
  // that also reports neither a serial nor a WWN: identity alone cannot
  // tell them apart, but a changed TimeDetected does.
  now = udisksHoldMs - 1;
  live = [
    {
      name: "sda",
      model: "New Drive",
      kind: "ata",
      attributes: ata(5, 3),
      detected: 2_000_000,
    },
  ];
  const second = await udisks.read();
  expect(second.drives).toEqual([
    {
      name: "sda",
      model: "New Drive",
      written: 2_560,
      identity: null,
      detected: 2_000_000,
    },
  ]);
  // Unchanged and still inside the hold, with TimeDetected still equal: the
  // held reading keeps serving, the drive is not re-queried.
  const queriesSoFar = calls.filter((argv) =>
    argv.includes("SmartGetAttributes"),
  ).length;
  now = udisksHoldMs;
  const third = await udisks.read();
  expect(third).toEqual(second);
  expect(
    calls.filter((argv) => argv.includes("SmartGetAttributes")).length,
  ).toBe(queriesSoFar);
});
test("a drive with neither an identity nor a TimeDetected reads as unknown on every sample, never queried at all, with no effect on an unrelated sibling", async () => {
  const calls: string[][] = [];
  let now = 0;
  // sda gives udisks no identity and no TimeDetected at all: nothing ever
  // ties one sample's sda to the next one's, so it never enters the held
  // reading or a SMART query. sdb is a steady, identified sibling on the
  // same host, confirmed same every sample through its own serial.
  const live: FakeDrive[] = [
    {
      name: "sda",
      model: "Ambiguous Drive",
      kind: "ata",
      attributes: ata(1000, 3),
    },
    {
      name: "sdb",
      model: "Sibling Drive",
      kind: "ata",
      attributes: ata(10, 3),
      serial: "SIB-1",
    },
  ];
  const run: typeof spawnText = (argv, timeoutMs) =>
    fakeBus(live, calls)(argv, timeoutMs);
  const udisks = new Udisks(run, () => now);
  const first = await udisks.read();
  expect(first.drives).toEqual([
    {
      name: "sda",
      model: null,
      written: null,
      identity: null,
      detected: null,
    },
    {
      name: "sdb",
      model: "Sibling Drive",
      written: 5_120,
      identity: "SIB-1",
      detected: null,
    },
  ]);
  // sda was never a target queryDrives saw at all: only sdb's own query ran.
  const queriesAfterFirst = calls.filter((argv) =>
    argv.includes("SmartGetAttributes"),
  ).length;
  expect(queriesAfterFirst).toBe(1);
  // Nothing on the bus changed — same two drives, same attributes — but sda
  // still gives no signal to confirm or query it by, so it keeps reading as
  // unknown; sdb, provably unchanged through its own serial, keeps serving
  // its held reading untouched.
  for (const sample of [udisksHoldMs / 2, udisksHoldMs - 1]) {
    now = sample;
    const reading = await udisks.read();
    expect(reading.drives).toEqual([
      {
        name: "sda",
        model: null,
        written: null,
        identity: null,
        detected: null,
      },
      {
        name: "sdb",
        model: "Sibling Drive",
        written: 5_120,
        identity: "SIB-1",
        detected: null,
      },
    ]);
  }
  // Three samples in, sda has cost no SmartGetAttributes call at all, and
  // sdb was never dragged into a re-query either.
  expect(
    calls.filter((argv) => argv.includes("SmartGetAttributes")).length,
  ).toBe(queriesAfterFirst);
});
test("two drives, neither reporting a Serial, a WWN nor a TimeDetected, swapped under one kernel name within the hold, both read as unknown rather than either one's numbers ever being served", async () => {
  let now = 0;
  let live: FakeDrive[] = [
    { name: "sda", model: "Old Drive", kind: "ata", attributes: ata(1000, 3) },
  ];
  const run: typeof spawnText = (argv, timeoutMs) =>
    fakeBus(live)(argv, timeoutMs);
  const udisks = new Udisks(run, () => now);
  const first = await udisks.read();
  expect(first.drives).toEqual([
    { name: "sda", model: null, written: null, identity: null, detected: null },
  ]);
  now = udisksHoldMs - 1;
  live = [
    { name: "sda", model: "New Drive", kind: "ata", attributes: ata(5, 3) },
  ];
  const second = await udisks.read();
  expect(second.drives).toEqual([
    { name: "sda", model: null, written: null, identity: null, detected: null },
  ]);
});
test("a drive replaced by one with no SMART interface is dropped, not left answering with the departed drive's numbers", async () => {
  let now = 0;
  let live: FakeDrive[] = [
    {
      name: "sda",
      model: "Old Drive",
      kind: "ata",
      attributes: ata(1000, 3),
      serial: "SERIAL-OLD",
    },
  ];
  const run: typeof spawnText = (argv, timeoutMs) =>
    fakeBus(live)(argv, timeoutMs);
  const udisks = new Udisks(run, () => now);
  const first = await udisks.read();
  expect(first.drives).toHaveLength(1);
  // The physical drive behind sda is swapped, inside the hold, for one with
  // neither the NVMe nor the ATA SMART interface: `udisksTargets` names no
  // target for it at all, so the held name is simply absent from the fresh
  // listing rather than mismatched against it.
  now = udisksHoldMs - 1;
  live = [
    { name: "sda", model: "Unsupported Drive", kind: "none", attributes: null },
  ];
  const second = await udisks.read();
  expect(second).toEqual({ drives: [], outcome: null });
});
test("a listing that fails during the hold is never read as proof of no swap: its own failure surfaces rather than the held reading's stale outcome, and is never asked a second time", async () => {
  const calls: string[][] = [];
  const good = fakeBus(
    [
      {
        name: "sda",
        model: "B",
        kind: "ata",
        attributes: ata(10, 3),
        serial: "SN1",
      },
    ],
    calls,
  );
  let failing = false;
  const run: typeof spawnText = async (argv, timeoutMs) => {
    if (failing && argv.includes("GetManagedObjects")) {
      calls.push(argv);
      return {
        out: "",
        error: "Failed to connect to bus: No such file or directory\n",
        status: 1,
        timedOut: false,
      };
    }
    return good(argv, timeoutMs);
  };
  let now = 0;
  const udisks = new Udisks(run, () => now);
  const first = await udisks.read();
  expect(first.outcome).toBeNull();
  // The bus goes down for the rest of this hold, starting with the very
  // listing call read() makes to check for a swap.
  failing = true;
  now = udisksHoldMs - 1;
  const listingsBefore = calls.filter((argv) =>
    argv.includes("GetManagedObjects"),
  ).length;
  const second = await udisks.read();
  expect(second).toEqual({
    drives: [],
    outcome: {
      failure: "absent",
      detail: "Failed to connect to bus: No such file or directory",
    },
  });
  // A failed swap-check listing must not fall through to readUdisks() for a
  // second, identical listing call: only one listing call per read().
  const listingsAfter = calls.filter((argv) =>
    argv.includes("GetManagedObjects"),
  ).length;
  expect(listingsAfter - listingsBefore).toBe(1);
});
test("a listing failure during the hold does not poison the samples after it: a healthy listing on the very next one fully recovers", async () => {
  // Same identity throughout, so identitySwapped() never forces a fresh
  // read on that ground alone; the drive's own SMART reading changes after
  // the blip so a served-stale pre-outage value reads differently from a
  // genuine fresh re-query, and the assertion below can tell them apart.
  let live: FakeDrive[] = [
    {
      name: "sda",
      model: "B",
      kind: "ata",
      attributes: ata(10, 3),
      serial: "SN1",
    },
  ];
  let failNext = false;
  const run: typeof spawnText = async (argv, timeoutMs) => {
    if (failNext && argv.includes("GetManagedObjects")) {
      failNext = false;
      return {
        out: "",
        error: "Failed to connect to bus: No such file or directory\n",
        status: 1,
        timedOut: false,
      };
    }
    return fakeBus(live)(argv, timeoutMs);
  };
  let now = 0;
  const udisks = new Udisks(run, () => now);
  const first = await udisks.read();
  expect(first.drives).toEqual([
    {
      name: "sda",
      model: "B",
      written: 5_120,
      identity: "SN1",
      detected: null,
    },
  ]);
  // One listing blip, well inside the hold. The drive's SMART reading moves
  // before the bus answers again.
  now = 10;
  failNext = true;
  live = [
    {
      name: "sda",
      model: "B",
      kind: "ata",
      attributes: ata(20, 3),
      serial: "SN1",
    },
  ];
  const second = await udisks.read();
  expect(second.outcome?.failure).toBe("absent");
  // The bus answers again for the very next sample, still inside the same
  // hold window: the fresh reading must come back, not the pre-outage one —
  // a served-stale held.reading would still show 5_120, not 10_240.
  now = 20;
  const third = await udisks.read();
  expect(third).toEqual({
    outcome: null,
    drives: [
      {
        name: "sda",
        model: "B",
        written: 10_240,
        identity: "SN1",
        detected: null,
      },
    ],
  });
});
test("two consecutive listing failures inside the hold end up holding an empty reading, but the next healthy sample restores it at once rather than for the rest of the hold", async () => {
  const calls: string[][] = [];
  const good = fakeBus(
    [
      {
        name: "sda",
        model: "B",
        kind: "ata",
        attributes: ata(10, 3),
        serial: "SN1",
      },
    ],
    calls,
  );
  let failing = false;
  const run: typeof spawnText = async (argv, timeoutMs) => {
    if (failing && argv.includes("GetManagedObjects")) {
      calls.push(argv);
      return {
        out: "",
        error: "Failed to connect to bus: No such file or directory\n",
        status: 1,
        timedOut: false,
      };
    }
    return good(argv, timeoutMs);
  };
  let now = 0;
  const udisks = new Udisks(run, () => now);
  const first = await udisks.read();
  expect(first.drives).toHaveLength(1);
  // The first failure drops the held reading outright; the next read() then
  // takes the non-held branch and runs readUdisks() fresh, whose own listing
  // fails again — this second failure's empty result is what ends up held.
  failing = true;
  now = 10;
  const second = await udisks.read();
  expect(second.outcome?.failure).toBe("absent");
  now = 20;
  const third = await udisks.read();
  expect(third.drives).toEqual([]);
  expect(third.outcome?.failure).toBe("absent");
  // The bus answers again on the very next sample, still inside the hold
  // that first failure started: the empty held reading must not keep being
  // served for the rest of it.
  failing = false;
  now = 30;
  const fourth = await udisks.read();
  expect(fourth).toEqual({
    outcome: null,
    drives: [
      {
        name: "sda",
        model: "B",
        written: 5_120,
        identity: "SN1",
        detected: null,
      },
    ],
  });
});
test("an initial listing failure, with no prior held reading at all, is not kept as an empty placeholder once the bus answers", async () => {
  const calls: string[][] = [];
  const good = fakeBus(
    [
      {
        name: "sda",
        model: "B",
        kind: "ata",
        attributes: ata(10, 3),
        serial: "SN1",
      },
    ],
    calls,
  );
  let failing = true;
  const run: typeof spawnText = async (argv, timeoutMs) => {
    if (failing && argv.includes("GetManagedObjects")) {
      calls.push(argv);
      return {
        out: "",
        error: "Failed to connect to bus: No such file or directory\n",
        status: 1,
        timedOut: false,
      };
    }
    return good(argv, timeoutMs);
  };
  let now = 0;
  const udisks = new Udisks(run, () => now);
  const first = await udisks.read();
  expect(first).toEqual({
    drives: [],
    outcome: {
      failure: "absent",
      detail: "Failed to connect to bus: No such file or directory",
    },
  });
  // The bus answers on the very next sample, still inside the hold that
  // failed first read started: the empty reading it held must not stand in
  // for "no drives" for the rest of it.
  failing = false;
  now = 10;
  const second = await udisks.read();
  expect(second).toEqual({
    outcome: null,
    drives: [
      {
        name: "sda",
        model: "B",
        written: 5_120,
        identity: "SN1",
        detected: null,
      },
    ],
  });
});
