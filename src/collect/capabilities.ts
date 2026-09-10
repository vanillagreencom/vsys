import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  Capability,
  CapabilityFailure,
  CapabilityId,
} from "../model/types";
import { pressure } from "./io";
import type { CollectionConfig } from "./settings";
import { listPanesArgv } from "./tmux";

/** Controllers a lane's CPU and memory numbers need delegated to this session. */
const delegated = ["cpu", "memory"];
export type Outcome = { failure: CapabilityFailure; detail: string } | null;

/**
 * The system decides the diagnosis, never the reader. An errno for a source
 * that does not exist is an absent interface; any other errno is a source this
 * user cannot read; a throw with no errno came from parsing what was read.
 */
function classify(error: unknown): Outcome {
  const code = (error as NodeJS.ErrnoException).code;
  const detail = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ENODEV")
    return { failure: "absent", detail };
  return { failure: code ? "unreadable" : "malformed", detail };
}

/**
 * Whether a tmux server answers. Two separate absences: no tmux on the path at
 * all, and a tmux that is installed with nothing running for it to read. The
 * second is not a broken installation, so it is reported as an interface that
 * answered without giving what the reading needs.
 */
export function probeTmux(): Outcome {
  let result: { exitCode: number; stderr: Uint8Array };
  try {
    result = Bun.spawnSync(listPanesArgv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return { failure: "absent", detail: String(error) };
  }
  if (result.exitCode === 0) return null;
  const detail = new TextDecoder().decode(result.stderr).trim();
  // Bun reports a missing program through the exit status rather than a throw
  // on every platform, so the server's own words decide which absence it is.
  return /not found|ENOENT|No such file/i.test(detail)
    ? { failure: "absent", detail }
    : { failure: "incomplete", detail: detail || "no server running" };
}

/**
 * One read decides each capability. These reads happen once, when vsys starts,
 * so a permanently absent kernel interface is reported as an absence with its
 * reason rather than as a per-sample source failure on every tick.
 */
export function probeCapabilities(
  c: CollectionConfig,
  /** Injected so no test spawns tmux, and so a stub can fail it on purpose. */
  tmux: () => Outcome = probeTmux,
): Capability[] {
  const probes: [CapabilityId, string, () => Outcome][] = [
    [
      "cgroup2",
      join(c.cgroupRoot, "cgroup.controllers"),
      () => {
        readFileSync(join(c.cgroupRoot, "cgroup.controllers"), "utf8");
        return null;
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
        // The interface answered; it just does not carry these controllers.
        return absent.length
          ? { failure: "incomplete", detail: absent.join(" ") }
          : null;
      },
    ],
    [
      "psi",
      join(c.procRoot, "pressure/cpu"),
      () => {
        pressure(readFileSync(join(c.procRoot, "pressure/cpu"), "utf8"));
        return null;
      },
    ],
    [
      "io-stat",
      join(c.cgroupRoot, "io.stat"),
      () => {
        readFileSync(join(c.cgroupRoot, "io.stat"), "utf8");
        return null;
      },
    ],
    [
      "scrub",
      c.scrubDir,
      () => {
        readdirSync(c.scrubDir);
        return null;
      },
    ],
    [
      "smart",
      c.smartDir,
      () => {
        readdirSync(c.smartDir);
        return null;
      },
    ],
    ["tmux", listPanesArgv.join(" "), tmux],
  ];
  return probes.map(([id, source, run]) => {
    let outcome: Outcome;
    try {
      outcome = run();
    } catch (error) {
      outcome = classify(error);
    }
    return {
      id,
      available: outcome === null,
      failure: outcome?.failure ?? null,
      source,
      detail: outcome?.detail ?? "",
    };
  });
}
