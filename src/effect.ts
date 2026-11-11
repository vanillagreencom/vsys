import { type ChildProcess, spawn as spawnProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { attachArgv, switchClientArgv } from "./collect/tmux";
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
/** A tmux view switch changes no process or cgroup, so it bypasses write mode and runEffect. Pass any non-empty target as one argv element and let tmux decide whether it exists; session and window targets are valid too. */
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

export type TerminalOpen = (target: string, server: string) => Promise<void>;
type TerminalSpawn = (
  command: string,
  args: string[],
  options: { detached: true; stdio: "ignore"; env: NodeJS.ProcessEnv },
) => Pick<ChildProcess, "once" | "unref">;

/**
 * Opens a terminal on a pane through xdg-terminal-exec, or is undefined when
 * it is not on PATH. A separate session and ignored stdio let the terminal
 * outlive vsys.
 */
export function terminalOpener(
  env: NodeJS.ProcessEnv = process.env,
  which: (command: string) => string | null = Bun.which,
  spawn: TerminalSpawn = spawnProcess,
): TerminalOpen | undefined {
  const terminal = which("xdg-terminal-exec");
  if (!terminal) return undefined;
  // Inherit the desktop and PATH, but not a pane identity: a terminal opened
  // from another server must not look like a nested tmux client.
  const inherited = { ...env };
  delete inherited.TMUX;
  delete inherited.TMUX_PANE;
  return (target, server) =>
    new Promise((resolve, reject) => {
      const child = spawn(terminal, attachArgv(target, server), {
        detached: true,
        stdio: "ignore",
        env: inherited,
      });
      child.once("error", reject);
      // https://nodejs.org/api/child_process.html#event-spawn confirms
      // executable launch, not a window or tmux attachment. Later exit belongs
      // to the terminal's independent lifetime, not this operation.
      child.once("spawn", () => resolve());
      child.unref();
    });
}
