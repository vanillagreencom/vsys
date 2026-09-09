import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { capabilitySnapshot } from "../test/fixture";
import { capabilityLine, capabilityReason, settingLabel } from "./settings";

test("every stored setting shows under a name a reader can act on", () => {
  const unlabelled = Object.keys(defaults()).filter(
    (key) => key !== "keys" && settingLabel(key) === key,
  );
  expect(unlabelled).toEqual([]);
  expect(settingLabel("keys.quit")).toBe("Key: quit");
});

test("Settings states each capability and why a missing one is missing", () => {
  const caps = capabilitySnapshot();
  expect(caps.map(capabilityLine)).toEqual([
    "Resource groups (cgroup v2): available",
    "Resource control for this login session: available",
    "Pressure stall information: available",
    "Per-group disk counters: available",
    "Disk scrub reports: available",
  ]);
  expect(
    capabilityLine({
      id: "psi",
      available: false,
      failure: "absent",
      source: "/proc/pressure/cpu",
      detail: "ENOENT: no such file or directory",
    }),
  ).toBe(
    "Pressure stall information: not available: no PSI on this kernel (/proc/pressure/cpu: ENOENT: no such file or directory)",
  );
});

test("the reason follows what the probe found, not the interface name", () => {
  const psi = {
    id: "psi" as const,
    available: false,
    source: "/proc/pressure/cpu",
    detail: "Missing pressure fields",
  };
  // A file that exists must never be reported as a kernel that lacks it.
  expect(capabilityReason({ ...psi, failure: "malformed" })).toBe(
    "/proc/pressure/cpu is not in the expected format",
  );
  expect(
    capabilityReason({
      ...psi,
      failure: "unreadable",
      detail: "EACCES: permission denied",
    }),
  ).toBe("/proc/pressure/cpu exists but cannot be read");
  expect(capabilityReason({ ...psi, failure: "absent" })).toBe(
    "no PSI on this kernel",
  );
  expect(
    capabilityReason({
      id: "delegation",
      available: false,
      failure: "incomplete",
      source: "/sys/fs/cgroup/cgroup.subtree_control",
      detail: "cpu memory",
    }),
  ).toBe("this login session is not given cpu memory");
});
