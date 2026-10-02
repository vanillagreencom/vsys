import { basename } from "node:path";
import type { DesktopPaths } from "../config/agent-tools";

/** Runtimes an agent CLI's script runs under, where the script names it. */
const scriptRunners = ["bun", "node", "python", "python3", "bash", "sh"];
/**
 * What `toolName` reads to confirm a name, read only once a name matched.
 * `null` is a path that could not be read.
 */
export interface ToolPaths {
  /** The process's executable. */
  executable(): string | null;
  /** A script argument with symbolic links resolved, as given if absent. */
  script(argument: string): string | null;
}
/**
 * A name alone never makes an agent: `pi` or `dsh` can be anyone's program
 * or script. A name a tool's executable or script carries is that tool only
 * where the path lies in one of its install locations, or in an engine a
 * desktop app bundles. A tool with no install location is one a reader named
 * without saying where it lives, so its executable name alone is their
 * claim; a script never matches one. A path that could not be read keeps the
 * name, because a failed read never hides an escaped agent. Never matched on
 * prompt arguments: `bash -c claude` is not claude.
 */
export function toolName(
  comm: string,
  command: string[],
  tools: string[],
  installs: ReadonlyMap<string, string[]>,
  bundled: string[],
  paths: ToolPaths,
): string | null {
  const installed = (name: string, path: string) =>
    (installs.get(name) ?? [])
      .concat(bundled)
      .some((location) => path.includes(location));
  const runner = basename(command[0] ?? "");
  const named = tools.find((tool) => tool === comm || tool === runner);
  if (named !== undefined) {
    if (!installs.get(named)?.length) return named;
    const executable = paths.executable();
    if (executable === null || installed(named, liveExecutable(executable)))
      return named;
  }
  const script = command[1];
  if (
    !scriptRunners.includes(runner) ||
    script === undefined ||
    script.startsWith("-")
  )
    return null;
  const name = basename(script).replace(/\.(js|mjs|cjs|py|sh)$/, "");
  if (!tools.includes(name) || !installs.get(name)?.length) return null;
  if (installed(name, script)) return name;
  const resolved = paths.script(script);
  return resolved === null || installed(name, resolved) ? name : null;
}
/** The kernel marks a binary replaced while it ran with ` (deleted)`. */
const liveExecutable = (path: string) => path.replace(/ \(deleted\)$/, "");
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
  const path = liveExecutable(executable);
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
