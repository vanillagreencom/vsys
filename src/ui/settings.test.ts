import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { capabilitySnapshot } from "../test/fixture";
import {
  capabilityLine,
  capabilityReason,
  settingDisplay,
  settingHelp,
  settingInfo,
  settingLabel,
} from "./settings";

test("every stored setting shows under a name a reader can act on", () => {
  const stored = Object.keys(defaults()).filter((key) => key !== "keys");
  // The defaults are the source of the expected set, so a setting added
  // without a name or a sentence fails here rather than reaching the screen.
  expect(stored.filter((key) => settingLabel(key) === key)).toEqual([]);
  expect(stored.filter((key) => settingHelp(key) === "")).toEqual([]);
  expect([...Object.keys(settingInfo)].sort()).toEqual([...stored].sort());
  expect(settingLabel("keys.quit")).toBe("Key: quit");
  expect(settingHelp("keys.quit")).toBe("");
});

test("a label fits its column, and the sentence it drops goes under the row", () => {
  // The label column the Settings list reserves. A longer label would run
  // into its own value, which is what the sentence is for.
  const column = 24;
  const tooLong = Object.entries(settingInfo).filter(
    ([, info]) => [...info.label].length > column,
  );
  expect(tooLong.map(([key]) => key)).toEqual([]);
  // The sentence is a sentence, not a repeat of the label.
  for (const [key, info] of Object.entries(settingInfo))
    expect({ key, ends: info.help.endsWith(".") }).toEqual({ key, ends: true });
});

test("a stored value reads in the unit the reader reads, not the unit it is stored in", () => {
  const c = defaults();
  const rows: [string, unknown, string][] = [
    ["memoryFloor", 1073741824, "1.0 GiB"],
    ["scratchQuota", 10737418240, "10.0 GiB"],
    ["refreshMs", 1000, "1s"],
    ["scratchRefreshMs", 30000, "30s"],
    ["pressureAmber", 10, "10%"],
    ["persistence", true, "On"],
    ["persistence", false, "Off"],
    ["historyHours", 24, "24h"],
    ["pressureHoldSeconds", 10, "10s"],
    ["sort", "cpu", "cpu"],
    ["laneNameParts", ["account", "tool", "pane"], "account, tool, pane"],
    [
      "columns",
      ["name", "account", "cwd", "branch", "tool"],
      "name, account, cwd, and 2 more",
    ],
    ["btrfsMounts", [], "none"],
  ];
  for (const [key, value, expected] of rows)
    expect({ key, shown: settingDisplay(key, value, c) }).toEqual({
      key,
      shown: expected,
    });
  // Every number a setting stores is written in some unit, and its value
  // carries that unit now the label no longer has room to.
  const numeric = Object.entries(defaults()).filter(
    ([key, value]) => key !== "keys" && typeof value === "number",
  );
  expect(
    numeric.filter(([key]) => settingInfo[key]?.unit === undefined),
  ).toEqual([]);
});

test("an interval under a second reads as itself, never as zero", () => {
  const c = defaults();
  // `age()` floors to whole seconds. Through it a 500 ms refresh read `0s`
  // and 1500 ms read `1s`, so a reader who set 500 was told the interval was
  // zero. `validate()` accepts refreshMs from 100 upward, so these are values
  // the settings screen has to show.
  expect(settingDisplay("refreshMs", 100, c)).toBe("100ms");
  expect(settingDisplay("refreshMs", 500, c)).toBe("500ms");
  expect(settingDisplay("refreshMs", 999, c)).toBe("999ms");
  expect(settingDisplay("refreshMs", 1500, c)).toBe("1.5s");
  expect(settingDisplay("refreshMs", 2250, c)).toBe("2.3s");
  // A whole number of seconds keeps the shorter reading it already had, and a
  // minute or more still reads in the unit every other span uses.
  expect(settingDisplay("refreshMs", 1000, c)).toBe("1s");
  expect(settingDisplay("scratchRefreshMs", 30000, c)).toBe("30s");
  expect(settingDisplay("scratchRefreshMs", 60000, c)).toBe("1m");
});

test("Settings states each capability and why a missing one is missing", () => {
  const caps = capabilitySnapshot();
  expect(caps.map(capabilityLine)).toEqual([
    "Resource groups (cgroup v2): available",
    "Resource control for this login session: available",
    "Pressure stall information: available",
    "Per-group disk counters: available",
    "Disk scrub reports: available",
    "Drive lifetime reports: available",
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
