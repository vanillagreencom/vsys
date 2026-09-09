import { basename } from "node:path";

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
 * must stay an agent.
 */
export function excludedArgv(command: string[], patterns: string[]): boolean {
  const exe = command[0] ?? "";
  const names = [exe, basename(exe)];
  const flags = command.filter((a) => a.startsWith("-"));
  return patterns.some(
    (p) => p !== "" && (names.includes(p) || flags.includes(p)),
  );
}
/**
 * The compilers that occupy a build slot. cargo, a running test binary and a
 * script runner supervise or execute work rather than compiling it, so they
 * are classified builds without being slots.
 */
const compilers = ["rustc", "cc", "gcc", "g++", "clang", "clang++", "tsc"];
/** One predicate for every slot total: the fleet, the meter and the lane rows. */
export const compileOrLink = (build: string | null, linkers: string[]) =>
  build !== null && (compilers.includes(build) || linkers.includes(build));
/** target test artifacts are distinguishable from target build scripts. */
export function buildKind(
  comm: string,
  command: string[],
  linkers: string[],
): string | null {
  const name = basename(command[0] ?? comm);
  // One configured list of linker names serves the classifier and the meters.
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
