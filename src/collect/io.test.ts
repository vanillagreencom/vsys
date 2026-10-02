import { expect, test } from "bun:test";
import { spawnText } from "./io";

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
