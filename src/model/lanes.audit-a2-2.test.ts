import { expect, test } from "bun:test";
import { collectGroups } from "../collect/cgroups";
import { Reader } from "../collect/io";
import type { MountInfo } from "../collect/mounts";
import { defaults } from "../config/config";
import { processSnapshot } from "../test/fixture";
import { present } from "../test/present";
import { lanes } from "./lanes";

interface Tree {
  /** The cgroup above the configured root, and the only one with a limit. */
  parent: string;
  /** memory.max on `parent`; null fails its read. */
  limit: string | null;
  /** Whether the configured root's own counters read. */
  rootCounters: boolean;
  mount?: MountInfo;
}
const tree = (rest: Partial<Tree> = {}): Tree => ({
  parent: "/sys/fs/cgroup/user.slice/user-1000.slice",
  limit: "536870912",
  rootCounters: true,
  ...rest,
});
const mount = (point: string, root: string): MountInfo => ({
  root,
  mount: point,
  device: "cgroup",
  type: "cgroup2",
  options: [],
});
/** The one lane of a tree whose configured root sits below `parent`. */
function lane(t: Tree) {
  const root = `${t.parent}/user@1000.service`;
  const scope = `${root}/agents.slice/a.scope`;
  const readings = new Map<string, string>();
  for (const directory of [t.parent, root, `${root}/agents.slice`, scope]) {
    readings.set(`${directory}/cpu.stat`, "usage_usec 1000");
    readings.set(`${directory}/cgroup.procs`, directory === scope ? "40" : "");
    readings.set(`${directory}/memory.max`, "max");
  }
  if (t.limit === null) readings.delete(`${t.parent}/memory.max`);
  else readings.set(`${t.parent}/memory.max`, t.limit);
  if (!t.rootCounters) readings.delete(`${root}/cpu.stat`);
  const children = new Map<string, string[]>([
    [t.parent, ["user@1000.service"]],
    [root, ["agents.slice"]],
    [`${root}/agents.slice`, ["a.scope"]],
  ]);
  const r = new Reader();
  r.text = (file) => {
    const text = readings.get(file);
    if (text !== undefined) return text;
    // A file of the tree that fails to read; anything else is absent.
    if (file.startsWith(t.parent)) r.error(file, "EACCES");
    return null;
  };
  r.dirs = (directory) => children.get(directory) ?? [];
  const mounted = t.mount && { path: root, mount: t.mount };
  const groups = collectGroups(r, root, [], 0, mounted);
  const config = { ...defaults(), cgroupRoot: root };
  return present(
    lanes(groups, [processSnapshot()], config)[0],
    "lane below configured root",
  );
}

test("A2-2 a lane inherits memory.max above the configured root", () => {
  const capped = lane(tree());
  expect(capped.memoryMax).toBe(536870912);
  expect(capped.memoryMaxKnown).toBe(true);
  // 512 MiB is under the default 1 GiB floor.
  expect(capped.dangerous).toBe(true);
  const unlimited = lane(tree({ limit: "max" }));
  expect(unlimited.memoryMax).toBeNull();
  expect(unlimited.memoryMaxKnown).toBe(true);
  expect(unlimited.dangerous).toBe(false);
});

test("A2-2 an unread limit above the configured root stays unknown", () => {
  const unread = lane(tree({ limit: null }));
  expect(unread.memoryMax).toBeNull();
  expect(unread.memoryMaxKnown).toBe(false);
});

test("A2-2 an unread configured root still carries the limit above it", () => {
  const below = lane(tree({ rootCounters: false }));
  expect(below.memoryMax).toBe(536870912);
  expect(below.memoryMaxKnown).toBe(false);
  expect(below.dangerous).toBe(true);
});

test("A2-2 the walk above the root stops at the cgroup mount", () => {
  // A mount of the whole hierarchy ends at the cgroup root.
  const whole = lane(tree({ mount: mount("/sys/fs/cgroup", "/") }));
  expect([whole.memoryMax, whole.memoryMaxKnown]).toEqual([536870912, true]);
  // A subtree mount hides the cgroups above its mount point.
  const subtree = lane(
    tree({
      parent: "/tmp/my groups",
      limit: "max",
      mount: mount("/tmp/my groups", "/user.slice/user-1000.slice"),
    }),
  );
  expect([subtree.memoryMax, subtree.memoryMaxKnown]).toEqual([null, false]);
});
