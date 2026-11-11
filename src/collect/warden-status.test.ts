import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WardenNearLimit } from "../model/types";
import { fixture, userManager } from "../test/fixture";
import { Reader } from "./io";
import { readWardenStatus, staleAfterMs } from "./warden-status";

/** The warden's own fixtures, so this reads the shape the warden writes. */
const wardenFixture = (name: string) =>
  JSON.parse(
    readFileSync(
      join(import.meta.dir, `../../warden/fixtures/${name}.json`),
      "utf8",
    ),
  );
const written = wardenFixture("status-leftovers");
const now = written.time * 1000;
const counts = { testWorlds: 3, failedUnits: 1, testProcesses: 3 };
const none = { testWorlds: null, failedUnits: null, testProcesses: null };
const noWarnings: WardenNearLimit[] = [];
/** The one warning the warden's near-limit fixture gives. */
const warned: WardenNearLimit[] = [
  {
    kernelPath: `${userManager}/agents.slice/agent-warden-100-200.scope`,
    near: ["tasks", "memory"],
  },
];

test.each([
  {
    name: "no status file is an absent warden, not a failed read",
    text: undefined,
    want: { state: "absent", time: null, ...none },
    nearLimits: null,
    errors: 0,
  },
  {
    name: "a fresh status gives its counts",
    text: JSON.stringify(written),
    want: { state: "read", time: now, ...counts },
    nearLimits: noWarnings,
    errors: 0,
  },
  {
    name: "a fresh status gives the warden's near-limit warnings and their limits",
    text: JSON.stringify({
      ...wardenFixture("status-near-limit"),
      time: written.time,
    }),
    want: {
      state: "read",
      time: now,
      testWorlds: 0,
      failedUnits: 0,
      testProcesses: 0,
    },
    nearLimits: warned,
    errors: 0,
  },
  {
    // AGENT_WARDEN_TEST_WORLDS unset: no pattern, so no world or process count.
    name: "a count the warden could not take stays unknown, never zero",
    text: JSON.stringify({
      ...written,
      leftovers: {
        ...written.leftovers,
        testWorlds: null,
        testProcesses: null,
        testProcessRepos: null,
      },
    }),
    want: {
      state: "read",
      time: now,
      testWorlds: null,
      failedUnits: 1,
      testProcesses: null,
    },
    nearLimits: noWarnings,
    errors: 0,
  },
  {
    name: "a failed tick's null leftovers leave every count unknown",
    text: JSON.stringify({ ...written, leftovers: null }),
    want: { state: "read", time: now, ...none },
    nearLimits: noWarnings,
    errors: 0,
  },
  {
    name: "a status the warden stopped refreshing gives no counts",
    text: JSON.stringify({
      ...written,
      time: (now - staleAfterMs - 1000) / 1000,
    }),
    want: { state: "stale", time: now - staleAfterMs - 1000, ...none },
    nearLimits: null,
    errors: 0,
  },
  {
    name: "a status that does not parse is a failed read",
    text: "{",
    want: { state: "failed", time: null, ...none },
    nearLimits: null,
    errors: 1,
  },
  {
    name: "a schema major vsys does not know is a failed read",
    text: JSON.stringify({ ...written, schema: "2.0" }),
    want: { state: "failed", time: null, ...none },
    nearLimits: null,
    errors: 1,
  },
])("$name", ({ text, want, nearLimits, errors }) => {
  const f = fixture();
  try {
    const file = join(f.root, "run/agent-warden/status.json");
    if (text !== undefined) f.write(file, text);
    const r = new Reader();
    expect(readWardenStatus(r, file, now)).toEqual({
      leftovers: want,
      nearLimits,
    });
    expect(r.errors.map((e) => e.source)).toEqual(
      Array.from({ length: errors }, () => file),
    );
  } finally {
    f.cleanup();
  }
});
