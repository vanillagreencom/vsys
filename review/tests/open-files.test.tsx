// Cloud defect review 7, finding 3: the agent detail's Open files section. Run from the repository root:
//   bun test review/tests/open-files.test.tsx
// Each test asserts the behaviour the product promises and fails on main.
// Everything lives under a private temporary directory; no real process is
// read beyond the fixture's stand-in /proc tree.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "../../src/config/config";
import {
  emptySnapshot,
  groupSnapshot,
  laneSnapshot,
  processSnapshot,
} from "../../src/test/fixture";
import { mount } from "../../src/test/harness";

let scratch = "";
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "vsys-review7-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A stand-in /proc where process 40 holds one descriptor open on `target`,
 * and a sample whose one agent lane is led by process 40 with `env`.
 */
function setup(target: string, env: Record<string, string>) {
  const procRoot = join(scratch, "proc");
  mkdirSync(join(procRoot, "40", "fd"), { recursive: true });
  symlinkSync(target, join(procRoot, "40", "fd", "3"));
  const s = emptySnapshot();
  s.lanes = [laneSnapshot()];
  s.groups = [groupSnapshot()];
  s.procs = [processSnapshot({ env })];
  return { procRoot, s };
}

test("Open files lists a file the agent holds in the temporary directory it names", async () => {
  // agent-confine, the launcher the warden ships, gives each lane a TMPDIR of
  // its own under ~/.cache/agents/tmp. Storage measures that directory as an
  // agent scratch root (scratchRoots() in src/collect/scratch.ts), so the
  // agent detail must list what the agent holds open there.
  const agentTmp = join(scratch, "cache/agents/tmp/agent-confine-40");
  const held = join(agentTmp, "rustcXYZ/lib.rlib");
  const { procRoot, s } = setup(held, { TMPDIR: agentTmp });
  const c = {
    ...defaults(),
    procRoot,
    // The configured list does not name the agent's directory, as the
    // shipped list does not.
    scratchDirs: [join(scratch, "dev/.scratch/agents")],
  };
  const t = await mount(s, c, { width: 160, height: 60 });
  try {
    await t.press("2");
    await t.press("enter");
    // Processes, Launch, Terminal, Open files.
    for (let i = 0; i < 3; i++) await t.press("j");
    await t.press("enter");
    const frame = t.frame();
    expect(frame).toContain("▾ Open files");
    expect({
      listed: frame.includes(held),
      saysNone: frame.includes("No scratch file is open."),
    }).toEqual({ listed: true, saysNone: false });
  } finally {
    await t.close();
  }
});

test("control: the same fixture lists the file once the settings list names the directory", async () => {
  // Passes on main. It shows the stand-in /proc is read, so the failure above
  // is the missing agent root and not the fixture.
  const agentTmp = join(scratch, "cache/agents/tmp/agent-confine-40");
  const held = join(agentTmp, "rustcXYZ/lib.rlib");
  const { procRoot, s } = setup(held, { TMPDIR: agentTmp });
  const c = { ...defaults(), procRoot, scratchDirs: [agentTmp] };
  const t = await mount(s, c, { width: 160, height: 60 });
  try {
    await t.press("2");
    await t.press("enter");
    for (let i = 0; i < 3; i++) await t.press("j");
    await t.press("enter");
    expect(t.frame()).toContain(held);
  } finally {
    await t.close();
  }
});
