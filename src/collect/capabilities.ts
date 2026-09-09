import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/config";
import type { Capability, CapabilityId } from "../model/types";
import { pressure } from "./io";

/** Controllers a lane's CPU and memory numbers need delegated to this session. */
const delegated = ["cpu", "memory"];

function why(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One read decides each capability. These reads happen once, when vsys starts,
 * so a permanently absent kernel interface is reported as an absence with its
 * reason rather than as a per-sample source failure on every tick.
 */
export function probeCapabilities(c: Config): Capability[] {
  const probes: [CapabilityId, string, () => string][] = [
    [
      "cgroup2",
      join(c.cgroupRoot, "cgroup.controllers"),
      () => {
        readFileSync(join(c.cgroupRoot, "cgroup.controllers"), "utf8");
        return "";
      },
    ],
    [
      "delegation",
      join(c.cgroupRoot, "cgroup.subtree_control"),
      () => {
        const enabled = readFileSync(
          join(c.cgroupRoot, "cgroup.subtree_control"),
          "utf8",
        ).split(/\s+/);
        const absent = delegated.filter((name) => !enabled.includes(name));
        return absent.length
          ? `controllers not enabled: ${absent.join(" ")}`
          : "";
      },
    ],
    [
      "psi",
      join(c.procRoot, "pressure/cpu"),
      () => {
        pressure(readFileSync(join(c.procRoot, "pressure/cpu"), "utf8"));
        return "";
      },
    ],
    [
      "io-stat",
      join(c.cgroupRoot, "io.stat"),
      () => {
        readFileSync(join(c.cgroupRoot, "io.stat"), "utf8");
        return "";
      },
    ],
    [
      "scrub",
      c.scrubDir,
      () => {
        readdirSync(c.scrubDir);
        return "";
      },
    ],
  ];
  return probes.map(([id, source, run]) => {
    let detail: string;
    try {
      detail = run();
    } catch (error) {
      detail = why(error);
    }
    return { id, available: detail === "", source, detail };
  });
}
