import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { capabilitySnapshot } from "../test/fixture";
import { capabilityLine, settingLabel } from "./settings";

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
      source: "/proc/pressure/cpu",
      detail: "ENOENT: no such file or directory",
    }),
  ).toBe(
    "Pressure stall information: not available: no PSI on this kernel (/proc/pressure/cpu: ENOENT: no such file or directory)",
  );
});
