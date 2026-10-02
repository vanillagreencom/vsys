import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Capability, CapabilityId } from "../model/types";
import { fixture, groupSnapshot } from "../test/fixture";
import { capabilityOffer, capabilityReason } from "../ui/settings";
import {
  probeAgentSlice,
  probeCapabilities,
  probeTmux,
  unitDirs,
} from "./capabilities";
import { Collector } from "./collector";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
const setup = () => {
  const f = fixture();
  fixtures.push(f);
  return f;
};
const byId = (caps: Capability[]) =>
  new Map(caps.map((cap) => [cap.id, cap] as [CapabilityId, Capability]));
/** A tmux server that answers, so no test in this file spawns a real one. */
const answering = () => null;

test("a delegated cgroup v2 session probes every capability available", () => {
  const f = setup();
  writeFileSync(
    join(f.config.cgroupRoot, "cgroup.controllers"),
    "cpu io memory pids\n",
  );
  writeFileSync(
    join(f.config.cgroupRoot, "cgroup.subtree_control"),
    "cpu io memory pids\n",
  );
  mkdirSync(f.config.scrubDir, { recursive: true });
  mkdirSync(f.config.smartDir, { recursive: true });
  const caps = probeCapabilities(f.config, answering, answering);
  expect(caps.map((cap) => cap.id)).toEqual([
    "cgroup2",
    "delegation",
    "psi",
    "io-stat",
    "scrub",
    "kernel-log",
    "smart",
    "tmux",
  ]);
  expect(caps.filter((cap) => !cap.available)).toEqual([]);
  expect(caps.every((cap) => cap.failure === null && cap.detail === "")).toBe(
    true,
  );
});

test("a missing interface names the source that decided it and the reason", () => {
  const f = setup();
  // No cgroup.controllers, no cgroup.subtree_control, no scrub directory.
  const bare = byId(probeCapabilities(f.config, answering, answering));
  expect(bare.get("cgroup2")?.available).toBe(false);
  expect(bare.get("cgroup2")?.failure).toBe("absent");
  expect(bare.get("cgroup2")?.source).toBe(
    join(f.config.cgroupRoot, "cgroup.controllers"),
  );
  expect(bare.get("cgroup2")?.detail).toContain("ENOENT");
  expect(bare.get("scrub")?.source).toBe(f.config.scrubDir);
  expect(bare.get("scrub")?.available).toBe(false);
  // The privileged timer writes drive reports; an absent directory is its own
  // diagnosis and never the scrub one, because the two carry different data.
  expect(bare.get("smart")).toMatchObject({
    available: false,
    failure: "absent",
    source: f.config.smartDir,
  });
  expect(capabilityReason(bare.get("smart") as Capability)).toBe(
    "no readable drive report directory",
  );
  mkdirSync(f.config.smartDir, { recursive: true });
  expect(
    byId(probeCapabilities(f.config, answering, answering)).get("smart")
      ?.available,
  ).toBe(true);
  // The fixture writes PSI, so that remains available.
  expect(bare.get("psi")?.available).toBe(true);
  // A hierarchy that enables neither controller names both, not the file error.
  writeFileSync(join(f.config.cgroupRoot, "cgroup.subtree_control"), "pids\n");
  // A hierarchy that answered is incomplete, never absent or malformed.
  expect(
    byId(probeCapabilities(f.config, answering, answering)).get("delegation"),
  ).toMatchObject({
    available: false,
    failure: "incomplete",
    detail: "cpu memory",
  });
  writeFileSync(
    join(f.config.cgroupRoot, "cgroup.subtree_control"),
    "cpu memory pids\n",
  );
  expect(
    byId(probeCapabilities(f.config, answering, answering)).get("delegation")
      ?.available,
  ).toBe(true);
});

test("io.stat at the root is not available until the root hands io down", () => {
  const f = setup();
  const control = join(f.config.cgroupRoot, "cgroup.subtree_control");
  // The fixture writes io.stat at the root, which the probe reads first.
  const rows: [string, string | null, Partial<Capability>][] = [
    // With no subtree_control the groups below carry no io.stat either.
    ["no subtree_control", null, { failure: "absent", source: control }],
    [
      "io not delegated",
      "cpu memory pids\n",
      { failure: "incomplete", source: control, detail: "io" },
    ],
    ["io delegated", "cpu io memory pids\n", { failure: null }],
  ];
  for (const [name, text, expected] of rows) {
    if (text === null) rmSync(control, { force: true });
    else writeFileSync(control, text);
    const cap = byId(probeCapabilities(f.config, answering)).get("io-stat");
    expect({ name, ...cap }).toMatchObject({
      name,
      available: expected.failure === null,
      ...expected,
    });
  }
});

test("a kernel without PSI and without io.stat reports both absences", () => {
  const f = setup();
  rmSync(join(f.config.procRoot, "pressure"), { recursive: true });
  rmSync(join(f.config.cgroupRoot, "io.stat"));
  const caps = byId(probeCapabilities(f.config, answering, answering));
  expect(caps.get("psi")).toMatchObject({
    available: false,
    failure: "absent",
  });
  expect(caps.get("psi")?.source).toBe(join(f.config.procRoot, "pressure/cpu"));
  expect(caps.get("io-stat")).toMatchObject({
    available: false,
    failure: "absent",
    source: join(f.config.cgroupRoot, "io.stat"),
  });
});

test("a present pressure file that fails is not reported as a missing kernel", () => {
  const f = setup();
  const path = join(f.config.procRoot, "pressure/cpu");
  // The file exists and was read; only its contents are wrong.
  writeFileSync(path, "some avg10=0.00\n");
  const malformed = byId(probeCapabilities(f.config, answering, answering)).get(
    "psi",
  );
  expect(malformed).toMatchObject({
    available: false,
    failure: "malformed",
    detail: "Missing pressure fields",
  });
  expect(capabilityReason(malformed as Capability)).toBe(
    `${path} is not in the expected format`,
  );
  expect(capabilityReason(malformed as Capability)).not.toContain(
    "no PSI on this kernel",
  );
  // A source that exists but cannot be read is its own diagnosis. A directory
  // in the file's place fails with an errno whatever user runs the test.
  rmSync(path);
  mkdirSync(path);
  const unreadable = byId(
    probeCapabilities(f.config, answering, answering),
  ).get("psi");
  expect(unreadable?.failure).toBe("unreadable");
  expect(capabilityReason(unreadable as Capability)).toBe(
    `${path} exists but cannot be read`,
  );
});

test("every sample carries the capabilities probed when vsys started", async () => {
  const f = setup();
  const collector = new Collector(f.config, 100, 4096);
  const first = await collector.sample(1000);
  expect(byId(first.capabilities).get("cgroup2")?.available).toBe(false);
  // Probing once means a later file cannot change a running dashboard's report.
  writeFileSync(
    join(f.config.cgroupRoot, "cgroup.controllers"),
    "cpu io memory pids\n",
  );
  const second = await collector.sample(2000);
  expect(second.capabilities).toEqual(first.capabilities);
  expect(
    byId(probeCapabilities(f.config, answering, answering)).get("cgroup2")
      ?.available,
  ).toBe(true);
});

test("tmux absent and tmux without a server are separate diagnoses", () => {
  const f = setup();
  // No tmux on the path at all: nothing to run, so the interface is absent.
  const absent = byId(
    probeCapabilities(
      f.config,
      () => ({
        failure: "absent" as const,
        detail: "tmux: command not found",
      }),
      answering,
    ),
  ).get("tmux");
  expect(absent).toMatchObject({ available: false, failure: "absent" });
  expect(capabilityReason(absent as Capability)).toBe("no tmux on the path");
  // Installed, but nothing running for it to read. That is not a broken
  // installation, and it must not read as one.
  const idle = byId(
    probeCapabilities(
      f.config,
      () => ({
        failure: "incomplete" as const,
        detail: "no server running on /tmp/tmux-1000/default",
      }),
      answering,
    ),
  ).get("tmux");
  expect(idle).toMatchObject({ available: false, failure: "incomplete" });
  expect(capabilityReason(idle as Capability)).toBe(
    "tmux is installed but no server is answering",
  );
  // The other capabilities are decided by their own reads, not by this one.
  const caps = byId(probeCapabilities(f.config, answering, answering));
  expect(caps.get("tmux")?.available).toBe(true);
  expect(caps.get("psi")?.available).toBe(true);
});

test("a tmux with no server running is not a missing tmux", () => {
  // The words tmux prints when its socket is not there. They read as a missing
  // file because they are about one, and matching them against a pattern for a
  // missing program told a reader with tmux installed to install it.
  const refused = probeTmux([
    "sh",
    "-c",
    "echo 'error connecting to /tmp/tmux-1000/default (No such file or directory)' >&2; exit 1",
  ]);
  expect(refused?.failure).toBe("incomplete");
  expect(refused?.detail).toContain("error connecting");
  // A program that is not there at all never runs, and that is the only
  // absence: it is a fact about the spawn rather than a reading of any words.
  const missing = probeTmux(["vsys-has-no-such-program", "-V"]);
  expect(missing?.failure).toBe("absent");
  // And a server that answers is no failure of either kind.
  expect(probeTmux(["sh", "-c", "exit 0"])).toBeNull();
});

test("the agent slice is present, defined, absent, or unknown", () => {
  const nested = "cgroup/user.slice/agents.slice";
  const gone = (root: string) =>
    rmSync(join(root, "cgroup/agents.slice"), { recursive: true });
  // A link to itself fails with an errno whatever user runs the test, so a
  // path that exists and cannot be told is planted the same way everywhere.
  const loop = (path: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(path, path);
  };
  const rows: {
    name: string;
    slice: string;
    prepare: (root: string) => void;
    groups: ReturnType<typeof groupSnapshot>[];
    failure: Capability["failure"];
    source: string;
  }[] = [
    {
      name: "the fixture's own slice",
      slice: "agents.slice",
      prepare: () => {},
      groups: [],
      failure: null,
      source: "cgroup/agents.slice",
    },
    {
      name: "no group and no unit",
      slice: "agents.slice",
      prepare: gone,
      groups: [],
      failure: "absent",
      source: "cgroup/agents.slice",
    },
    {
      // systemd nests a dashed slice inside the slice its name prefixes.
      name: "a dashed name",
      slice: "agents-work.slice",
      prepare: () => {},
      groups: [],
      failure: "absent",
      source: "cgroup/agents.slice/agents-work.slice",
    },
    {
      // The totals find a slice by name anywhere in the tree, so does this.
      name: "a slice the walk read below another group",
      slice: "agents.slice",
      prepare: gone,
      groups: [
        groupSnapshot({
          path: "user.slice/agents.slice",
          name: "agents.slice",
        }),
      ],
      failure: null,
      source: nested,
    },
    {
      name: "a group path that cannot be read",
      slice: "agents.slice",
      prepare: (root) => {
        gone(root);
        loop(join(root, "cgroup/agents.slice"));
      },
      groups: [],
      failure: "unreadable",
      source: "cgroup/agents.slice",
    },
    {
      // systemd starts a slice with no install section only when a unit is
      // placed in it, so a defined slice has no group until then (D009).
      name: "a unit file and no group yet",
      slice: "agents.slice",
      prepare: (root) => {
        gone(root);
        mkdirSync(join(root, "user"), { recursive: true });
        writeFileSync(join(root, "user/agents.slice"), "[Slice]\n");
      },
      groups: [],
      failure: null,
      source: "user/agents.slice",
    },
    {
      name: "a drop-in directory and no group yet",
      slice: "agents.slice",
      prepare: (root) => {
        gone(root);
        mkdirSync(join(root, "control/agents.slice.d"), { recursive: true });
      },
      groups: [],
      failure: null,
      source: "control/agents.slice.d",
    },
    {
      name: "a unit path that cannot be read",
      slice: "agents.slice",
      prepare: (root) => {
        gone(root);
        loop(join(root, "control/agents.slice"));
      },
      groups: [],
      failure: "unreadable",
      source: "control/agents.slice",
    },
    {
      // A drop-in cannot mask, so one directory whose drop-in cannot be read
      // does not outweigh another whose drop-in answers.
      name: "a drop-in beside a drop-in path that cannot be read",
      slice: "agents.slice",
      prepare: (root) => {
        gone(root);
        loop(join(root, "user/agents.slice.d"));
        mkdirSync(join(root, "control/agents.slice.d"), { recursive: true });
      },
      groups: [],
      failure: null,
      source: "control/agents.slice.d",
    },
    {
      // `systemctl --user mask` links the unit file to /dev/null in a
      // directory systemd reads first, which shadows the unit file a later
      // directory holds; systemd never starts a masked slice.
      name: "a masked unit file before a defined one",
      slice: "agents.slice",
      prepare: (root) => {
        gone(root);
        mkdirSync(join(root, "user"), { recursive: true });
        symlinkSync("/dev/null", join(root, "user/agents.slice"));
        mkdirSync(join(root, "control/agents.slice.d"), { recursive: true });
        writeFileSync(join(root, "control/agents.slice"), "[Slice]\n");
      },
      groups: [],
      failure: "masked",
      source: "user/agents.slice",
    },
  ];
  for (const row of rows) {
    const f = setup();
    row.prepare(f.root);
    // The second directory is never created: a missing one is no answer.
    const units = [
      join(f.root, "user"),
      join(f.root, "missing"),
      join(f.root, "control"),
    ];
    const c = { ...f.config, agentSlice: row.slice };
    const cap = probeAgentSlice(c, row.groups, units);
    expect({
      row: row.name,
      id: cap.id,
      available: cap.available,
      failure: cap.failure,
      source: cap.source,
      // Only a slice with neither a group nor a unit is offered one.
      offered: capabilityOffer(cap, c) !== null,
    }).toEqual({
      row: row.name,
      id: "agent-slice",
      available: row.failure === null,
      failure: row.failure,
      source: join(f.root, row.source),
      offered: row.failure === "absent",
    });
  }
});

test("a slice that appears after vsys starts is present from the next sample", async () => {
  const f = setup();
  rmSync(join(f.config.cgroupRoot, "agents.slice"), { recursive: true });
  const collector = new Collector(f.config, 100, 4096);
  const before = byId((await collector.sample(1000)).capabilities);
  expect(before.get("agent-slice")?.failure).toBe("absent");
  // systemd starts the slice when the first unit is placed in it.
  f.group("agents.slice");
  const after = byId((await collector.sample(2000)).capabilities);
  expect(after.get("agent-slice")?.available).toBe(true);
});

test("unit files are looked for where the user manager loads them, in its order", () => {
  // In the order the user manager reads them, so the first holding a unit file
  // is the one systemd uses. The system manager's own directories are not
  // read: the agent slice belongs to the user manager, which never loads them.
  const ordered = (config: string, data: string) => [
    // Where the line Settings offers for a missing slice writes.
    join(config, "systemd/user.control"),
    join(config, "systemd/user"),
    "/etc/systemd/user",
    join(data, "systemd/user"),
    "/usr/lib/systemd/user",
  ];
  const rows: [string, NodeJS.ProcessEnv, string[]][] = [
    [
      "XDG directories set",
      { XDG_CONFIG_HOME: "/x/config", XDG_DATA_HOME: "/x/data" },
      ordered("/x/config", "/x/data"),
    ],
    [
      "XDG directories unset",
      {},
      ordered(join(homedir(), ".config"), join(homedir(), ".local/share")),
    ],
    [
      "XDG directories relative",
      { XDG_CONFIG_HOME: "x/config", XDG_DATA_HOME: "x/data" },
      ordered(join(homedir(), ".config"), join(homedir(), ".local/share")),
    ],
  ];
  for (const [name, env, dirs] of rows)
    expect({ name, dirs: unitDirs(env) }).toEqual({ name, dirs });
});
