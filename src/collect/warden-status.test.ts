import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { Reader } from "./io";
import { readLeftovers, staleAfterMs } from "./warden-status";

/** The warden's own fixture, so this reads the shape the warden writes. */
const written = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../warden/fixtures/status-leftovers.json"),
    "utf8",
  ),
);
const now = written.time * 1000;
const counts = { testWorlds: 3, failedUnits: 1, testProcesses: 3 };
const none = { testWorlds: null, failedUnits: null, testProcesses: null };

test.each([
  {
    name: "no status file is an absent warden, not a failed read",
    text: undefined,
    want: { state: "absent", time: null, ...none },
    errors: 0,
  },
  {
    name: "a fresh status gives its counts",
    text: JSON.stringify(written),
    want: { state: "read", time: now, ...counts },
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
    errors: 0,
  },
  {
    name: "a failed tick's null leftovers leave every count unknown",
    text: JSON.stringify({ ...written, leftovers: null }),
    want: { state: "read", time: now, ...none },
    errors: 0,
  },
  {
    name: "a status the warden stopped refreshing gives no counts",
    text: JSON.stringify({
      ...written,
      time: (now - staleAfterMs - 1000) / 1000,
    }),
    want: { state: "stale", time: now - staleAfterMs - 1000, ...none },
    errors: 0,
  },
  {
    name: "a status that does not parse is a failed read",
    text: "{",
    want: { state: "failed", time: null, ...none },
    errors: 1,
  },
  {
    name: "a schema major vsys does not know is a failed read",
    text: JSON.stringify({ ...written, schema: "2.0" }),
    want: { state: "failed", time: null, ...none },
    errors: 1,
  },
])("$name", ({ text, want, errors }) => {
  const f = fixture();
  try {
    const file = join(f.root, "run/agent-warden/status.json");
    if (text !== undefined) f.write(file, text);
    const r = new Reader();
    expect(readLeftovers(r, file, now)).toEqual(want);
    expect(r.errors.map((e) => e.source)).toEqual(
      Array.from({ length: errors }, () => file),
    );
  } finally {
    f.cleanup();
  }
});
