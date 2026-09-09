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
/** target test artifacts are distinguishable from target build scripts. */
export function buildKind(comm: string, command: string[]): string | null {
  const name = basename(command[0] ?? comm);
  if (
    [
      "rustc",
      "cargo",
      "cc",
      "gcc",
      "g++",
      "clang",
      "clang++",
      "ld",
      "lld",
      "ld.lld",
      "mold",
      "tsc",
    ].includes(name)
  )
    return name;
  if (
    /\/target\/(?:[^/]+\/)?(?:debug|release)\/deps\/[^/]+-[a-f0-9]+$/.test(
      command[0] ?? "",
    )
  )
    return "test";
  if (
    ["node", "bun"].includes(name) &&
    command
      .slice(1)
      .some(
        (a) =>
          /(^|\/)(tsc|webpack|vite|rollup|esbuild|next)(\.[cm]?js)?$/.test(a) ||
          a === "build",
      )
  )
    return name;
  return null;
}
