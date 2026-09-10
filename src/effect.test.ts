import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEffect } from "./effect";
import { laneCommand } from "./model/actions";

/** A directory standing in for the lane's own cgroup. */
function scopeDir() {
  const root = mkdtempSync(join(tmpdir(), "vsys-effect-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a freeze and a thaw write their own value to the lane's cgroup", async () => {
  const d = scopeDir();
  try {
    const target = {
      laneId: "agents.slice/a.scope",
      mainPid: 40,
      scope: "a.scope",
      directory: d.root,
    };
    const attribute = join(d.root, "cgroup.freeze");
    // The command the confirmation showed is the one that runs, so a wrong
    // value here is a lane frozen when the reader asked for it to be thawed.
    for (const [action, value] of [
      ["Freeze", "1"],
      ["Thaw", "0"],
    ] as const) {
      await runEffect(laneCommand(action, target).effect);
      expect({ action, wrote: readFileSync(attribute, "utf8") }).toEqual({
        action,
        wrote: value,
      });
    }
  } finally {
    d.cleanup();
  }
});

test("a stop hands its argv to the program as separate words", async () => {
  const d = scopeDir();
  try {
    const out = join(d.root, "argv");
    // A scope name carrying a space and a substitution proves the words reach
    // the program as a list. Through a shell, this one would run `echo`.
    const scope = "app-Hyprland a;$(echo other).scope";
    await runEffect({
      kind: "run",
      argv: ["sh", "-c", 'printf %s "$1" > "$2"', "sh", scope, out],
    });
    expect(readFileSync(out, "utf8")).toBe(scope);
  } finally {
    d.cleanup();
  }
});

test("a program that fails reports its own stderr rather than passing as done", async () => {
  const reason = "Failed to kill unit a.scope: Unit a.scope not loaded.";
  const run = runEffect({
    kind: "run",
    argv: ["sh", "-c", `printf '%s\\n' ${JSON.stringify(reason)} >&2; exit 5`],
  });
  await expect(run).rejects.toThrow(`sh exited 5: ${reason}`);
});
