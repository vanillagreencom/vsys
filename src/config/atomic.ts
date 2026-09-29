import {
  lstat,
  mkdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

/** Atomic replacement prevents a partial config when a write is interrupted. */
export async function writeFileAtomic(
  path: string,
  body: string,
  mode = 0o600,
): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing?.isSymbolicLink()) path = await realpath(path);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, body, { mode, flag: "wx" });
  try {
    await rename(temp, path);
  } catch (error) {
    try {
      await unlink(temp);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "File replacement and temporary file cleanup failed",
      );
    }
    throw error;
  }
}
