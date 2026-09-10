import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "./config/config";
import { runEffect, switchToPane } from "./effect";
import { laneIntent, laneTarget, resolveIntent } from "./model/actions";
import { emptySnapshot, laneSnapshot } from "./test/fixture";

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
    // The whole path a confirmed action takes, from the lane a sample shows to
    // the byte in the kernel file, so a wrong freeze value anywhere along it is
    // a lane frozen when the reader asked for it to be thawed.
    const c = { ...defaults(), cgroupRoot: d.root };
    const lane = laneSnapshot({ id: "a.scope", cgroup: "a.scope" });
    const target = laneTarget(lane, c);
    if (target === null) throw new Error("the fixture lane runs in a scope");
    const s = { ...emptySnapshot(), lanes: [lane] };
    const attribute = join(d.root, "a.scope", "cgroup.freeze");
    mkdirSync(join(d.root, "a.scope"), { recursive: true });
    for (const [action, value] of [
      ["Freeze", "1"],
      ["Thaw", "0"],
    ] as const) {
      const resolved = resolveIntent(laneIntent(action, target), s, c);
      if (resolved.state !== "ready")
        throw new Error(`the fixture lane resolves ${action}`);
      await runEffect(resolved.command.effect);
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

test("the switch asks tmux for the target and reports what it refuses", async () => {
  const asked: string[][] = [];
  /** A child that answers the way a spawned tmux would. */
  const fake = (status: number, said: string) => (argv: string[]) => {
    asked.push(argv);
    return {
      exited: Promise.resolve(status),
      stderr: new Response(said).body,
    };
  };
  // The arguments are tmux's own, and the target reaches it as one of them
  // rather than as part of a line.
  await switchToPane("work:2.1", fake(0, ""));
  expect(asked).toEqual([["tmux", "switch-client", "-t", "work:2.1"]]);
  // A refusal reaches the reader in the server's words. Dropped, the reader
  // pressed a key, nothing moved and nothing said why.
  await expect(
    switchToPane("%9", fake(1, "can't find pane %9\n")),
  ).rejects.toThrow("can't find pane %9");
  // A refusal with nothing to say still says something.
  await expect(switchToPane("%9", fake(3, "   "))).rejects.toThrow(
    "tmux switch-client exited 3",
  );
  // Nothing to address is refused before anything is spawned.
  const before = asked.length;
  await expect(switchToPane("")).rejects.toThrow("exported no pane");
  expect(asked.length).toBe(before);
});
