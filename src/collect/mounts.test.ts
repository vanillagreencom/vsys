import { expect, test } from "bun:test";
import { kernelCgroupRoot, parseMounts } from "./mounts";

test("mount roots translate namespace and bind-mounted cgroup paths", () => {
  const mounts = parseMounts(
    "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n2 1 0:1 /user.slice/user-1000.slice /tmp/my\\040groups rw - cgroup2 cgroup rw",
  );
  expect(kernelCgroupRoot("/sys/fs/cgroup/user.slice", mounts)).toBe(
    "/user.slice",
  );
  expect(kernelCgroupRoot("/tmp/my groups/agents.slice", mounts)).toBe(
    "/user.slice/user-1000.slice/agents.slice",
  );
  expect(kernelCgroupRoot("/tmp/my groups-other", mounts)).toBeUndefined();
  expect(() => parseMounts("not mountinfo")).toThrow();
});
