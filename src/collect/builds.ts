import { basename } from "node:path";
import type { DesktopPaths } from "../config/agent-tools";

/** Match executable or script names, never arbitrary prompt arguments. */
export function toolName(
  comm: string,
  command: string[],
  tools: string[],
): string | null {
  const candidates = [comm, basename(command[0] ?? "")];
  if (
    ["bun", "node", "python", "python3", "bash", "sh"].includes(candidates[1])
  )
    candidates.push(
      basename(command[1] ?? "").replace(/\.(js|mjs|cjs|py|sh)$/, ""),
    );
  return tools.find((t) => candidates.includes(t)) ?? null;
}
/**
 * Tool processes that are not lanes are recognised by their executable name or
 * by a whole flag. Never by prompt text: `claude -p "fix the language server"`
 * must stay an agent. A pattern ending in `=` names an option and matches it
 * whatever its value, so `--type=` rules out every Chromium helper process.
 */
export function excludedArgv(command: string[], patterns: string[]): boolean {
  const exe = command[0] ?? "";
  const names = [exe, basename(exe)];
  const flags = command.filter((a) => a.startsWith("-"));
  return patterns.some(
    (p) =>
      p !== "" &&
      (names.includes(p) ||
        flags.some((f) => (p.endsWith("=") ? f.startsWith(p) : f === p))),
  );
}
/**
 * A desktop app's own binary, known by where it is installed and never by its
 * name: Claude Desktop's Electron binary is called `claude`. An agent engine
 * the app bundles under the same prefix stays an agent, known by its suffix.
 * The kernel marks a binary a package update replaced while it ran with a
 * trailing ` (deleted)`, which is not part of its path.
 */
export function desktopApp(executable: string, paths: DesktopPaths): boolean {
  const path = executable.replace(/ \(deleted\)$/, "");
  return (
    paths.desktopExePrefixes.some((prefix) => path.startsWith(prefix)) &&
    !paths.bundledCliSuffixes.some((suffix) => path.endsWith(suffix))
  );
}
/**
 * One predicate for every slot total: the fleet, the meter and the lane rows.
 * The configured compilers occupy a slot. cargo, a running test binary and a
 * script runner supervise or execute work rather than compiling it, so they
 * are classified builds without being slots.
 */
export const compileOrLink = (
  build: string | null,
  compilers: string[],
  linkers: string[],
) => build !== null && (compilers.includes(build) || linkers.includes(build));
/** target test artifacts are distinguishable from target build scripts. */
export function buildKind(
  comm: string,
  command: string[],
  compilers: string[],
  linkers: string[],
): string | null {
  const name = basename(command[0] ?? comm);
  // One configured list of each name serves the classifier and the meters.
  if (linkers.includes(name)) return name;
  if (compilers.includes(name) || name === "cargo") return name;
  if (
    /\/target\/(?:[^/]+\/)?(?:debug|release)\/deps\/[^/]+-[a-f0-9]+$/.test(
      command[0] ?? "",
    )
  )
    return "test";
  if (["node", "bun"].includes(name)) {
    const scripts = [command[1], command[1] === "run" ? command[2] : undefined];
    if (
      scripts.some(
        (a) =>
          a !== undefined &&
          (/(^|\/)(tsc|webpack|vite|rollup|esbuild|next)(\.[cm]?js)?$/.test(
            a,
          ) ||
            a === "build"),
      )
    )
      return name;
  }
  return null;
}
