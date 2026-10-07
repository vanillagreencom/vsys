import { expect, test } from "bun:test";
import { chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { Reader, spawnText } from "./io";

test("a scrub read binds exact text to its file version and records unavailable versions", () => {
  const f = fixture();
  const path = join(f.config.scrubDir, "root.result");
  const reader = new Reader();
  try {
    f.write(path, "Status: finished\n  file with end space ");
    const before = reader.scrubReport(path);
    expect(before.kind).toBe("read");
    if (before.kind !== "read") throw new Error("Readable report required");
    expect(before.text).toBe("Status: finished\n  file with end space ");
    expect(reader.scrubReport(path)).toEqual(before);
    const hidden = join(f.config.scrubDir, ".next");
    f.write(hidden, "Status: finished\n  file with end space ");
    renameSync(hidden, path);
    const replaced = reader.scrubReport(path);
    expect(replaced.kind).toBe("read");
    expect(replaced.version).not.toBe(before.version);
    chmodSync(path, 0o000);
    const failed = reader.scrubReport(path);
    expect(failed.kind).toBe("unread");
    expect(failed.version).not.toBeNull();
    expect(reader.errors.map((error) => error.source)).toContain(path);
    expect(reader.scrubReport(join(f.root, "absent"))).toEqual({
      kind: "unread",
      version: null,
    });
  } finally {
    chmodSync(path, 0o600);
    f.cleanup();
  }
});

test("a child that exits before its deadline returns normally, with no leftover timer", async () => {
  const started = Date.now();
  const { out, error, status, timedOut } = await spawnText(
    ["echo", "hi"],
    5000,
  );
  expect({ out, error, status, timedOut }).toEqual({
    out: "hi\n",
    error: "",
    status: 0,
    timedOut: false,
  });
  // Returned on the child's own exit, not stalled until the 5 second deadline.
  expect(Date.now() - started).toBeLessThan(2000);
});

test("a child that ignores SIGTERM is still killed, by escalating to SIGKILL", async () => {
  const started = Date.now();
  // `trap "" TERM` makes the child immune to the signal spawnText sends at
  // its deadline, the shape a wedged journalctl or tmux server could take.
  const { out, error, status, timedOut } = await spawnText(
    ["bash", "-c", 'trap "" TERM; sleep 30'],
    50,
  );
  expect({ out, error }).toEqual({ out: "", error: "" });
  // SIGKILL, which a child cannot trap or ignore.
  expect(status).toBe(137);
  expect(timedOut).toBe(true);
  // Killed well short of the child's own 30 second sleep, and short of a
  // second deadline stacked on top of the kill grace period.
  expect(Date.now() - started).toBeLessThan(5000);
});

test("a real child killed on its deadline is told apart from one some other signal happened to end the same way", async () => {
  // Nothing requests a deadline here, so spawnText never starts its own
  // kill timer: the same status a deadline kill can leave (143, SIGTERM)
  // must not be read as timedOut on its own.
  const { status, timedOut } = await spawnText(["bash", "-c", "kill -TERM $$"]);
  expect(status).toBe(143);
  expect(timedOut).toBe(false);
});
