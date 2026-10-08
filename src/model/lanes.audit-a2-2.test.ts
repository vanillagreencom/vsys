import { expect, test } from "bun:test";
import { collectGroups } from "../collect/cgroups";
import { Reader } from "../collect/io";
import { defaults } from "../config/config";
import { processSnapshot } from "../test/fixture";
import { present } from "../test/present";
import { lanes } from "./lanes";

const parent = "/sys/fs/cgroup/user.slice/user-1000.slice";
const root = `${parent}/user@1000.service`;
/** A reader over a tree whose only limit sits on `parent`, above `root`. */
function reader(parentLimit: string | null) {
  const path = "agents.slice/a.scope";
  const readings = new Map<string, string>();
  for (const directory of [
    parent,
    root,
    `${root}/agents.slice`,
    `${root}/${path}`,
  ]) {
    readings.set(`${directory}/cpu.stat`, "usage_usec 1000");
    readings.set(
      `${directory}/cgroup.procs`,
      directory.endsWith("a.scope") ? "40" : "",
    );
    readings.set(`${directory}/memory.max`, "max");
  }
  if (parentLimit === null) readings.delete(`${parent}/memory.max`);
  else readings.set(`${parent}/memory.max`, parentLimit);
  const children = new Map<string, string[]>([
    [parent, ["user@1000.service"]],
    [root, ["agents.slice"]],
    [`${root}/agents.slice`, ["a.scope"]],
  ]);
  const r = new Reader();
  r.text = (file) => {
    if (file === `${parent}/memory.max` && parentLimit === null) {
      r.error(file, "EACCES");
      return null;
    }
    return readings.get(file) ?? null;
  };
  r.dirs = (directory) => children.get(directory) ?? [];
  return r;
}
const lane = (r: Reader) =>
  present(
    lanes(collectGroups(r, root, [], 0), [processSnapshot()], {
      ...defaults(),
      cgroupRoot: root,
    })[0],
    "lane below configured root",
  );

test("A2-2 a lane inherits memory.max above the configured root", () => {
  const capped = lane(reader("536870912"));
  expect(capped.memoryMax).toBe(536870912);
  expect(capped.memoryMaxKnown).toBe(true);
  // 512 MiB is under the default 1 GiB floor.
  expect(capped.dangerous).toBe(true);
  const unlimited = lane(reader("max"));
  expect(unlimited.memoryMax).toBeNull();
  expect(unlimited.memoryMaxKnown).toBe(true);
  expect(unlimited.dangerous).toBe(false);
});

test("A2-2 an unread limit above the configured root stays unknown", () => {
  const unread = lane(reader(null));
  expect(unread.memoryMax).toBeNull();
  expect(unread.memoryMaxKnown).toBe(false);
});
