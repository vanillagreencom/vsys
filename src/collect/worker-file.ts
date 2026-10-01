import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A worker thread's own module, by name: the source file beside this one, or
 * the built one. Bun's bundler does not follow a worker URL, so
 * `scripts/build.ts` names every worker as an entry point beside the
 * program. Both shipped forms keep the layout under `src/`, and once bundled
 * `import.meta.url` names the program itself at that root, so there a worker
 * sits under `./collect/`. None present is a broken build, and it says so
 * rather than leaving a reading quietly untaken.
 */
export function workerFile(name: string): URL {
  const candidates = [`./${name}.ts`, `./collect/${name}.js`].map(
    (file) => new URL(file, import.meta.url),
  );
  const found = candidates.find((url) => existsSync(fileURLToPath(url)));
  if (found === undefined)
    throw new Error(`No ${name} beside ${fileURLToPath(import.meta.url)}`);
  return found;
}
