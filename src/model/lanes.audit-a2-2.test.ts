import { expect, test } from "bun:test";
import { dirname } from "node:path";
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
  /** The cgroup v2 mount holding the root; undefined for an unread mount list. */
  mount: MountInfo | undefined;
}
const mount = (point: string, root: string): MountInfo => ({
  root,
  mount: point,
  device: "cgroup",
  type: "cgroup2",
  options: [],
});
const tree = (rest: Partial<Tree> = {}): Tree => ({
  parent: "/sys/fs/cgroup/user.slice/user-1000.slice",
  limit: "536870912",
  rootCounters: true,
  mount: mount("/sys/fs/cgroup", "/"),
  ...rest,
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
  // Every cgroup between the mount point and `parent` is unlimited.
  const point = t.mount?.mount;
  if (point)
    for (
      let dir = dirname(t.parent);
      dir.startsWith(`${point}/`);
      dir = dirname(dir)
    )
      readings.set(`${dir}/memory.max`, "max");
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

test("A2-2 only the top of a mounted hierarchy makes the limit above known", () => {
  // A subtree mount hides the cgroups above its mount point.
  const subtree = (mounted: MountInfo | undefined) =>
    lane(tree({ parent: "/tmp/my groups", limit: "max", mount: mounted }));
  const hidden = subtree(
    mount("/tmp/my groups", "/user.slice/user-1000.slice"),
  );
  expect([hidden.memoryMax, hidden.memoryMaxKnown]).toEqual([null, false]);
  // An unread mount list cannot say where the hierarchy ends.
  const unmapped = subtree(undefined);
  expect([unmapped.memoryMax, unmapped.memoryMaxKnown]).toEqual([null, false]);
  const whole = lane(tree({ mount: undefined }));
  expect([whole.memoryMax, whole.memoryMaxKnown]).toEqual([536870912, false]);
});
