import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import { xdgHome } from "../config/xdg";
import type {
  Capability,
  CapabilityFailure,
  CapabilityId,
  Group,
} from "../model/types";
import { pressure } from "./io";
import { kernelLogProbeArgv, probeKernelLog } from "./kernel-log";
import type { CollectionConfig } from "./settings";
import { listPanesArgv } from "./tmux";

/** Controllers a lane's CPU and memory numbers need delegated to this session. */
const delegated = ["cpu", "memory"];
/** The D-Bus service that answers in the `smart` capability's place when udisks2 supplies a drive's lifetime writes with no report directory to read. */
export const udisksCapabilitySource = "org.freedesktop.UDisks2";
/** A failure may name the source that decided it when a probe reads two. */
type Failure = {
  failure: CapabilityFailure;
  detail: string;
  source?: string;
  /** io-stat's ancestry walk alone; see `Capability.belowSlice`. */
  belowSlice?: boolean;
};
export type Outcome = Failure | null;

/**
 * The system decides the diagnosis, never the reader. An errno for a source
 * that does not exist is an absent interface; any other errno is a source this
 * user cannot read; a throw with no errno came from parsing what was read.
 */
export function classify(error: unknown): Failure {
  const code = (error as NodeJS.ErrnoException).code;
  const detail = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ENODEV")
    return { failure: "absent", detail };
  return { failure: code ? "unreadable" : "malformed", detail };
}

/**
 * Which of these controllers the session root does not hand down to the groups
 * below it. A group has a controller's files only when its parent lists the
 * controller in `cgroup.subtree_control`, so the root's own file says nothing
 * about the groups the readings come from.
 */
function undelegated(c: CollectionConfig, names: string[]): Outcome {
  const source = join(c.cgroupRoot, "cgroup.subtree_control");
  let enabled: string[];
  try {
    enabled = readFileSync(source, "utf8").split(/\s+/);
  } catch (error) {
    return { ...classify(error), source };
  }
  const absent = names.filter((name) => !enabled.includes(name));
  // The interface answered; it just does not carry these controllers.
  return absent.length
    ? { failure: "incomplete", detail: absent.join(" "), source }
    : null;
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
 * These reads decide each capability once, when vsys starts, so a permanently
 * absent kernel interface is reported as an absence with its reason rather
 * than as a per-sample source failure on every tick. Most capabilities take
 * one read; io-stat also reads the root's `cgroup.subtree_control`, because
 * its readings come from the groups below the root. That answer is the floor:
 * a slice between the root and the agent scopes can still withhold io from
 * them while the root hands it down, so `probeIoStat` below refines this
 * capability with each sample's groups.
 */
export function probeCapabilities(
  c: CollectionConfig,
  /** Injected so no test spawns tmux, and so a stub can fail it on purpose. */
  tmux: () => Outcome = probeTmux,
  /** Injected for the same reason: no test reads this machine's journal. */
  kernelLog: () => Outcome = probeKernelLog,
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
      () => undelegated(c, delegated),
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
        // The writer readings come from the groups below the root.
        return undelegated(c, ["io"]);
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
    ["kernel-log", kernelLogProbeArgv.join(" "), kernelLog],
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
    source: outcome?.source ?? source,
    detail: outcome?.detail ?? detail,
    belowSlice: outcome?.belowSlice,
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
  const config = xdgHome("XDG_CONFIG_HOME", env);
  const data = xdgHome("XDG_DATA_HOME", env);
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
/**
 * Whether the groups the agent lanes' readings come from have io.stat. The
 * root's own delegation is probed once, by `probeCapabilities`, because the
 * root's `cgroup.subtree_control` does not come and go; this refines that
 * answer with each sample's groups, because the agent slice's ancestry can
 * appear after vsys starts, just as the slice itself can. Where the root
 * already withholds io, its diagnosis stands: nothing below it can do better.
 * Where the root hands it down, each of the agent slice's own ancestors, from
 * directly below the root to the slice itself, decides again for its own
 * children, so the first one that does not re-delegate io is why the agent
 * scopes under it have no io.stat. This walk covers only the agent slice's
 * own ancestry, not every group in the tree, so a desktop slice with no
 * agents never counts against it.
 *
 * The ancestry is read from each matching slice's own path, directory by
 * directory from the cgroup root down, never by following `parent` links
 * through the sample's `groups`: a group `collectGroups` could not read
 * (a failed `cpu.stat` or `cgroup.procs`) is still a real, readable directory
 * on disk, and a `parent` walk through `groups` would lose it and stop short
 * of the slice, wrongly reading the gap as a clean ancestry. `sliceInstancePaths`
 * below names every real instance of the agent slice this sample's groups
 * reveal, including one nested inside another and one `collectGroups` itself
 * could not read, so a reading that checked only one instance never misses a
 * second one withholding io.
 *
 * Each failure also records `belowSlice`: whether the failing ancestor sits at
 * or below the agent slice's own occurrence in the instance path being walked,
 * true from the depth that path first names the slice onward. A slice's own
 * `cgroup.subtree_control` gates only what it hands to its children, never its
 * own `io.stat`, so `writeTotals`'s slice total survives exactly when this
 * holds, whatever the failing component is named: a plain directory between
 * two instances of a slice nested inside itself sits below the outer one just
 * as the slice's own last step does, even though neither names the slice. The
 * failing component's bare name cannot carry this: it can equal the
 * configured slice's name at a depth that is not that occurrence's own, once
 * the name recurs under nesting, and it never names an ancestor that is not
 * itself a slice instance at all.
 */
export function probeIoStat(
  c: CollectionConfig,
  groups: Group[],
  root: Capability,
): Capability {
  if (!root.available) return root;
  const slices = sliceInstancePaths(groups, c.agentSlice);
  for (const slicePath of slices) {
    const parts = slicePath.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const ancestorPath = parts.slice(0, depth).join("/");
      const source = join(c.cgroupRoot, ancestorPath, "cgroup.subtree_control");
      let enabled: string[];
      try {
        enabled = readFileSync(source, "utf8").split(/\s+/);
      } catch (error) {
        return record("io-stat", source, classify(error));
      }
      if (!enabled.includes("io")) {
        const part = parts[depth - 1];
        if (part === undefined) continue;
        return record("io-stat", source, {
          failure: "incomplete",
          detail: part,
          belowSlice: parts.slice(0, depth).includes(c.agentSlice),
        });
      }
    }
  }
  return root;
}
/**
 * The path of every group, among this sample's groups, whose final or
 * interior component names the configured agent slice, each path ending at
 * that component and deduplicated. Scanning every group's own path rather
 * than matching `g.name === name` on a group record for the slice itself
 * finds two cases a name-only match on the slice's own group would miss: a
 * second instance nested inside another match, which `sliceRoots` in
 * `../model/verdict.ts` deliberately drops for its own callers (summing
 * resource totals, where a nested instance's counters are already carried by
 * the outer one and would double-count), but which is here a second real
 * directory with its own `cgroup.subtree_control` to check; and a slice
 * `collectGroups` could not itself read (a failed `cpu.stat` or
 * `cgroup.procs`) but a collected descendant's path still reveals, because
 * `collectGroups` walks every child directory on disk whether or not its
 * parent was readable.
 */
export function sliceInstancePaths(groups: Group[], name: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    const parts = g.path.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== name) continue;
      const path = parts.slice(0, i + 1).join("/");
      if (!seen.has(path)) {
        seen.add(path);
        found.push(path);
      }
    }
  }
  return found;
}
