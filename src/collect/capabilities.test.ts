import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Capability, CapabilityId } from "../model/types";
import { fixture } from "../test/fixture";
import { capabilityReason } from "../ui/settings";
import { probeCapabilities } from "./capabilities";
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
  const caps = probeCapabilities(f.config);
  expect(caps.map((cap) => cap.id)).toEqual([
    "cgroup2",
    "delegation",
    "psi",
    "io-stat",
    "scrub",
  ]);
  expect(caps.filter((cap) => !cap.available)).toEqual([]);
  expect(caps.every((cap) => cap.failure === null && cap.detail === "")).toBe(
    true,
  );
});

test("a missing interface names the source that decided it and the reason", () => {
  const f = setup();
  // No cgroup.controllers, no cgroup.subtree_control, no scrub directory.
  const bare = byId(probeCapabilities(f.config));
  expect(bare.get("cgroup2")?.available).toBe(false);
  expect(bare.get("cgroup2")?.failure).toBe("absent");
  expect(bare.get("cgroup2")?.source).toBe(
    join(f.config.cgroupRoot, "cgroup.controllers"),
  );
  expect(bare.get("cgroup2")?.detail).toContain("ENOENT");
  expect(bare.get("scrub")?.source).toBe(f.config.scrubDir);
  expect(bare.get("scrub")?.available).toBe(false);
  // The fixture writes PSI and io.stat, so those two remain available.
  expect(bare.get("psi")?.available).toBe(true);
  expect(bare.get("io-stat")?.available).toBe(true);
  // A hierarchy that enables neither controller names both, not the file error.
  writeFileSync(join(f.config.cgroupRoot, "cgroup.subtree_control"), "pids\n");
  // A hierarchy that answered is incomplete, never absent or malformed.
  expect(byId(probeCapabilities(f.config)).get("delegation")).toMatchObject({
    available: false,
    failure: "incomplete",
    detail: "cpu memory",
  });
  writeFileSync(
    join(f.config.cgroupRoot, "cgroup.subtree_control"),
    "cpu memory pids\n",
  );
  expect(byId(probeCapabilities(f.config)).get("delegation")?.available).toBe(
    true,
  );
});

test("a kernel without PSI and without io.stat reports both absences", () => {
  const f = setup();
  rmSync(join(f.config.procRoot, "pressure"), { recursive: true });
  rmSync(join(f.config.cgroupRoot, "io.stat"));
  const caps = byId(probeCapabilities(f.config));
  expect(caps.get("psi")).toMatchObject({
    available: false,
    failure: "absent",
  });
  expect(caps.get("psi")?.source).toBe(join(f.config.procRoot, "pressure/cpu"));
  expect(caps.get("io-stat")).toMatchObject({
    available: false,
    failure: "absent",
  });
});

test("a present pressure file that fails is not reported as a missing kernel", () => {
  const f = setup();
  const path = join(f.config.procRoot, "pressure/cpu");
  // The file exists and was read; only its contents are wrong.
  writeFileSync(path, "some avg10=0.00\n");
  const malformed = byId(probeCapabilities(f.config)).get("psi");
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
  const unreadable = byId(probeCapabilities(f.config)).get("psi");
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
  expect(byId(probeCapabilities(f.config)).get("cgroup2")?.available).toBe(
    true,
  );
});
