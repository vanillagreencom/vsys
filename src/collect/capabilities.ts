import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  Capability,
  CapabilityFailure,
  CapabilityId,
  Group,
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
export function probeTmux(argv: string[] = listPanesArgv): Outcome {
  let result: { exitCode: number; stderr: Uint8Array };
  try {
    result = Bun.spawnSync(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    // Nothing ran: Bun throws when the program is not on the path. That is the
    // whole of what `absent` means, and it is a fact about the spawn rather
    // than a reading of anything the program said.
    return { failure: "absent", detail: String(error) };
  }
  if (result.exitCode === 0) return null;
  // tmux ran and refused, which is never an absence however it is worded. A
  // server that is not up says `error connecting to /tmp/tmux-1000/default
  // (No such file or directory)`, and matching that against a pattern for a
  // missing program told a reader who has tmux installed to go and install it.
  return {
    failure: "incomplete",
    detail:
      new TextDecoder().decode(result.stderr).trim() || "no server running",
  };
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
    return record(id, source, outcome);
  });
}
function record(
  id: CapabilityId,
  source: string,
  outcome: Outcome,
  detail = "",
): Capability {
  return {
    id,
    available: outcome === null,
    failure: outcome?.failure ?? null,
    source,
    detail: outcome?.detail ?? detail,
  };
}
/** Null when the path exists, otherwise what stat met, diagnosed as above. */
function exists(path: string): Outcome {
  try {
    statSync(path);
    return null;
  } catch (error) {
    return classify(error);
  }
}
/**
 * The directories the systemd user manager reads unit files and drop-ins
 * from, in the order it reads them, so the first that holds a unit file is the
 * one systemd uses. The agent slice is the user manager's, which loads nothing
 * from the system manager's directories. `user.control` is where
 * `systemctl --user set-property` writes, which is the line Settings offers for
 * a missing slice.
 */
export function unitDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const config = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const data = env.XDG_DATA_HOME || join(homedir(), ".local/share");
  return [
    join(config, "systemd/user.control"),
    join(config, "systemd/user"),
    "/etc/systemd/user",
    join(data, "systemd/user"),
    "/usr/lib/systemd/user",
  ];
}
/**
 * Where systemd puts a slice below the manager's own group: each dash in the
 * name nests it one level, so `agents-work.slice` lives in `agents.slice`.
 */
export function slicePath(name: string): string {
  const parts = name.replace(/\.slice$/, "").split("-");
  return parts
    .map((_, i) => `${parts.slice(0, i + 1).join("-")}.slice`)
    .join("/");
}
/**
 * Whether the machine has the agent slice, read every sample rather than once:
 * systemd creates a slice's group only while the slice runs, and a slice with
 * no install section runs from the first unit placed in it, which on a machine
 * whose agents start after vsys is after vsys does.
 *
 * A group of that name anywhere in the tree this sample read is the slice, as
 * it is to the slice totals. Otherwise the path systemd gives the name decides,
 * and where that path does not exist a unit file or drop-in directory defining
 * the slice still makes it present (D009). The first directory holding a unit
 * file decides, as it does for systemd, and a unit file there that resolves to
 * /dev/null is masked: systemd never starts it, and it cannot be given a
 * limit until it is unmasked. Only a slice with no group, no unit and no
 * drop-in is absent, and a path that exists but cannot be told is never read
 * as an absence.
 */
export function probeAgentSlice(
  c: CollectionConfig,
  groups: Group[],
  /** Where unit files are looked for. None given, no unit file is read. */
  units: string[] = [],
): Capability {
  const found = groups.find((g) => g.name === c.agentSlice);
  if (found) return record("agent-slice", join(c.cgroupRoot, found.path), null);
  const cgroup = join(c.cgroupRoot, slicePath(c.agentSlice));
  const atCgroup = exists(cgroup);
  if (atCgroup?.failure !== "absent")
    return record("agent-slice", cgroup, atCgroup);
  // REVISIT(D009): a unit generated at runtime, or one systemd loads from a
  // directory outside this list, is not seen here.
  const definedDetail =
    "defined; its group appears when the first unit starts in it";
  const file = units
    .map((dir) => join(dir, c.agentSlice))
    .map((path) => ({ path, outcome: exists(path) }))
    .find((at) => at.outcome?.failure !== "absent");
  if (file) {
    // A unit file vsys cannot tell apart from a mask leaves the slice unknown.
    if (file.outcome !== null)
      return record("agent-slice", file.path, file.outcome);
    let target: string;
    try {
      target = realpathSync(file.path);
    } catch (error) {
      return record("agent-slice", file.path, classify(error));
    }
    return target === "/dev/null"
      ? record("agent-slice", file.path, {
          failure: "masked",
          detail: "the unit file links to /dev/null",
        })
      : record("agent-slice", file.path, null, definedDetail);
  }
  // With no unit file, a drop-in defines the slice, and drop-ins cannot mask.
  const dropIns = units
    .map((dir) => join(dir, `${c.agentSlice}.d`))
    .map((path) => ({ path, outcome: exists(path) }));
  const defined = dropIns.find((at) => at.outcome === null);
  if (defined) return record("agent-slice", defined.path, null, definedDetail);
  // A drop-in found anywhere answers, whatever another directory failed to say.
  const unknown = dropIns.find(
    (at) => at.outcome !== null && at.outcome.failure !== "absent",
  );
  if (unknown) return record("agent-slice", unknown.path, unknown.outcome);
  return record("agent-slice", cgroup, {
    failure: "absent",
    detail: units.length
      ? `${atCgroup.detail}; no unit file or drop-in in ${units.join(", ")}`
      : atCgroup.detail,
  });
}
