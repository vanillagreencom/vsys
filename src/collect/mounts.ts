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
      const [, , , root, mount, mountOptions] = left.split(" ");
      const [type, device, superOptions] = right.split(" ");
      if (
        root === undefined ||
        mount === undefined ||
        mountOptions === undefined ||
        type === undefined ||
        device === undefined ||
        superOptions === undefined
      )
        throw new Error("Incomplete mountinfo line");
      return {
        root: unescapePath(root),
        mount: unescapePath(mount),
        device: unescapePath(device),
        type,
        options: [
          ...new Set([...mountOptions.split(","), ...superOptions.split(",")]),
        ],
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
