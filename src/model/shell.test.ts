import { expect, test } from "bun:test";
import { shellLine, shellWord } from "./shell";

/**
 * The words /bin/sh makes of a line. The instrument is a shell, because the
 * claim is about what a shell does with copied text, not about which
 * characters this file thought to escape.
 */
async function words(line: string): Promise<string[]> {
  const child = Bun.spawn(
    ["sh", "-c", `for word in ${line}; do printf '%s\\0' "$word"; done`],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [out, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`sh exited ${status}: ${error.trim()}`);
  return out.split("\0").slice(0, -1);
}

test("a word a shell would rewrite comes back as itself", async () => {
  const rows: [string, string][] = [
    ["a.scope", "a scope name needing nothing"],
    ["--signal=TERM", "an option a shell reads as one word"],
    [
      "app-Hyprland-chromium\\x2dpersonal-af7ff2b7.scope",
      "the backslash escapes a real systemd scope name carries",
    ],
    ["/home/a b/cgroup.freeze", "a configured path holding a space"],
    ["it's-a.scope", "a single quote, which the quoting itself uses"],
    ["$(id -u).scope", "a command substitution"],
    ["a.scope;reboot", "a command separator"],
    ["", "an empty word, which unquoted disappears"],
  ];
  // The reason travels with the row so a failure names which case broke.
  for (const [word, reason] of rows)
    expect({ reason, read: await words(shellWord(word)) }).toEqual({
      reason,
      read: [word],
    });
});

test("a line carries every argv word across the shell unchanged", async () => {
  const argv = [
    "systemctl",
    "--user",
    "kill",
    "--signal=TERM",
    "app-Hyprland-chromium\\x2dpersonal-af7ff2b7.scope",
  ];
  expect(await words(shellLine(argv))).toEqual(argv);
  // A word needing no quotes keeps none, so the common line stays readable.
  expect(shellLine(["cat", "/sys/fs/cgroup/a.scope/io.stat"])).toBe(
    "cat /sys/fs/cgroup/a.scope/io.stat",
  );
});
