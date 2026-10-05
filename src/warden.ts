import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type InstallFileProbe = (path: string) => boolean;

/** The refusals a caller or a test tells apart; the message is for the reader. */
export type WardenRefusal = { kind: "installer-not-found"; tried: string[] };

export class WardenError extends Error {
  constructor(
    readonly refusal: WardenRefusal,
    message: string,
  ) {
    super(message);
  }
}

export function defaultWardenCandidates(
  sourceDir = import.meta.dir,
  execPath = process.execPath,
): string[] {
  const checkout = resolve(sourceDir, "../warden");
  const execDir = dirname(realpathSync(execPath));
  const installed = resolve(execDir, "../lib/vsys/warden");
  const archive = resolve(execDir, "lib/vsys/warden");
  return [checkout, installed, archive];
}

export function resolveWardenDir(
  candidates = defaultWardenCandidates(),
  isInstallFile: InstallFileProbe = (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
): string {
  for (const candidate of candidates) {
    if (isInstallFile(join(candidate, "install"))) return candidate;
  }
  throw new WardenError(
    { kind: "installer-not-found", tried: candidates },
    `vsys warden installer not found; tried ${candidates.join(", ")}`,
  );
}

export async function dispatchWarden(
  args: string[],
  dir = resolveWardenDir(),
): Promise<never> {
  const child = Bun.spawn([join(dir, "install"), ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  process.exit(code);
}
