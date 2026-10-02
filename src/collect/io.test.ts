import { expect, test } from "bun:test";
import { spawnText } from "./io";

test("a child that exits before its deadline returns normally, with no leftover timer", async () => {
  const started = Date.now();
  const { out, error, status } = await spawnText(["echo", "hi"], 5000);
  expect({ out, error, status }).toEqual({ out: "hi\n", error: "", status: 0 });
  // Returned on the child's own exit, not stalled until the 5 second deadline.
  expect(Date.now() - started).toBeLessThan(2000);
});

test("a child that ignores SIGTERM is still killed, by escalating to SIGKILL", async () => {
  const started = Date.now();
  // `trap "" TERM` makes the child immune to the signal spawnText sends at
  // its deadline, the shape a wedged journalctl or tmux server could take.
  const { out, error, status } = await spawnText(
    ["bash", "-c", 'trap "" TERM; sleep 30'],
    50,
  );
  expect({ out, error }).toEqual({ out: "", error: "" });
  // SIGKILL, which a child cannot trap or ignore.
  expect(status).toBe(137);
  // Killed well short of the child's own 30 second sleep, and short of a
  // second deadline stacked on top of the kill grace period.
  expect(Date.now() - started).toBeLessThan(5000);
});
