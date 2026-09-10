import { writeFile } from "node:fs/promises";
import type { LaneEffect } from "./model/actions";

/**
 * Performs one confirmed lane effect: the only place vsys changes the system.
 * A cgroup attribute is a file the kernel reads on write, so the value goes
 * there directly. A scope is signalled through systemd, which reports a unit
 * it cannot find or may not touch by exiting non-zero with its reason on
 * stderr; that reason becomes the error, because a signal that never reached
 * the scope must not read on screen as a completed stop.
 */
export async function runEffect(effect: LaneEffect): Promise<void> {
  if (effect.kind === "cgroup") {
    await writeFile(effect.path, effect.value);
    return;
  }
  const child = Bun.spawn(effect.argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const status = await child.exited;
  if (status !== 0)
    throw new Error(
      `${effect.argv[0]} exited ${status}: ${(await new Response(child.stderr).text()).trim()}`,
    );
}
