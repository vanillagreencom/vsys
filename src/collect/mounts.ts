import { join, relative, resolve } from "node:path";
import type { Reader } from "./io";

export interface MountInfo {
  root: string;
  mount: string;
  device: string;
  type: string;
  options: string[];
}
const unescapePath = (s: string) =>
  s.replace(/\\([0-7]{3})/g, (_, n: string) =>
    String.fromCharCode(Number.parseInt(n, 8)),
  );

/** One parser owns mount roots, escaped paths and both option lists. */
export function parseMounts(raw: string): MountInfo[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [left, right] = line.split(" - ");
      if (!left || !right) throw new Error("Invalid mountinfo line");
      const fields = left.split(" ");
      const fs = right.split(" ");
      if (fields.length < 6 || fs.length < 3)
        throw new Error("Incomplete mountinfo line");
      return {
        root: unescapePath(fields[3]),
        mount: unescapePath(fields[4]),
        device: unescapePath(fs[1]),
        type: fs[0],
        options: [...new Set([...fields[5].split(","), ...fs[2].split(",")])],
      };
    });
}
export function readMounts(r: Reader, procRoot: string): MountInfo[] | null {
  const path = join(procRoot, "self/mountinfo");
  const raw = r.text(path);
  if (raw === null) return null;
  try {
    return parseMounts(raw);
  } catch (error) {
    r.error(path, error);
    return null;
  }
}
/** Translate a filesystem path through the most specific cgroup v2 mount. */
export function kernelCgroupRoot(
  root: string,
  mounts: MountInfo[],
): string | undefined {
  const path = resolve(root);
  const mount = mounts
    .filter(
      (m) =>
        m.type === "cgroup2" &&
        (path === m.mount || path.startsWith(`${m.mount}/`)),
    )
    .sort((a, b) => b.mount.length - a.mount.length)[0];
  return mount ? join(mount.root, relative(mount.mount, path)) : undefined;
}
