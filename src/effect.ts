import { writeFile } from "node:fs/promises";
import { switchClientArgv } from "./collect/tmux";
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

/** What a spawned child says for itself, so a test can stand in for one. */
export interface Spawned {
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array> | null;
}
const spawnChild = (argv: string[]): Spawned =>
  Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
/**
 * Moves the reader's own tmux view to a pane. This changes no process and no
 * cgroup: it is the reader looking somewhere else, which is why it does not
 * pass through `runEffect` or wait on write mode. Any non-empty target reaches
 * tmux as a single argument of a spawned array, never through a shell, and
 * tmux decides whether it names anything: `-t` takes a session and window as
 * readily as a pane id, and refusing the first was vsys's restriction rather
 * than tmux's.
 */
export async function switchToPane(
  target: string,
  spawn: (argv: string[]) => Spawned = spawnChild,
): Promise<void> {
  if (!target) throw new Error("This agent exported no pane to switch to");
  const child = spawn(switchClientArgv(target));
  const status = await child.exited;
  if (status !== 0)
    throw new Error(
      (child.stderr ? await new Response(child.stderr).text() : "").trim() ||
        `tmux switch-client exited ${status}`,
    );
}
