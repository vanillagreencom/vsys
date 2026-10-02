import { basename } from "node:path";
import type { AgentToolsDocument, DesktopPaths } from "../config/agent-tools";

/** Runtimes an agent CLI's script runs under, where the script names it. */
const scriptRunners = ["bun", "node", "python", "python3", "bash", "sh"];
/**
 * Runtimes whose program can replace the process title: Node and Bun rewrite
 * the whole argument area and the kernel's name for the process.
 */
const titleRuntimes = ["bun", "node", "nodejs"];
/** Where one tool's installs put it. */
export interface ToolInstall {
  /** Fragments a path must contain: package and version manager directories. */
  fragments: string[];
  /** Whole paths, for a package that installs into a shared directory. */
  executables: string[];
}
/** The agent-tool data `toolName` judges a process by, built once per collector. */
export interface ToolSignals {
  installs: ReadonlyMap<string, ToolInstall>;
  desktop: DesktopPaths;
}
/**
 * Each tool's install locations: its own path fragments, the directory a
 * version manager installs each of its mise names under, and its whole
 * executable paths. mise and asdf both keep a tool in `installs/<name>/`
 * below their data directory, wherever a reader moved that directory.
 */
export function toolSignals(document: AgentToolsDocument): ToolSignals {
  return {
    installs: new Map(
      document.tools.map((tool) => [
        tool.name,
        {
          fragments: [
            ...tool.paths,
            ...tool.mise.map((dir) => `/installs/${dir}/`),
          ],
          executables: [...tool.executables],
        },
      ]),
    ),
    desktop: {
      desktopExePrefixes: [...document.desktopExePrefixes],
      bundledCliSuffixes: [...document.bundledCliSuffixes],
    },
  };
}
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
 * What a process is to the agent-tool data: an agent, a configured name its
 * install locations did not confirm, or neither.
 */
export type ToolMatch =
  | { kind: "agent"; name: string }
  | { kind: "unconfirmed"; name: string }
  | { kind: "none" };
// REVISIT(D010): a layout no fragment or executable path describes needs another signal.
/**
 * The one rule that makes a process an agent. A name alone never does: `pi`
 * or `dsh` can be anyone's program or script. A name a tool's executable or
 * script carries is that tool only where the path lies in one of its install
 * locations or is an engine a desktop app bundles, or where a script runtime
 * replaced its own title with the name, which erases the script path. A tool
 * with no install location is one a reader named without saying where it
 * lives, so its executable name alone is their claim; a script never matches
 * one. A path that could not be read keeps the name, because a failed read
 * never hides an escaped agent. A desktop app's own binary is never an
 * agent, whatever it is called. Never matched on prompt arguments:
 * `bash -c claude` is not claude.
 */
export function toolName(
  comm: string,
  command: string[],
  tools: string[],
  signals: ToolSignals,
  paths: ToolPaths,
): ToolMatch {
  const runner = basename(command[0] ?? "");
  const named = tools.find((tool) => tool === comm || tool === runner);
  const argument = command[1];
  const scriptName =
    scriptRunners.includes(runner) &&
    argument !== undefined &&
    !argument.startsWith("-")
      ? basename(argument).replace(/\.(js|mjs|cjs|py|sh)$/, "")
      : null;
  const scripted =
    scriptName !== null && tools.includes(scriptName) ? scriptName : null;
  const candidate = named ?? scripted;
  if (candidate === null) return { kind: "none" };
  const read = paths.executable();
  const executable = read === null ? null : liveExecutable(read);
  if (executable !== null && desktopApp(executable, signals.desktop))
    return { kind: "none" };
  const install = (name: string) => {
    const found = signals.installs.get(name);
    return found?.fragments.length || found?.executables.length ? found : null;
  };
  const installed = (location: ToolInstall, path: string) =>
    location.fragments.some((fragment) => path.includes(fragment)) ||
    location.executables.includes(path) ||
    bundledCli(path, signals.desktop);
  if (named !== undefined) {
    const location = install(named);
    if (
      location === null ||
      executable === null ||
      installed(location, executable) ||
      (titleRuntimes.includes(basename(executable)) &&
        command[0] === named &&
        command.slice(1).every((a) => a === ""))
    )
      return { kind: "agent", name: named };
  }
  if (scripted !== null && argument !== undefined) {
    const location = install(scripted);
    if (location !== null) {
      if (installed(location, argument))
        return { kind: "agent", name: scripted };
      const resolved = paths.script(argument);
      if (resolved === null || installed(location, resolved))
        return { kind: "agent", name: scripted };
    }
  }
  return { kind: "unconfirmed", name: candidate };
}
/** The kernel marks a binary replaced while it ran with ` (deleted)`. */
const liveExecutable = (path: string) => path.replace(/ \(deleted\)$/, "");
/** An agent engine a desktop app bundles beside its own binary. */
const bundledCli = (path: string, paths: DesktopPaths) =>
  paths.bundledCliSuffixes.some((suffix) => path.endsWith(suffix));
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
 * The path is the live one, without the kernel's ` (deleted)` mark.
 */
function desktopApp(executable: string, paths: DesktopPaths): boolean {
  return (
    paths.desktopExePrefixes.some((prefix) => executable.startsWith(prefix)) &&
    !bundledCli(executable, paths)
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
