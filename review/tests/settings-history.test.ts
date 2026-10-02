// Proof tests for the settings and history findings in
// review/cloud-defect-review.md. Every test here FAILS on the reviewed commit;
// each failure is the defect.
// Run from the repository root:
//   PATH="$PWD/node_modules/.bin:$PATH" bun test review/tests/settings-history.test.ts
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults, loadConfig } from "../../src/config/config";
import { Session } from "../../src/runtime";
import { History } from "../../src/store/history";
import { emptySnapshot, fixture } from "../../src/test/fixture";

// A Settings save serializes the configuration vsys loaded at start and
// replaces config.toml with it, so a value the reader set by hand since then
// is reverted, and every comment in the file is dropped.
test("a Settings save keeps a hand edit and a comment made while vsys runs", async () => {
  const f = fixture();
  const path = join(f.root, "config.toml");
  const h = new History(f.config);
  let calls = 0;
  const session = new Session(
    f.config,
    () => path,
    { sample: async () => emptySnapshot(++calls * 1000) },
    h,
    { frame: () => {}, error: () => {} },
    { agentToolsPath: f.agentToolsPath },
  );
  try {
    writeFileSync(path, '# keep RSS first on this box\nsort = "rss"\n');
    // One unrelated toggle on the Settings screen.
    await session.configure({ ...f.config, descending: false });
    const body = readFileSync(path, "utf8");
    const after = await loadConfig(path, f.agentToolsPath);
    // Received {comment: false, sort: "cpu", descending: false}.
    expect({
      comment: body.includes("# keep RSS"),
      sort: after.sort,
      descending: after.descending,
    }).toEqual({ comment: true, sort: "rss", descending: false });
  } finally {
    session.stop();
    f.cleanup();
  }
});

// The collector stamps each sample with Date.now(). A clock stepped back by
// timesyncd or chrony makes History.add throw, and Session.tick turns any
// throw into stop() and main() exits with "vsys: Snapshot times must increase".
test("a sample stamped before the previous one does not throw", () => {
  const h = new History(defaults());
  try {
    h.add(emptySnapshot(1_000_000));
    expect(() => h.add(emptySnapshot(998_000))).not.toThrow();
  } finally {
    h.close();
  }
});
