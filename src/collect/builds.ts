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
  /**
   * `path` is the one path tested against the name's install locations: the
   * executable for a name match, the script for a scripted match. A card
   * naming where to add a paths fragment or an executables entry names this
   * path, never the other kind's, because only this one was checked.
   * `matchedBy` says which of the two it was: a name match means `path` is
   * one whole executable path, where an `executables` entry is the right,
   * narrower mechanism; a paths fragment stays right for a scripted match,
   * where the script can move inside a tool's own directory tree. Null only
   * for a scripted match against a tool with no install location, where a
   * failed read of the script path never hides an unconfirmed name either.
   */
  | {
      kind: "unconfirmed";
      name: string;
      path: string | null;
      matchedBy: "name" | "script";
    }
  | { kind: "none" };
// REVISIT(D010): a layout no fragment or executable path describes needs another signal.
/**
 * The one rule that makes a process an agent. A name alone never does: `pi`
 * or `dsh` can be anyone's program or script. A name a tool's executable or
 * script carries is that tool where the path lies in one of its install
 * locations or is an engine a desktop app bundles, wherever that is, even
 * under a desktop prefix. Short of that, a desktop app's own binary is never
 * an agent, whatever it is called. Otherwise the name stands where a script
 * runtime replaced its own title with it, which erases the script path; where
 * the tool has no install location, because a reader named it without saying
 * where it lives, though a script never matches such a tool; and where a path
 * could not be read, because a failed read never hides an escaped agent.
 * Never matched on prompt arguments: `bash -c claude` is not claude.
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
  const argument = scriptRunners.includes(runner) ? command[1] : undefined;
  const scriptName =
    argument === undefined
      ? null
      : basename(argument).replace(/\.(js|mjs|cjs|py|sh)$/, "");
  const scripted =
    scriptName !== null && tools.includes(scriptName) ? scriptName : null;
  const candidate = named ?? scripted;
  if (candidate === null) return { kind: "none" };
  const install = (name: string) => {
    const found = signals.installs.get(name);
    return found?.fragments.length || found?.executables.length ? found : null;
  };
  const installed = (location: ToolInstall, path: string) =>
    location.fragments.some((fragment) => path.includes(fragment)) ||
    location.executables.includes(path) ||
    bundledCli(path, signals.desktop);
  const read = paths.executable();
  const executable = read === null ? null : liveExecutable(read);
  const namedAt = named === undefined ? null : install(named);
  if (
    named !== undefined &&
    namedAt !== null &&
    executable !== null &&
    installed(namedAt, executable)
  )
    return { kind: "agent", name: named };
  const scriptAt = scripted === null ? null : install(scripted);
  const script =
    scriptAt === null || argument === undefined ? null : paths.script(argument);
  if (
    scripted !== null &&
    scriptAt !== null &&
    script !== null &&
    installed(scriptAt, script)
  )
    return { kind: "agent", name: scripted };
  if (executable !== null && desktopApp(executable, signals.desktop))
    return { kind: "none" };
  if (
    named !== undefined &&
    (namedAt === null ||
      executable === null ||
      (titleRuntimes.includes(basename(executable)) &&
        command[0] === named &&
        command.slice(1).every((a) => a === "")))
  )
    return { kind: "agent", name: named };
  if (scripted !== null && scriptAt !== null && script === null)
    return { kind: "agent", name: scripted };
  // A named match that reaches here always read a non-null executable. A
  // scripted match against a tool with an install location that reaches here
  // always resolved a non-null script too, caught above otherwise; only a
  // tool with none at all leaves `script` null without ever reading it, so
  // that read happens here instead, lazily, for the rare process it affects.
  // A failed read never hides the unconfirmed name, so it is reported as
  // null rather than thrown: a process this tool does not understand is not
  // one the collector should drop.
  const path =
    candidate === named
      ? executable
      : (script ?? (argument === undefined ? null : paths.script(argument)));
  return {
    kind: "unconfirmed",
    name: candidate,
    path,
    matchedBy: candidate === named ? "name" : "script",
  };
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
