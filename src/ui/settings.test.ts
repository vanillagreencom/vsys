import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { defaults } from "../config/config";
import type { Capability, CapabilityId } from "../model/types";
import { capabilitySnapshot } from "../test/fixture";
import {
  capabilityLine,
  capabilityLoss,
  capabilityOffer,
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
  // Inside a section already titled Keys, a `Key:` prefix on every row is
  // noise; the action's own name is what tells the rows apart.
  const bindings: [string, string][] = [
    ["quit", "Quit"],
    ["home", "Home"],
    ["exportJson", "Export json"],
    ["exportMarkdown", "Export markdown"],
    ["previous", "Previous"],
    // A key that jumps to a region names the screen and the region it reaches.
    ["tiles", "Home: Tiles"],
    ["attention", "Home: Needs attention"],
    ["changes", "Home: Recent changes"],
    ["busiest", "Home: Busiest agents"],
    ["filesystems", "Storage: Filesystems"],
    ["scrub", "Storage: Scrub reports"],
    ["scratch", "Storage: Scratch"],
  ];
  for (const [action, label] of bindings)
    expect({ action, label: settingLabel(`keys.${action}`) }).toEqual({
      action,
      label,
    });
  for (const action of Object.keys(defaults().keys))
    expect(settingLabel(`keys.${action}`)).not.toContain("Key:");
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
    "Agent slice: available",
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
  // A readable io.stat at the root is not one in the groups below it, and the
  // reason names the group that withholds io.
  for (const [detail, reason] of [
    [
      ".",
      "this login session does not pass the io controller to the groups in it",
    ],
    [
      "app.slice/app-graphical.slice",
      "app.slice/app-graphical.slice does not pass the io controller to the groups in it",
    ],
  ])
    expect(
      capabilityReason({
        id: "io-stat",
        available: false,
        failure: "incomplete",
        source: `/sys/fs/cgroup/${detail}/cgroup.subtree_control`,
        detail,
      }),
    ).toBe(reason);
});

test("every missing capability says what it costs the reader, in its own words", () => {
  // Every capability id, with a phrase its own cost line carries.
  const costs: Record<CapabilityId, string> = {
    cgroup2: "no resource group is read",
    delegation: "memory limits, or CPU weights, are blank",
    psi: "every wait reading is blank",
    "io-stat": "per-group disk writes are blank",
    scrub: "Storage lists no scrub report",
    smart: "Storage shows no drive lifetime writes",
    tmux: "a tmux pane id resolves to no address",
    "agent-slice": "agents are shown, but not compared against a shared limit",
  };
  const cap = (id: CapabilityId, available: boolean): Capability => ({
    id,
    available,
    failure: available ? null : "absent",
    source: `/fixture/${id}`,
    detail: "",
  });
  const said = new Set<string>();
  for (const [id, phrase] of Object.entries(costs) as [
    CapabilityId,
    string,
  ][]) {
    const loss = capabilityLoss(cap(id, false));
    expect({ id, says: loss.includes(phrase) }).toEqual({ id, says: true });
    // And each says something of its own: one string reused across sources
    // would tell a reader the same thing whatever they were missing.
    expect({ id, seen: said.has(loss) }).toEqual({ id, seen: false });
    said.add(loss);
    // A source that answered costs nothing, so the row carries no sentence.
    expect({ id, whole: capabilityLoss(cap(id, true)) }).toEqual({
      id,
      whole: "",
    });
  }
});

test("a missing agent slice offers one line that limits it, and nothing else does", () => {
  const c = defaults();
  const slice = (failure: Capability["failure"]): Capability => ({
    id: "agent-slice",
    available: failure === null,
    failure,
    source: "/fixture/agents.slice",
    detail: "",
  });
  // MemoryHigh and MemoryMax are the warden template's own values, read from
  // it here rather than restated; the line carries no other limit.
  const template = readFileSync(
    new URL("../../warden/systemd/agents.slice", import.meta.url),
    "utf8",
  );
  const limits = ["MemoryHigh", "MemoryMax"].map(
    (key) => template.match(new RegExp(`^${key}=\\S+$`, "m"))?.[0],
  );
  expect(limits.every((line) => line !== undefined)).toBe(true);
  expect(capabilityOffer(slice("absent"), c)?.command).toBe(
    ["systemctl --user set-property agents.slice", ...limits].join(" "),
  );
  // A slice that exists, or one vsys could not read, needs no creating.
  expect(capabilityOffer(slice(null), c)).toBeNull();
  expect(capabilityOffer(slice("unreadable"), c)).toBeNull();
  expect(capabilityOffer({ ...slice("absent"), id: "psi" }, c)).toBeNull();
  // A slice that cannot be read is still compared against, so its loss says
  // so rather than claiming agents go unchecked.
  expect(capabilityLoss(slice("unreadable"))).not.toBe(
    capabilityLoss(slice("absent")),
  );
  // systemctl refuses set-property on a masked unit, so a masked slice is
  // offered nothing, says it is masked, and costs what an absent one does.
  expect({
    offer: capabilityOffer(slice("masked"), c),
    reason: capabilityReason(slice("masked")),
    loss: capabilityLoss(slice("masked")),
  }).toEqual({
    offer: null,
    reason: "/fixture/agents.slice is masked, so systemd never starts it",
    loss: capabilityLoss(slice("absent")),
  });
});
